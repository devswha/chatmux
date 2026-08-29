import { FLEET_ERROR_CODES, type FleetErrorCode } from '../../../shared/fleet';
import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../shared/tmux';
import { authenticatedFetch } from '../../utils/api';

export type RemotePaneTarget = Readonly<{
  readonly hostId?: string;
  readonly localId?: string;
  readonly lane?: 'external' | 'live';
  readonly tmux: TmuxPaneIdentity;
  readonly process: TmuxProcessGeneration | null;
}>;

export type RemotePaneAction =
  | 'send'
  | 'interrupt'
  | 'escape'
  | 'terminate-process'
  | 'terminate-pane'
  | 'terminate-session';

export type RemoteActionFailure = Readonly<{
  readonly ok: false;
  readonly code: FleetErrorCode | 'UNKNOWN';
  readonly message: string;
}>;
export type RemoteActionResult = Readonly<{ readonly ok: true }> | RemoteActionFailure;

function actionUrl(target: RemotePaneTarget): string | null {
  return target.hostId && target.localId
    ? `/api/hosts/${encodeURIComponent(target.hostId)}/providers/panes/${encodeURIComponent(target.localId)}/actions`
    : null;
}

function errorBody(value: unknown): Readonly<{ readonly code?: unknown; readonly message?: unknown }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const error = Object.entries(value).find(([key]) => key === 'error')?.[1];
  return error !== null && typeof error === 'object' && !Array.isArray(error)
    ? Object.fromEntries(Object.entries(error))
    : {};
}

async function actionResult(response: Response): Promise<RemoteActionResult> {
  if (response.ok) return { ok: true };
  const body: unknown = await response.json().catch(() => null);
  const error = errorBody(body);
  const code = typeof error.code === 'string'
    ? FLEET_ERROR_CODES.find((candidate) => candidate === error.code)
    : undefined;
  return {
    ok: false,
    code: code ?? 'UNKNOWN',
    message: typeof error.message === 'string' ? error.message : 'Remote action failed.',
  };
}

export async function requestRemotePaneAction(
  target: RemotePaneTarget,
  action: RemotePaneAction,
  message?: string,
): Promise<RemoteActionResult> {
  const url = actionUrl(target);
  if (url === null || target.lane === undefined || target.process === null) {
    return { ok: false, code: 'FLEET_STALE_GENERATION', message: 'Remote pane generation is stale.' };
  }
  const response = await authenticatedFetch(url, {
    method: 'POST',
    body: JSON.stringify({
      lane: target.lane,
      tmux: target.tmux,
      process: target.process,
      action,
      ...(action === 'send' ? { message: message ?? '' } : {}),
    }),
  });
  return actionResult(response);
}

export async function requestRemotePromptResponse(
  hostId: string,
  sessionId: string,
  responseBody: Readonly<Record<string, unknown>>,
): Promise<RemoteActionResult> {
  const response = await authenticatedFetch(
    `/api/hosts/${encodeURIComponent(hostId)}/providers/sessions/${encodeURIComponent(sessionId)}/prompt/respond`,
    { method: 'POST', body: JSON.stringify(responseBody) },
  );
  return actionResult(response);
}

export async function requestRemoteApprovalResponse(
  hostId: string,
  sessionId: string,
  decision: 'approve-once' | 'approve-remember' | 'reject' | 'cancel',
): Promise<RemoteActionResult> {
  const response = await authenticatedFetch(
    `/api/hosts/${encodeURIComponent(hostId)}/providers/sessions/${encodeURIComponent(sessionId)}/approval/respond`,
    { method: 'POST', body: JSON.stringify({ decision }) },
  );
  return actionResult(response);
}
