import { randomUUID } from 'node:crypto';

import express, { type Request } from 'express';

import { createApiSuccessResponse } from '@/shared/utils.js';

import {
  FLEET_ERROR_CODES,
  parseFleetReference,
  type FleetOperation,
  type FleetPaneReference,
} from '../../../../shared/fleet.js';
import type { ApprovalDecision } from '../rpc/mutations/contracts.js';

import type { FleetApplicationClients } from './application-routing.js';
import { FleetHostRoutingError, type FleetHostRoute } from './host-router.js';
import type { RoutingResolver } from './host-qualified.routes.js';

const REQUEST_DEADLINE_MS = 10_000;
type BrowserPaneAction = 'send' | 'interrupt' | 'escape' | 'terminate-process' | 'terminate-pane' | 'terminate-session';

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\0')) {
    throw new FleetHostRoutingError('FLEET_IDENTIFIER_INVALID', `${name} is invalid.`);
  }
  return value;
}
function body(request: Request): Readonly<Record<string, unknown>> {
  if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', 'Request body is invalid.');
  }
  return Object.fromEntries(Object.entries(request.body));
}
function principal(request: Request): Readonly<{ readonly id: string; readonly owner: boolean }> {
  const user = 'user' in request ? request.user : undefined;
  if (user === null || typeof user !== 'object') return { id: '', owner: false };
  const fields = Object.entries(user);
  const value = (name: string): unknown => fields.find(([key]) => key === name)?.[1];
  const id = value('id') ?? value('userId') ?? value('username');
  const role = value('tailscaleRole');
  return { id: typeof id === 'string' || typeof id === 'number' ? String(id) : '', owner: role === undefined || role === 'owner' || role === 'local' };
}
function selected(request: Request, resolve: RoutingResolver, operation: FleetOperation): Extract<FleetHostRoute<FleetApplicationClients>, { readonly kind: 'remote' }> {
  const active = resolve();
  if (active === undefined) throw new FleetHostRoutingError('HOST_OFFLINE', 'Fleet routing is unavailable.');
  const route = active.router.route({ hostId: text(request.params.hostId, 'hostId'), operation, principal: principal(request) });
  if (route.kind === 'local') throw new FleetHostRoutingError('HOST_NOT_FOUND', 'Remote action requires a peer target.');
  return route;
}
function failure(error: unknown): unknown {
  if (error instanceof FleetHostRoutingError || error === null || typeof error !== 'object' || !('code' in error)) return error;
  const code: unknown = error.code;
  const matched = typeof code === 'string' ? FLEET_ERROR_CODES.find((candidate) => candidate === code) : undefined;
  return matched === undefined
    ? error
    : new FleetHostRoutingError(matched, error instanceof Error ? error.message : 'Fleet request failed.');
}
function action(value: unknown): BrowserPaneAction {
  if (value === 'send' || value === 'interrupt' || value === 'escape' || value === 'terminate-process' || value === 'terminate-pane' || value === 'terminate-session') return value;
  throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', 'Pane action is invalid.');
}
function decision(value: unknown): ApprovalDecision {
  if (value === 'approve-once' || value === 'approve-remember' || value === 'reject' || value === 'cancel') return value;
  throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', 'Approval decision is invalid.');
}
function choices(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((choice) => !Number.isInteger(choice))) {
    throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', 'Prompt choices are invalid.');
  }
  return value.filter((choice): choice is number => typeof choice === 'number');
}
function pane(request: Request): FleetPaneReference {
  const input = body(request);
  const target = parseFleetReference({ kind: 'pane', hostId: text(request.params.hostId, 'hostId'), localId: text(request.params.localId, 'localId'), lane: input.lane, tmux: input.tmux, process: input.process });
  if (target.kind !== 'pane') throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', 'Pane target is invalid.');
  return target;
}
function deadline(): number { return Date.now() + REQUEST_DEADLINE_MS; }
function meta(): Readonly<{ readonly requestId: string; readonly deadlineAtMs: number }> {
  return { requestId: `browser-${randomUUID()}`, deadlineAtMs: deadline() };
}

export function createHostQualifiedActionRoutes(resolve: RoutingResolver) {
  const router = express.Router();
  router.post('/hosts/:hostId/providers/panes/:localId/actions', async (request, response, next) => {
    try {
      const input = body(request); const paneAction = action(input.action); const target = pane(request);
      const operation = paneAction === 'send' ? 'pane.input' : paneAction === 'interrupt' ? 'pane.interrupt' : paneAction === 'escape' ? 'pane.escape' : paneAction === 'terminate-process' ? 'process.terminate' : paneAction === 'terminate-pane' ? 'pane.terminate' : 'session.terminate';
      const peer = selected(request, resolve, operation); const mutation = peer.clients.mutations; const requestMeta = meta();
      const result = paneAction === 'send' ? await mutation.sendPane(target, { ...requestMeta, message: text(input.message, 'message') }) : paneAction === 'interrupt' ? await mutation.interrupt(target, requestMeta) : paneAction === 'escape' ? await mutation.escape(target, requestMeta) : paneAction === 'terminate-process' ? await mutation.terminateProcess(target, requestMeta) : paneAction === 'terminate-pane' ? await mutation.terminatePane(target, requestMeta) : await mutation.terminateSession(target, requestMeta);
      response.json(createApiSuccessResponse(result));
    } catch (error) { next(failure(error)); }
  });
  router.post('/hosts/:hostId/providers/sessions/:sessionId/prompt/respond', async (request, response, next) => {
    try {
      const input = body(request); const peer = selected(request, resolve, 'prompt.respond'); const requestMeta = meta(); const sessionId = text(request.params.sessionId, 'sessionId');
      if (input.response !== 'choices' && input.response !== 'custom') throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', 'Prompt response is invalid.');
      const result = input.response === 'choices'
        ? await peer.clients.mutations.respondPrompt({ kind: 'session', hostId: peer.hostId, localId: sessionId }, { ...requestMeta, response: input.response, promptId: text(input.promptId, 'promptId'), choices: choices(input.choices) })
        : await peer.clients.mutations.respondPrompt({ kind: 'session', hostId: peer.hostId, localId: sessionId }, { ...requestMeta, response: input.response, promptId: text(input.promptId, 'promptId'), message: text(input.message, 'message') });
      response.json(createApiSuccessResponse(result));
    } catch (error) { next(failure(error)); }
  });
  router.post('/hosts/:hostId/providers/sessions/:sessionId/approval/respond', async (request, response, next) => {
    try {
      const input = body(request); const peer = selected(request, resolve, 'approval.respond'); const sessionId = text(request.params.sessionId, 'sessionId');
      const result = await peer.clients.mutations.respondApproval({ kind: 'session', hostId: peer.hostId, localId: sessionId }, { ...meta(), decision: decision(input.decision) });
      response.json(createApiSuccessResponse(result));
    } catch (error) { next(failure(error)); }
  });
  return router;
}
