/**
 * Where a new session is created, and what the browser is allowed to send there.
 *
 * A spawn on this installation keeps its existing freedom: any path the local
 * server can resolve under the user's home, and any provider ChatMux can boot.
 * A spawn on a peer is narrower on purpose:
 *
 *  - the path is interpreted by the *peer's* home directory, so a controller
 *    path must never be sent. Anything absolute, `~`-anchored or traversing is
 *    rejected here, before the request leaves the browser;
 *  - the negotiated `session.spawn` operation boots the peer's live agent, so a
 *    provider the peer cannot spawn is not offered at all rather than sent and
 *    refused;
 *  - a dispatched spawn whose answer never arrived is `unknown`. It is never
 *    retried: the peer's own roster is the only thing that can say whether the
 *    session exists.
 */

import type { HostRequestFailure } from '../../../../../fleet/hostApi/requests';
import type { SpawnHostChoice } from '../../../../../fleet/hostAvailability';

/** Providers a peer's negotiated spawn operation can boot. */
export const PEER_SPAWN_PROVIDERS = ['gjc'] as const;

export type SpawnOutcome =
  | { readonly kind: 'created'; readonly cwd: string }
  | {
    readonly kind: 'rejected';
    readonly reason: 'tower-unavailable' | 'name-conflict' | 'failed';
    /** Server-supplied explanation, when the answer carried one. */
    readonly detail: string | null;
  }
  | { readonly kind: 'unknown' };

/**
 * A peer-home-relative working directory, or null when the value would leak a
 * controller path or escape the peer's home.
 */
export function peerRelativeCwd(value: string): string | null {
  const candidate = value.trim().replace(/\/+$/, '');
  if (candidate.length === 0 || candidate.length > 512) {
    return null;
  }
  if (candidate.startsWith('/') || candidate.startsWith('~') || candidate.includes('\0')) {
    return null;
  }
  return candidate.split('/').includes('..') ? null : candidate;
}

export function isRemoteSpawnHost(host: SpawnHostChoice): boolean {
  return !host.isLocal;
}

/** Whether the form has everything the selected host needs before dispatch. */
export function canDispatchSpawn(input: {
  readonly host: SpawnHostChoice;
  readonly name: string;
  readonly cwd: string;
  readonly projectLocalId: string | null;
}): boolean {
  if (input.name.trim().length === 0) {
    return false;
  }
  if (!isRemoteSpawnHost(input.host)) {
    return input.cwd.trim().length > 0;
  }
  return input.projectLocalId !== null && peerRelativeCwd(input.cwd) !== null;
}

function rejection(code: string): SpawnOutcome {
  switch (code) {
    case 'HOST_COMMAND_OUTCOME_UNKNOWN':
      return { kind: 'unknown' };
    case 'HOST_OFFLINE':
    case 'HOST_SYNCING':
      return { kind: 'rejected', reason: 'tower-unavailable', detail: null };
    default:
      return { kind: 'rejected', reason: 'failed', detail: null };
  }
}

/**
 * Classifies a host-qualified spawn answer. `outcome: 'unknown'` wins over the
 * error code: the request was dispatched, so the session may exist even though
 * the browser was told nothing.
 */
export function classifyRemoteSpawn(
  result: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: HostRequestFailure },
  cwd: string,
): SpawnOutcome {
  if (!result.ok) {
    return result.failure.outcome === 'unknown' ? { kind: 'unknown' } : rejection(result.failure.code);
  }
  const body = typeof result.value === 'object' && result.value !== null
    ? result.value as { readonly ok?: unknown; readonly reachable?: unknown; readonly conflict?: unknown }
    : null;
  if (body?.ok === true) {
    return { kind: 'created', cwd };
  }
  if (body?.conflict === true) {
    return { kind: 'rejected', reason: 'name-conflict', detail: null };
  }
  return { kind: 'rejected', reason: body?.reachable === false ? 'tower-unavailable' : 'failed', detail: null };
}
