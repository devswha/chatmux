import { open, stat } from 'node:fs/promises';

import { userDb } from '@/modules/database/index.js';
import { notifyLiveTurnEnded } from '@/modules/notifications/services/notification-orchestrator.service.js';
import { getLiveGjcSessionsDetailed, IDLE_GJC_ID_PREFIX } from '@/modules/providers/index.js';

/**
 * Live turn monitor — "답변이 왔을 때 알림" for tmux-driven gjc sessions.
 *
 * Web-run sessions already notify via notifyRunStopped when their child exits;
 * tmux-driven sessions have no app-owned run, so nothing fired. This monitor
 * ticks server-side (independent of any open browser tab — web push must work
 * with the tab closed) and reads each live transcript's APPENDED DELTA only,
 * looking for the turn terminator gjc actually writes (실측 5,788건):
 * an assistant `message` record with `stopReason` `"stop"` (or `"error"`).
 * `"toolUse"` means the turn continues and never notifies.
 *
 * Safety properties:
 * - Baseline on first sight: a session discovered mid-conversation (or after a
 *   server restart) never replays old completions.
 * - Only `claim === 'lineage'` tmux-named rows are watched — web-run gjc
 *   children (which also hold transcripts open) already notify through the
 *   run path and must not double-fire.
 * - Delta reads are size-capped; a monstrous append only skips ahead.
 * - Per-session dedupe lives in the orchestrator (20s window).
 */

const DELTA_READ_CAP_BYTES = 2 * 1024 * 1024;

export type LiveTurnEnd = 'stop' | 'error';

/**
 * Pure: scans COMPLETE NDJSON lines of a transcript delta for assistant
 * turn-terminating records. Returns terminators in order of appearance.
 */
export function findAssistantTurnEnds(deltaText: string): LiveTurnEnd[] {
  const found: LiveTurnEnd[] = [];
  for (const line of deltaText.split('\n')) {
    // Cheap pre-filter before JSON.parse — deltas are mostly text/tool chunks.
    if (!line.includes('"stopReason"') || !line.includes('"message"')) {
      continue;
    }
    try {
      const record = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; stopReason?: unknown } };
      if (record.type !== 'message' || !record.message || typeof record.message !== 'object') {
        continue;
      }
      const { role, stopReason } = record.message;
      if (role === 'assistant' && (stopReason === 'stop' || stopReason === 'error')) {
        found.push(stopReason);
      }
    } catch {
      // partial or foreign line — ignore
    }
  }
  return found;
}

type SessionCursor = { path: string; offset: number; tmuxName: string | null };

type MonitorDeps = {
  getDetailed: () => Promise<{
    sessions: Array<{ id: string; tmuxName: string | null; claim: 'lineage' | 'cwd' | null }>;
    transcriptPaths: Map<string, string>;
  }>;
  notify: (args: { userId: number; sessionId: string; tmuxName: string | null; stopReason: LiveTurnEnd }) => void;
  getUserId: () => number | null;
  readDelta?: (path: string, start: number, end: number) => Promise<string>;
  statSize?: (path: string) => Promise<number>;
};

async function defaultReadDelta(path: string, start: number, end: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function defaultStatSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

/** DI-friendly core so ticks are unit-testable without tmux/lsof. */
export function createLiveTurnMonitor(deps: MonitorDeps) {
  const cursors = new Map<string, SessionCursor>();
  const readDelta = deps.readDelta ?? defaultReadDelta;
  const statSize = deps.statSize ?? defaultStatSize;
  let ticking = false;

  /** Reads the cursor's unconsumed delta and notifies on any turn terminator. */
  const consumeDelta = async (sessionId: string, cursor: SessionCursor, userId: number): Promise<void> => {
    const size = await statSize(cursor.path);
    if (size < cursor.offset) {
      cursor.offset = size; // truncated/rotated — re-baseline silently
      return;
    }
    if (size === cursor.offset) {
      return;
    }
    // Cap the read; a giant append just fast-forwards (terminators sit at the
    // turn's tail, which the capped window covers).
    const start = Math.max(cursor.offset, size - DELTA_READ_CAP_BYTES);
    const delta = await readDelta(cursor.path, start, size);
    const lastNewline = delta.lastIndexOf('\n');
    if (lastNewline < 0) {
      return; // no complete line yet — re-read next tick
    }
    cursor.offset = start + lastNewline + 1;
    const ends = findAssistantTurnEnds(delta.slice(0, lastNewline + 1));
    if (ends.length > 0) {
      deps.notify({
        userId,
        sessionId,
        tmuxName: cursor.tmuxName,
        stopReason: ends[ends.length - 1],
      });
    }
  };

  const tick = async (): Promise<void> => {
    if (ticking) {
      return; // a slow previous tick still runs — never overlap
    }
    ticking = true;
    try {
      const userId = deps.getUserId();
      if (userId == null) {
        return;
      }
      const { sessions, transcriptPaths } = await deps.getDetailed();
      const seen = new Set<string>();
      for (const session of sessions) {
        // tmux-owned transcript-backed rows only (see module doc).
        if (
          session.claim !== 'lineage' ||
          !session.tmuxName ||
          session.id.startsWith(IDLE_GJC_ID_PREFIX) ||
          !transcriptPaths.has(session.id)
        ) {
          continue;
        }
        const path = transcriptPaths.get(session.id)!;
        seen.add(session.id);
        try {
          const cursor = cursors.get(session.id);
          if (!cursor || cursor.path !== path) {
            // First sight / rotated: baseline silently at the current size.
            cursors.set(session.id, { path, offset: await statSize(path), tmuxName: session.tmuxName });
            continue;
          }
          cursor.tmuxName = session.tmuxName;
          await consumeDelta(session.id, cursor, userId);
        } catch {
          // transcript vanished mid-tick etc. — drop the cursor and re-baseline
          cursors.delete(session.id);
        }
      }
      // Sessions gone from the live set: gjc CLOSES the transcript when the
      // turn ends (idle-lane 발견과 동일한 특성), so a short turn's terminator
      // often lands together with the fd close — the session simply vanishes
      // from lsof before the next tick. FINAL SWEEP: read the remaining delta
      // from disk once before freeing the cursor, or short replies are missed.
      for (const [id, cursor] of cursors) {
        if (seen.has(id)) {
          continue;
        }
        try {
          const userId = deps.getUserId();
          if (userId != null) {
            await consumeDelta(id, cursor, userId);
          }
        } catch {
          // file gone too — nothing to salvage
        }
        cursors.delete(id);
      }
    } finally {
      ticking = false;
    }
  };

  return { tick, cursorCount: () => cursors.size };
}

const DEFAULT_INTERVAL_MS = 5000;

/**
 * Starts the production monitor. Disabled with CHATMUX_LIVE_NOTIFY=0.
 * Self-host is single-user: events route to the first user.
 */
export function startLiveTurnMonitor(intervalMs = DEFAULT_INTERVAL_MS): (() => void) | null {
  if (process.env.CHATMUX_LIVE_NOTIFY === '0') {
    return null;
  }
  const monitor = createLiveTurnMonitor({
    getDetailed: getLiveGjcSessionsDetailed,
    notify: ({ userId, sessionId, tmuxName, stopReason }) =>
      notifyLiveTurnEnded({ userId, sessionId, tmuxName, stopReason }),
    getUserId: () => {
      try {
        const user = userDb.getFirstUser();
        return user ? user.id : null;
      } catch {
        return null;
      }
    },
  });
  const timer = setInterval(() => {
    void monitor.tick().catch(() => {
      // detection is best-effort; never crash the server loop
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
