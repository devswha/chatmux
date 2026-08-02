import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

import {
  completionAppAlias,
  completionNotificationTargetsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  createCompletionDecision,
  notifyInputRequired,
  notifyRunFailed,
} from '@/modules/notifications/services/notification-orchestrator.service.js';
import {
  getLiveGjcSessionsDetailed,
  IDLE_GJC_ID_PREFIX,
  onTranscriptChanged,
  type LiveGjcSessionsDetailedResult,
  observeTmuxInputActivity,
} from '@/modules/providers/index.js';

import {
  startEventDrivenMonitorLoop,
  TURN_MONITOR_FALLBACK_MS,
} from './event-driven-monitor-loop.service.js';

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
 * - Individual reads are size-capped while every unread byte is consumed
 *   incrementally, so large appends do not lose completed turns.
 * - Cursor occurrence keys and the durable outbox provide replay deduplication.
 */

const DELTA_READ_CAP_BYTES = 2 * 1024 * 1024;
const DIAGNOSTIC_INTERVAL_MS = 60_000;

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
export type LiveTurnMonitorDiagnosticCode = 'discovery_unavailable' | 'transcript_unavailable' | 'user_lookup_unavailable' | 'tick_unavailable';
export type LiveTurnMonitorDiagnostic = Readonly<{
  code: LiveTurnMonitorDiagnosticCode;
  sessionId?: string;
  count: number;
}>;

type MonitorDeps = {
  getDetailed: () => Promise<{
    ok?: boolean;
    sessions: Array<{ id: string; tmuxName: string | null; claim: 'lineage' | 'cwd' | null }>;
    transcriptPaths: Map<string, string>;
  }>;
  notify: (args: {
    userId: number;
    sessionId: string;
    tmuxName: string | null;
    stopReason: LiveTurnEnd;
    occurrenceKey?: string;
  }) => unknown;
  notifyActionRequired?: (args: {
    userId: number;
    sessionId: string;
    tmuxName: string | null;
    occurrenceKey: string;
  }) => unknown;
  getUserId: () => number | null;
  readDelta?: (path: string, start: number, end: number) => Promise<string | Buffer>;
  statSize?: (path: string) => Promise<number>;
  diagnostic?: (event: LiveTurnMonitorDiagnostic) => void;
  now?: () => number;
};

async function defaultReadDelta(path: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead);
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
  const diagnosticCounts = new Map<LiveTurnMonitorDiagnosticCode, number>();
  const diagnosticLastReported = new Map<string, number>();
  const now = deps.now ?? Date.now;
  const emitDiagnostic = (code: LiveTurnMonitorDiagnosticCode, sessionId?: string): void => {
    const count = (diagnosticCounts.get(code) ?? 0) + 1;
    diagnosticCounts.set(code, count);
    const key = `${code}\0${sessionId ?? ''}`;
    if ((diagnosticLastReported.get(key) ?? -Infinity) + DIAGNOSTIC_INTERVAL_MS > now()) return;
    diagnosticLastReported.set(key, now());
    try {
      deps.diagnostic?.({ code, ...(sessionId ? { sessionId } : {}), count });
    } catch {
      // Diagnostics must not interrupt monitoring.
    }
  };
  let ticking = false;

  /** Reads every unconsumed byte in bounded chunks without splitting UTF-8 records. */
  const consumeDelta = async (sessionId: string, cursor: SessionCursor, userId: number): Promise<void> => {
    const size = await statSize(cursor.path);
    if (size < cursor.offset) {
      cursor.offset = size; // truncated/rotated — re-baseline silently
      return;
    }
    let readOffset = cursor.offset;
    let lineStart = cursor.offset;
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    while (readOffset < size) {
      const end = Math.min(size, readOffset + DELTA_READ_CAP_BYTES);
      const read = await readDelta(cursor.path, readOffset, end);
      const chunk = Buffer.isBuffer(read) ? read : Buffer.from(read, 'utf8');
      if (chunk.length === 0) break;
      readOffset += chunk.length;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const lineBytes = pending.subarray(0, newline);
        const byteEnd = lineStart + newline + 1;
        const line = lineBytes.toString('utf8');
        if (line.includes('"stopReason"') && line.includes('"message"')) {
          try {
            const record = JSON.parse(line) as {
              type?: unknown;
              message?: { role?: unknown; stopReason?: unknown; content?: unknown };
            };
            const { role, stopReason, content } = record.message ?? {};
            const terminalStopReason: LiveTurnEnd | null = (
              stopReason === 'stop' || stopReason === 'error'
            ) ? stopReason : null;
            const asksForInput = record.type === 'message'
              && role === 'assistant'
              && stopReason === 'toolUse'
              && Array.isArray(content)
              && content.some((item) => (
                item
                && typeof item === 'object'
                && (item as { type?: unknown }).type === 'toolCall'
                && ['ask', 'AskUserQuestion', 'request_user_input'].includes(
                  String((item as { name?: unknown }).name ?? ''),
                )
              ));
            if (asksForInput) {
              try {
                const fallbackOccurrenceKey = `gjc:${sessionId}:${byteEnd}:${createHash('sha256').update(line).digest('hex')}`;
                await deps.notifyActionRequired?.({
                  userId,
                  sessionId,
                  tmuxName: cursor.tmuxName,
                  occurrenceKey: observeTmuxInputActivity({
                    provider: 'gjc',
                    providerSessionId: sessionId,
                  }, 'transcript', true) ?? fallbackOccurrenceKey,
                });
              } catch {
                cursor.offset = lineStart;
                return;
              }
            }
            if (record.type === 'message' && role === 'assistant' && terminalStopReason) {
              const notification = {
                userId,
                sessionId,
                tmuxName: cursor.tmuxName,
                stopReason: terminalStopReason,
                occurrenceKey: `gjc:${sessionId}:${byteEnd}:${createHash('sha256').update(line).digest('hex')}`,
              };
              try {
                await deps.notify(notification);
              } catch {
                if (terminalStopReason === 'stop') {
                  cursor.offset = lineStart;
                  return;
                }
              }
            }
          } catch {
            // Partial or foreign line — ignore.
          }
        }
        cursor.offset = byteEnd;
        lineStart = byteEnd;
        pending = pending.subarray(newline + 1);
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (ticking) {
      return; // a slow previous tick still runs — never overlap
    }
    ticking = true;
    try {
      let userId: number | null;
      try {
        userId = deps.getUserId();
      } catch {
        emitDiagnostic('user_lookup_unavailable');
        return;
      }
      if (userId == null) {
        emitDiagnostic('user_lookup_unavailable');
        return;
      }
      const detailed = await deps.getDetailed();
      if (detailed.ok === false) {
        emitDiagnostic('discovery_unavailable');
        return;
      }
      const { sessions, transcriptPaths } = detailed;
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
          // Preserve a known cursor so a transient stat/read failure is retried.
          emitDiagnostic('transcript_unavailable', session.id);
        }
      }
      // A missing lineage row is indistinguishable from a manual interruption.
      // Do not final-sweep it: only a currently observed transcript-backed turn
      // can create a completion decision. Retire its cursor silently instead.
      for (const id of cursors.keys()) {
        if (!seen.has(id)) cursors.delete(id);
      }
    } catch {
      emitDiagnostic('tick_unavailable');
    } finally {
      ticking = false;
    }
  };

  return { tick, cursorCount: () => cursors.size };
}

