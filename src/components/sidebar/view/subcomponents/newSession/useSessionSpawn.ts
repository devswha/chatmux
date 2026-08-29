/**
 * Dispatches one new-session request to the selected host.
 *
 * Two branches, one contract. The local branch is the existing spawn path,
 * untouched: GJC boots through the control tower, every other provider boots its
 * native CLI in tmux. The remote branch addresses the owning peer's own project
 * through the host-qualified spawn route, sending a peer-home-relative path and
 * nothing this machine knows about its own filesystem.
 *
 * A dispatched remote spawn whose answer never arrived ends in `unknown`, never
 * in an error and never in a retry: the peer may already be running the session.
 * The caller must reconcile against the peer's roster before dispatching again.
 */

import { useCallback, useState } from 'react';

import { requestHostJson } from '../../../../../fleet/hostApi/requests';
import { hostSpawnUrl } from '../../../../../fleet/hostApi/urls';
import type { SpawnHostChoice } from '../../../../../fleet/hostAvailability';
import { api } from '../../../../../utils/api';

import { classifyRemoteSpawn, isRemoteSpawnHost, peerRelativeCwd, type SpawnOutcome } from './spawnTarget';

export type SpawnRejection = 'tower-unavailable' | 'name-conflict' | 'failed';

export type SpawnStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'spawning' }
  | { readonly kind: 'rejected'; readonly reason: SpawnRejection; readonly detail: string | null }
  /** Dispatched, outcome unresolved. Acknowledge after checking the host roster. */
  | { readonly kind: 'unknown' };

export type SpawnRequest = {
  readonly host: SpawnHostChoice;
  readonly localHostId: string | null;
  readonly projectLocalId: string | null;
  readonly provider: string;
  readonly name: string;
  readonly cwd: string;
};

const IDLE: SpawnStatus = { kind: 'idle' };

function body(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function detailOf(payload: Readonly<Record<string, unknown>> | null): string | null {
  const error = body(payload?.error);
  const candidates = [error?.message, payload?.error, payload?.message];
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0) ?? null;
}

async function localSpawn(request: SpawnRequest): Promise<SpawnOutcome> {
  const response = request.provider === 'gjc'
    ? await api.liveSessionSpawn(request.name, request.cwd)
    : await api.externalCliSessionSpawn(request.provider, request.name, request.cwd);
  const payload = body(await response.json().catch(() => null));
  const data = body(payload?.data) ?? payload;
  if (response.ok && data?.ok === true) {
    return { kind: 'created', cwd: request.cwd };
  }
  if (data?.reachable === false) {
    return { kind: 'rejected', reason: 'tower-unavailable', detail: null };
  }
  if (data?.conflict === true) {
    return { kind: 'rejected', reason: 'name-conflict', detail: null };
  }
  return { kind: 'rejected', reason: 'failed', detail: detailOf(payload) };
}

async function remoteSpawn(request: SpawnRequest): Promise<SpawnOutcome> {
  const cwd = peerRelativeCwd(request.cwd);
  const url = request.projectLocalId === null
    ? null
    : hostSpawnUrl({ hostId: request.host.hostId, localHostId: request.localHostId }, request.projectLocalId);
  if (cwd === null || url === null) {
    return { kind: 'rejected', reason: 'failed', detail: null };
  }
  return classifyRemoteSpawn(
    await requestHostJson(url, { method: 'POST', body: JSON.stringify({ name: request.name, cwd }) }),
    cwd,
  );
}

export function useSessionSpawn(onCreated: (cwd: string) => void) {
  const [status, setStatus] = useState<SpawnStatus>(IDLE);

  const spawn = useCallback(async (request: SpawnRequest): Promise<void> => {
    setStatus({ kind: 'spawning' });
    let outcome: SpawnOutcome;
    try {
      outcome = isRemoteSpawnHost(request.host)
        ? await remoteSpawn(request)
        : await localSpawn(request);
    } catch {
      // A local dispatch that threw never reached the server; a remote one is
      // already translated into `unknown` by the host request boundary.
      outcome = { kind: 'rejected', reason: 'failed', detail: null };
    }
    switch (outcome.kind) {
      case 'created':
        setStatus(IDLE);
        onCreated(outcome.cwd);
        return;
      case 'rejected':
        setStatus({ kind: 'rejected', reason: outcome.reason, detail: outcome.detail });
        return;
      case 'unknown':
        setStatus({ kind: 'unknown' });
        return;
    }
  }, [onCreated]);

  const acknowledge = useCallback(() => setStatus(IDLE), []);

  return { status, spawn, acknowledge };
}
