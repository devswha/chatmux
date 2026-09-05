import { randomBytes } from 'node:crypto';

import type { TmuxPaneIdentity } from '../../../../shared/tmux.js';

import { assertLocalTmuxSocket, copyLocalTmuxSocketEvidence, rememberLocalTmuxSocket, sameLocalTmuxSocket, type LocalTmuxSocketInspector } from './local-tmux-discovery.service.js';
import { runTmux } from './builtin-relay.service.js';

const ATTACH_CAPABILITY_TTL_MS = 60_000;
const MAX_ATTACH_CAPABILITIES = 1_024;

type PaneGenerationReader = (tmux: TmuxPaneIdentity) => Promise<string | null>;

type AttachCapabilityRecord = Readonly<{
  principal: string;
  tmux: Readonly<TmuxPaneIdentity>;
  generation: string;
  expiresAtMs: number;
}>;

/** Server-only lease handle. Generation/ownership proof lives in the issuer's WeakMap. */
export type TmuxAttachLease = Readonly<{
  principal: string;
  tmux: Readonly<TmuxPaneIdentity>;
}>;

export type AttachCapabilityService = Readonly<{
  issue: (principal: string, tmux: TmuxPaneIdentity) => Promise<string | null>;
  verify: (token: unknown, principal: string, tmux: TmuxPaneIdentity) => Promise<boolean>;
  createLease: (token: unknown, principal: string, tmux: TmuxPaneIdentity) => Promise<TmuxAttachLease | null>;
  verifyLease: (lease: unknown, principal: string, tmux: TmuxPaneIdentity) => Promise<boolean>;
  size: () => number;
}>;

export async function readTmuxPaneGeneration(tmux: TmuxPaneIdentity): Promise<string | null> {
  const result = await runTmux([
    '-S', tmux.socketPath,
    'display-message', '-p', '-t', tmux.paneId,
    '#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}',
  ]);
  const [sessionId, windowId, paneId, generation] = result.output.trim().split('\t');
  return result.code === 0 && sessionId === tmux.sessionId && windowId === tmux.windowId
    && paneId === tmux.paneId && /^\d+$/.test(generation ?? '') ? generation : null;
}

function samePane(a: TmuxPaneIdentity, b: TmuxPaneIdentity): boolean {
  return a.socketPath === b.socketPath
    && a.sessionId === b.sessionId
    && a.windowId === b.windowId
    && a.paneId === b.paneId;
}

function paneKey(principal: string, tmux: TmuxPaneIdentity): string {
  return `${principal}\u0000${tmux.socketPath}\u0000${tmux.sessionId}\u0000${tmux.windowId}\u0000${tmux.paneId}`;
}

/**
 * Creates an in-memory, server-issued attach capability store. Recreating this
 * service (including on server restart) intentionally invalidates every token.
 */
export function createAttachCapabilityService(
  options: Readonly<{ now?: () => number; ttlMs?: number; maxRecords?: number; readPaneGeneration?: PaneGenerationReader; socketInspector?: LocalTmuxSocketInspector }> = {},
): AttachCapabilityService {
  const records = new Map<string, AttachCapabilityRecord>();
  // Leases follow cached PTY lifetime, independently of token expiry/eviction.
  // Copying or deserializing a handle cannot recreate its private authority.
  const leases = new WeakMap<TmuxAttachLease, AttachCapabilityRecord>();
  const activeTokens = new Map<string, string>();
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? ATTACH_CAPABILITY_TTL_MS;
  const maxRecords = options.maxRecords ?? MAX_ATTACH_CAPABILITIES;
  const readPaneGeneration = options.readPaneGeneration ?? readTmuxPaneGeneration;

  const readCheckedGeneration = async (tmux: TmuxPaneIdentity): Promise<string | null> => {
    const before = await assertLocalTmuxSocket(tmux, process.env, options.socketInspector);
    const generation = await readPaneGeneration(tmux);
    const after = await assertLocalTmuxSocket(tmux, process.env, options.socketInspector);
    if (before && (!after || !sameLocalTmuxSocket(before, after))) return null;
    if (after) rememberLocalTmuxSocket(tmux, after);
    return generation && after ? `${generation}\0${after.generation}` : generation;
  };

  const remove = (token: string, record = records.get(token)): void => {
    if (!record) return;
    records.delete(token);
    const key = paneKey(record.principal, record.tmux);
    if (activeTokens.get(key) === token) activeTokens.delete(key);
  };
  const pruneExpired = (): void => {
    const time = now();
    for (const [token, record] of records) {
      if (record.expiresAtMs <= time) remove(token, record);
    }
  };
  const enforceLimit = (): void => {
    while (records.size >= maxRecords) {
      const oldest = records.keys().next().value as string | undefined;
      if (!oldest) return;
      remove(oldest);
    }
  };

  const verifiedRecord = async (token: unknown, principal: string, tmux: TmuxPaneIdentity): Promise<AttachCapabilityRecord | null> => {
    pruneExpired();
    if (typeof token !== 'string') return null;
    const record = records.get(token);
    if (!record || record.principal !== principal || !samePane(record.tmux, tmux)) return null;
    try {
      const generation = await readCheckedGeneration(record.tmux);
      if (record.expiresAtMs <= now()) {
        remove(token, record);
        return null;
      }
      // A concurrent issue() may supersede this token while inspection waits.
      if (records.get(token) !== record || activeTokens.get(paneKey(principal, tmux)) !== token) return null;
      return generation === record.generation ? record : null;
    } catch {
      return null;
    }
  };

  return Object.freeze({
    async issue(principal, tmux) {
      pruneExpired();
      let generation: string | null;
      try {
        generation = await readCheckedGeneration(tmux);
      } catch {
        return null;
      }
      if (!generation) return null;

      const key = paneKey(principal, tmux);
      const previous = activeTokens.get(key);
      const previousRecord = previous ? records.get(previous) : undefined;
      if (previous && previousRecord?.generation === generation && previousRecord.expiresAtMs > now()) return previous;
      if (previous) remove(previous);
      enforceLimit();
      const token = randomBytes(32).toString('base64url');
      const identity = Object.freeze({ ...tmux });
      copyLocalTmuxSocketEvidence(tmux, identity);
      records.set(token, Object.freeze({
        principal,
        tmux: identity,
        generation,
        expiresAtMs: now() + ttlMs,
      }));
      activeTokens.set(key, token);
      return token;
    },
    async verify(token, principal, tmux) {
      return await verifiedRecord(token, principal, tmux) !== null;
    },
    async createLease(token, principal, tmux) {
      const record = await verifiedRecord(token, principal, tmux);
      if (!record) return null;
      const lease = Object.freeze({ principal: record.principal, tmux: record.tmux });
      leases.set(lease, record);
      return lease;
    },
    async verifyLease(lease, principal, tmux) {
      if (!lease || typeof lease !== 'object') return false;
      const record = leases.get(lease as TmuxAttachLease);
      if (!record || record.principal !== principal || !samePane(record.tmux, tmux)) return false;
      try {
        return await readCheckedGeneration(record.tmux) === record.generation;
      } catch {
        return false;
      }
    },
    size() {
      pruneExpired();
      return records.size;
    },
  });
}

export const attachCapabilityService = createAttachCapabilityService();