const DEFAULT_INTERVAL_MS = TURN_MONITOR_FALLBACK_MS;

/**
 * Starts the production monitor. Disabled with CHATMUX_LIVE_NOTIFY=0.
 * Self-host is single-user: events route to the first user.
 */
export function startLiveTurnMonitor(
  intervalMs = DEFAULT_INTERVAL_MS,
  getDetailed: () => Promise<LiveGjcSessionsDetailedResult> = getLiveGjcSessionsDetailed,
): (() => void) | null {
  if (process.env.CHATMUX_LIVE_NOTIFY === '0') {
    return null;
  }
  const monitor = createLiveTurnMonitor({
    getDetailed,
    notify: ({ userId, sessionId, tmuxName, stopReason, occurrenceKey }) => {
      if (stopReason === 'stop' && occurrenceKey) {
        createCompletionDecision({
          userId,
          target: { provider: 'gjc', sessionId },
          event: {
            code: 'reply_ready',
            preferenceClass: 'liveStop',
            occurrenceKey,
            sessionName: tmuxName,
            stopReason: 'completed',
          },
        });
        return;
      }
      notifyRunFailed({
        userId,
        provider: 'gjc',
        sessionId,
        sessionName: tmuxName,
        error: 'GJC turn ended with an error',
      });
    },
    notifyActionRequired: ({ userId, sessionId, tmuxName, occurrenceKey }) => {
      const alias = completionAppAlias({ provider: 'gjc', sessionId });
      const target = completionNotificationTargetsDb.resolveAlias(alias);
      if (!target || !completionNotificationTargetsDb.getWatch(userId, target.id)) return;
      notifyInputRequired({
        userId,
        provider: 'gjc',
        sessionId,
        sessionName: tmuxName,
        occurrenceKey,
      });
    },
    getUserId: () => {
      try {
        const user = userDb.getFirstUser();
        return user ? user.id : null;
      } catch {
        return null;
      }
    },
    diagnostic: ({ code, sessionId, count }) => {
      console.warn(`Live turn monitor diagnostic: ${code}${sessionId ? ` for ${sessionId}` : ''} (count ${count}).`);
    },
  });
  return startEventDrivenMonitorLoop({
    tick: monitor.tick,
    subscribe: onTranscriptChanged,
    accepts: (change) => change.provider === 'gjc',
    fallbackMs: intervalMs,
  });
}
