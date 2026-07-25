import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../shared/tmux';

export const GJC_IDLE_SESSION_PREFIX = 'idle-gjc:';


/** Missing discovery metadata is a legacy successful response. */
export function readDiscoveryOk(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const discovery = (value as { discovery?: unknown }).discovery;
  if (!discovery || typeof discovery !== 'object' || Array.isArray(discovery)) return true;
  const ok = (discovery as { ok?: unknown }).ok;
  return typeof ok === 'boolean' ? ok : true;
}

type PromotionApiRow = {
  id?: unknown;
  tmuxName?: unknown;
  tmux?: unknown;
  process?: unknown;
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
      && session.tmuxName === target.tmuxName
      && isSameTmuxIdentity(session.tmux, target.tmux)
      && isSameProcessGeneration(session.process, target.process)
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