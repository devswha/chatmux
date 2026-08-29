import { randomUUID } from 'node:crypto';

import type { RawData, WebSocket } from 'ws';

import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

import type { FleetSessionReference, JsonValue } from '../../../../shared/fleet.js';

import { fleetApplicationRouting, type FleetApplicationRouting } from './application-routing.js';
import { FleetHostRoutingError } from './host-router.js';

const DEADLINE_MS = 30_000;
type ChatFrame = Readonly<Record<string, unknown>>;
type ChatPrincipal = Readonly<{ readonly id: string; readonly owner: boolean }>;
type HostChatInput = Readonly<{
  readonly ws: WebSocket;
  readonly frame: ChatFrame;
  readonly principal: ChatPrincipal;
  readonly beginSubscription?: (hostId: string, sessionId: string, lastSeq: number) => void;
  readonly emitSubscription?: (hostId: string, sessionId: string, event: JsonValue) => void;
  readonly activateSubscription?: (hostId: string, sessionId: string) => void;
}>;
export type HostChatRoutingResult =
  | Readonly<{ readonly kind: 'delegate_local' }>
  | Readonly<{ readonly kind: 'handled_remote' }>;

function send(ws: WebSocket, value: JsonValue): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value));
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 100_000) {
    throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', `${name} is invalid.`);
  }
  return value;
}
function target(frame: ChatFrame, hostId: string): FleetSessionReference {
  return { kind: 'session', hostId, localId: text(frame.sessionId, 'sessionId') };
}
function choices(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', 'choices are invalid.');
  }
  const parsed = value.filter((entry): entry is number => typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= 32);
  if (parsed.length !== value.length) throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', 'choices are invalid.');
  return parsed;
}
function nonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: JsonValue): Readonly<Record<string, JsonValue>> | null {
  return isJsonRecord(value) ? value : null;
}
function approvalDecision(value: unknown): 'approve-once' | 'approve-remember' | 'reject' | 'cancel' {
  if (value === 'approve-once' || value === 'approve-remember' || value === 'reject' || value === 'cancel') return value;
  throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', 'approval decision is invalid.');
}

export async function routeHostQualifiedChat(
  input: HostChatInput,
  resolve: () => FleetApplicationRouting | undefined = () => fleetApplicationRouting.current(),
): Promise<HostChatRoutingResult> {
  const hostId = typeof input.frame.hostId === 'string' ? input.frame.hostId : undefined;
  if (hostId === undefined) return { kind: 'delegate_local' };
  const active = resolve();
  if (active === undefined) throw new FleetHostRoutingError('HOST_OFFLINE', 'Fleet routing is unavailable.');
  const selected = active.router.resolve({ hostId, principal: input.principal });
  if (selected.kind === 'local') return { kind: 'delegate_local' };
  const session = target(input.frame, hostId);
  const deadlineAtMs = Date.now() + DEADLINE_MS;
  const requestId = `browser-${randomUUID()}`;
  const type = typeof input.frame.type === 'string' ? input.frame.type : '';
  switch (type) {
    case 'chat.send':
      active.router.admit(selected, 'chat.send');
      await selected.clients.mutations.sendChat(session, { requestId, deadlineAtMs, message: text(input.frame.content, 'content') });
      send(input.ws, { kind: 'chat_accepted', hostId, sessionId: session.localId });
      return { kind: 'handled_remote' };
    case 'chat.abort':
      active.router.admit(selected, 'chat.abort');
      await selected.clients.mutations.abortChat(session, { requestId, deadlineAtMs });
      send(input.ws, { kind: 'chat_aborted', hostId, sessionId: session.localId });
      return { kind: 'handled_remote' };
    case 'chat.subscribe': {
      active.router.admit(selected, 'session.read');
      const lastSeq = nonnegativeInteger(input.frame.lastSeq);
      input.beginSubscription?.(hostId, session.localId, lastSeq);
      const snapshot = record(await selected.clients.reads.chatSubscription(session, deadlineAtMs, lastSeq));
      const currentSeq = nonnegativeInteger(snapshot?.lastSeq);
      send(input.ws, {
        kind: 'chat_subscribed', hostId, sessionId: session.localId,
        isProcessing: snapshot?.isProcessing === true, lastSeq: currentSeq,
        pendingPermissions: [],
      });
      if (Array.isArray(snapshot?.events)) {
        for (const event of snapshot.events) input.emitSubscription?.(hostId, session.localId, event);
      }
      input.activateSubscription?.(hostId, session.localId);
      return { kind: 'handled_remote' };
    }
    case 'chat.permission-response': {
      active.router.admit(selected, 'approval.respond');
      const decision = input.frame.allow === true ? 'approve-once' : input.frame.allow === false ? 'reject' : approvalDecision(input.frame.decision);
      await selected.clients.mutations.respondApproval(session, { requestId, deadlineAtMs, decision });
      send(input.ws, { kind: 'chat_permission_resolved', hostId, sessionId: session.localId });
      return { kind: 'handled_remote' };
    }
    case 'chat.prompt-response': {
      active.router.admit(selected, 'prompt.respond');
      const promptId = text(input.frame.promptId, 'promptId');
      if (input.frame.response === 'choices') {
        await selected.clients.mutations.respondPrompt(session, { requestId, deadlineAtMs, response: 'choices', promptId, choices: choices(input.frame.choices) });
      } else if (input.frame.response === 'custom') {
        await selected.clients.mutations.respondPrompt(session, { requestId, deadlineAtMs, response: 'custom', promptId, message: text(input.frame.message, 'message') });
      } else {
        throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', 'prompt response is invalid.');
      }
      send(input.ws, { kind: 'chat_prompt_resolved', hostId, sessionId: session.localId });
      return { kind: 'handled_remote' };
    }
    case 'chat.approval-response':
      active.router.admit(selected, 'approval.respond');
      await selected.clients.mutations.respondApproval(session, { requestId, deadlineAtMs, decision: approvalDecision(input.frame.decision) });
      send(input.ws, { kind: 'chat_approval_resolved', hostId, sessionId: session.localId });
      return { kind: 'handled_remote' };
    default:
      throw new FleetHostRoutingError('FLEET_UNKNOWN_OPERATION', 'Remote chat operation is unsupported.');
  }
}

