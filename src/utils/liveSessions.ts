import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../shared/tmux';

export const GJC_IDLE_SESSION_PREFIX = 'idle-gjc:';


/** Missing discovery metadata is a legacy successful response. */
export function readDiscoveryOk(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!Object.prototype.hasOwnProperty.call(value, 'discovery')) return true;
  const discovery = (value as { discovery?: unknown }).discovery;
  return Boolean(
    discovery
    && typeof discovery === 'object'
    && !Array.isArray(discovery)
    && Object.prototype.hasOwnProperty.call(discovery, 'ok')
    && (discovery as { ok?: unknown }).ok === true,
  );
}
type RestSessionContainer = {
  sessions: unknown[];
  discoveryOk: boolean;
};

function readObjectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Accepts legacy top-level session arrays and current `{ data }` envelopes only
 * when the named container is actually an array. A present malformed envelope
 * is unavailable evidence, not an empty authoritative roster.
 */
export function readRestSessionContainer(
  value: unknown,
  sessionKey: 'liveSessions' | 'externalSessions',
): RestSessionContainer | null {
  const root = readObjectRecord(value);
  if (!root) return null;
  const data = Object.prototype.hasOwnProperty.call(root, 'data')
    ? readObjectRecord(root.data)
    : root;
  if (!data || !Array.isArray(data[sessionKey])) return null;
  return {
    sessions: data[sessionKey],
    discoveryOk: readDiscoveryOk(root) && readDiscoveryOk(data),
  };
}

/**
 * New discovery rows carry their server-authoritative tmux action proof.
 * The REST claim remains the compatibility fallback for older servers and
 * the initial snapshot.
 */
export function isLiveTmuxActionable(
  row: { tmuxActionable?: unknown },
  restClaim?: unknown,
): boolean {
  return row.tmuxActionable === true || restClaim === 'lineage';
}

type PromotionApiRow = {
  id?: unknown;
  tmuxName?: unknown;
  tmux?: unknown;
  process?: unknown;
  presence?: unknown;
};

export type GjcPromotionCandidate = {
  id: string;
  tmuxName: string;
  tmux: TmuxPaneIdentity;
  process: TmuxProcessGeneration;
};

/**
 * Resolves a structured GJC row only when it belongs to the exact tmux
 * generation the pending terminal view opened. A name match alone can target a
 * same-named replacement and must never complete the handoff.
 */
function isSameTmuxIdentity(value: unknown, expected: TmuxPaneIdentity): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<TmuxPaneIdentity>;
  return candidate.socketPath === expected.socketPath
    && candidate.sessionId === expected.sessionId
    && candidate.windowId === expected.windowId
    && candidate.paneId === expected.paneId;
}

function isSameProcessGeneration(value: unknown, expected: TmuxProcessGeneration): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<TmuxProcessGeneration>;
  return candidate.pid === expected.pid && candidate.startedAtMs === expected.startedAtMs;
}
export function isSameTmuxPaneTarget(
  left: { tmux: TmuxPaneIdentity; process: TmuxProcessGeneration },
  right: { tmux: TmuxPaneIdentity; process: TmuxProcessGeneration },
): boolean {
  return isSameTmuxIdentity(left.tmux, right.tmux)
    && isSameProcessGeneration(left.process, right.process);
}

function matchesGjcTerminalTarget(
  session: PromotionApiRow,
  target: {
    tmuxName: string;
    tmux: TmuxPaneIdentity;
    process: TmuxProcessGeneration | null;
  },
): boolean {
  return target.process !== null
    && session.presence !== 'stale'
    && session.tmuxName === target.tmuxName
    && isSameTmuxIdentity(session.tmux, target.tmux)
    && isSameProcessGeneration(session.process, target.process);
}

export function hasGjcTerminalTarget(
  sessions: readonly PromotionApiRow[],
  target: {
    tmuxName: string;
    tmux: TmuxPaneIdentity;
    process: TmuxProcessGeneration | null;
  },
): boolean {
  return sessions.some((session) => matchesGjcTerminalTarget(session, target));
}


export function findGjcPromotionCandidate(
  sessions: readonly PromotionApiRow[],
  target: {
    tmuxName: string;
    tmux: TmuxPaneIdentity;
    process: TmuxProcessGeneration | null;
  },
): GjcPromotionCandidate | null {
  if (target.process === null) return null;
  for (const session of sessions) {
    if (
      typeof session.id === 'string'
      && !session.id.startsWith(GJC_IDLE_SESSION_PREFIX)
      && matchesGjcTerminalTarget(session, target)
    ) {
      return {
        id: session.id,
        tmuxName: target.tmuxName,
        tmux: target.tmux,
        process: target.process,
      };
    }
  }
  return null;
}