import { randomBytes } from 'node:crypto';

import type { TmuxPaneIdentity } from '../../../../shared/tmux.js';

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

export type AttachCapabilityService = Readonly<{
  issue: (principal: string, tmux: TmuxPaneIdentity) => Promise<string | null>;
  verify: (token: unknown, principal: string, tmux: TmuxPaneIdentity) => Promise<boolean>;
  size: () => number;
}>;

export async function readTmuxPaneGeneration(tmux: TmuxPaneIdentity): Promise<string | null> {
  const result = await runTmux([
    '-S', tmux.socketPath,
    'display-message', '-p', '-t', tmux.paneId,
    '#{pane_pid}',
  ]);
  const generation = result.output.trim();
  return result.code === 0 && generation ? generation : null;
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
  options: Readonly<{ now?: () => number; ttlMs?: number; maxRecords?: number; readPaneGeneration?: PaneGenerationReader }> = {},
): AttachCapabilityService {
  const records = new Map<string, AttachCapabilityRecord>();
  const activeTokens = new Map<string, string>();
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? ATTACH_CAPABILITY_TTL_MS;
  const maxRecords = options.maxRecords ?? MAX_ATTACH_CAPABILITIES;
  const readPaneGeneration = options.readPaneGeneration ?? readTmuxPaneGeneration;

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

  return Object.freeze({
    async issue(principal, tmux) {
      pruneExpired();
      let generation: string | null;
      try {
        generation = await readPaneGeneration(tmux);
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
      records.set(token, Object.freeze({
        principal,
        tmux: Object.freeze({ ...tmux }),
        generation,
        expiresAtMs: now() + ttlMs,
      }));
      activeTokens.set(key, token);
      return token;
    },
    async verify(token, principal, tmux) {
      pruneExpired();
      if (typeof token !== 'string') return false;
      const record = records.get(token);
      if (!record || record.principal !== principal || !samePane(record.tmux, tmux)) {
        return false;
      }

      try {
        const generation = await readPaneGeneration(tmux);
        if (record.expiresAtMs <= now()) {
          remove(token, record);
          return false;
        }
        // A concurrent issue() may have observed a newer pane generation and
        // superseded this token while the read was pending. Accepting the stale
        // snapshot would revive a revoked capability, so re-assert that this
        // record is still the active one for its principal and pane.
        if (records.get(token) !== record || activeTokens.get(paneKey(principal, tmux)) !== token) {
          return false;
        }
        return generation === record.generation;
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