export function createHostQualifiedChatConnectionHandler(
  resolve: () => FleetApplicationRouting | undefined,
): (ws: WebSocket, request: AuthenticatedWebSocketRequest, delegateLocal: (raw: RawData) => void) => void {
  return (ws, request, delegateLocal): void => {
    const id = request.user?.id ?? request.user?.userId ?? request.user?.username;
    const role = request.user?.tailscaleRole;
    const principal = { id: id === undefined ? '' : String(id), owner: role === undefined || role === 'owner' || role === 'local' };
    const subscriptions = new Map<string, { lastSeq: number; ready: boolean; queued: JsonValue[] }>();
    const key = (hostId: string, sessionId: string): string => `${hostId.length}:${hostId}${sessionId}`;
    const emit = (hostId: string, sessionId: string, event: JsonValue): void => {
      const subscription = subscriptions.get(key(hostId, sessionId));
      const payload = record(event);
      const seq = nonnegativeInteger(payload?.seq);
      if (subscription === undefined || payload?.sessionId !== sessionId || seq <= subscription.lastSeq) return;
      if (!subscription.ready) { subscription.queued.push(event); return; }
      subscription.lastSeq = seq;
      send(ws, event);
    };
    const active = resolve();
    const releaseFrames = active?.subscribeFrames((hostId, frame) => {
      if (frame.kind === 'event' && frame.event === 'chat.delta') emit(hostId, String(record(frame.body)?.sessionId ?? ''), frame.body);
    });
    ws.once('close', () => releaseFrames?.());
    let deciding = false;
    const receive = (raw: RawData): void => {
      if (deciding) return;
      deciding = true;
      const frame = parseIncomingJsonObject(raw);
      if (frame === null) { ws.close(); return; }
      void routeHostQualifiedChat({
        ws, frame, principal,
        beginSubscription: (hostId, sessionId, lastSeq) => {
          subscriptions.set(key(hostId, sessionId), { lastSeq, ready: false, queued: [] });
        },
        emitSubscription: emit,
        activateSubscription: (hostId, sessionId) => {
          const subscription = subscriptions.get(key(hostId, sessionId));
          if (subscription === undefined) return;
          subscription.ready = true;
          const queued = subscription.queued.sort((left, right) =>
            nonnegativeInteger(record(left)?.seq) - nonnegativeInteger(record(right)?.seq));
          subscription.queued = [];
          for (const event of queued) emit(hostId, sessionId, event);
        },
      }, resolve).then((result) => {
        if (result.kind === 'handled_remote') { deciding = false; return; }
        ws.off('message', receive);
        delegateLocal(raw);
      }).catch((error: unknown) => {
        const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
        const message = error instanceof Error ? error.message : 'Fleet chat routing failed.';
        send(ws, { kind: 'protocol_error', code, error: message, sessionId: null });
        deciding = false;
      });
    };
    ws.on('message', receive);
  };
}

export const handleHostQualifiedChatConnection = createHostQualifiedChatConnectionHandler(
  () => fleetApplicationRouting.current(),
);
