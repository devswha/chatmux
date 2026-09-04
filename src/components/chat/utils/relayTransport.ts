import type { TmuxPaneTarget } from '../../../../shared/tmux';
import { hostQualifiedKey } from '../../../fleet/references';
import {
  requestRemotePaneAction,
  requestRemotePromptResponse,
  type RemoteActionResult,
} from '../../../fleet/terminal/remoteActions';
import { api } from '../../../utils/api';

import type { RelayAnswerRoute } from './relayAnswer';

export type RelayTransportTarget = TmuxPaneTarget & Readonly<{
  readonly hostId?: string;
  readonly localId?: string;
  readonly lane?: 'external' | 'live';
}>;
export type RelayTransportInput = Readonly<{
  readonly relayKind: string;
  readonly target: RelayTransportTarget;
  readonly transcriptSessionId: string | null;
  readonly promptId: string;
  readonly askToolId: string;
}>;

/** Drafts and pending callbacks belong to the full host/pane/process identity. */
export function relayTargetKey(kind: string, target: RelayTransportTarget): string {
  return hostQualifiedKey('relay-target', [kind, target.hostId ?? '', target.localId ?? '', target.lane ?? '',
    target.tmux.socketPath, target.tmux.sessionId, target.tmux.windowId, target.tmux.paneId,
    String(target.process.pid), String(target.process.startedAtMs)]);
}

function remoteResponse(result: RemoteActionResult): Response {
  return result.ok
    ? new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
    : new Response(JSON.stringify({ error: { code: result.code, message: result.message } }), { status: 409 });
}

export async function dispatchRelay(
  input: RelayTransportInput,
  route: RelayAnswerRoute,
  message: string,
): Promise<Response> {
  const { relayKind, target, transcriptSessionId, promptId, askToolId } = input;
  if (target.hostId) {
    switch (route.kind) {
      case 'interactive-custom':
        if (transcriptSessionId === null) break;
        return remoteResponse(await requestRemotePromptResponse(target.hostId, transcriptSessionId, {
          response: 'custom', promptId, message,
        }));
      case 'interactive-choices':
        if (transcriptSessionId === null) break;
        return remoteResponse(await requestRemotePromptResponse(target.hostId, transcriptSessionId, {
          response: 'choices', promptId, choices: route.choices,
        }));
      case 'ask-custom':
        if (transcriptSessionId === null) break;
        return remoteResponse(await requestRemotePromptResponse(target.hostId, transcriptSessionId, {
          response: 'custom', promptId: askToolId, message,
        }));
      case 'ask-choice':
        if (transcriptSessionId === null) break;
        return remoteResponse(await requestRemotePromptResponse(target.hostId, transcriptSessionId, {
          response: 'choices', promptId: askToolId, choices: [route.choiceIndex],
        }));
      case 'text':
      case 'invalid':
        return remoteResponse(await requestRemotePaneAction(target, 'send', message));
    }
    return new Response(JSON.stringify({ error: { code: 'FLEET_STALE_GENERATION', message: 'Remote transcript identity is unavailable.' } }), { status: 409 });
  }

  const gjc = relayKind === 'gjc';
  switch (route.kind) {
    case 'interactive-custom':
      return gjc
        ? api.liveSessionInteractiveCustom(target.tmux, target.process, promptId, message)
        : api.externalCliSessionInteractiveCustom(target.tmux, target.process, promptId, message);
    case 'interactive-choices':
      return gjc
        ? api.liveSessionInteractiveRespond(target.tmux, target.process, promptId, route.choices)
        : api.externalCliSessionInteractiveRespond(target.tmux, target.process, promptId, route.choices);
    case 'ask-custom':
      return gjc
        ? api.liveSessionAskCustom(target.tmux, target.process, transcriptSessionId, askToolId, message)
        : api.externalCliSessionAskCustom(target.tmux, target.process, transcriptSessionId, askToolId, message);
    case 'ask-choice':
      return gjc
        ? api.liveSessionAskSelect(target.tmux, target.process, transcriptSessionId, askToolId, route.choiceIndex)
        : api.externalCliSessionAskSelect(target.tmux, target.process, transcriptSessionId, askToolId, route.choiceIndex);
    case 'text':
    case 'invalid':
      return gjc
        ? api.liveSessionSend(target.tmux, target.process, message)
        : api.externalCliSessionSend(target.tmux, target.process, message);
  }
}

export async function interruptRelay(input: Pick<RelayTransportInput, 'relayKind' | 'target'>): Promise<Response> {
  if (input.target.hostId) {
    return remoteResponse(await requestRemotePaneAction(input.target, 'interrupt'));
  }
  return input.relayKind === 'gjc'
    ? api.liveSessionAction(input.target.tmux, input.target.process, 'interrupt')
    : api.externalCliSessionAction(input.target.tmux, input.target.process, 'interrupt');
}
