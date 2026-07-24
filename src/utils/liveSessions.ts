import {
  tmuxPaneIdentityKey,
  type TmuxPaneIdentity,
  type TmuxProcessGeneration,
} from '../../shared/tmux';

export const GJC_IDLE_SESSION_PREFIX = 'idle-gjc:';

export type LiveSessionSnapshotRow = {
  tmuxName: string | null;
  tmux: TmuxPaneIdentity | null;
  process: TmuxProcessGeneration | null;
  model: string | null;
  effort: string | null;
  lineage: boolean;
  kind: string | null;
  running: boolean | null;
};

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

function liveTargetKey(tmux: TmuxPaneIdentity, process: TmuxProcessGeneration): string {
  return `${tmuxPaneIdentityKey(tmux)}\u0000${process.pid}\u0000${process.startedAtMs}`;
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

/**
 * Keeps an ordinary row through one missing poll, but removes a synthetic idle
 * row immediately when the same tmux generation appears under a real transcript
 * id. This preserves transient-scan protection without rendering both sides of
 * one terminal-to-structured handoff.
 */
export function retainTransientlyMissingLiveRows(
  rows: Map<string, LiveSessionSnapshotRow>,
  previousRows: ReadonlyMap<string, LiveSessionSnapshotRow>,
  missedOnce: ReadonlySet<string>,
): Set<string> {
  const promotedTargets = new Set<string>();
  for (const [id, row] of rows) {
    if (
      !id.startsWith(GJC_IDLE_SESSION_PREFIX)
      && row.lineage
      && row.tmux !== null
      && row.process !== null
    ) {
      promotedTargets.add(liveTargetKey(row.tmux, row.process));
    }
  }

  const nextMissed = new Set<string>();
  for (const [id, row] of previousRows) {
    if (rows.has(id)) {
      continue;
    }
    const wasPromoted = id.startsWith(GJC_IDLE_SESSION_PREFIX)
      && row.tmux !== null
      && row.process !== null
      && promotedTargets.has(liveTargetKey(row.tmux, row.process));
    if (wasPromoted) {
      continue;
    }
    if (!missedOnce.has(id)) {
      nextMissed.add(id);
      rows.set(id, row);
    }
  }
  return nextMissed;
}
