import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { GjcSessionWatcher } from '@/modules/providers/services/gjc-session-watcher.service.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';

import { markTranscriptChanged } from './transcript-change.service.js';

type WatcherEventType = 'add' | 'change';

const PROVIDER_WATCH_PATHS: Array<{ provider: LLMProvider; rootPath: string }> = [
  {
    provider: 'claude',
    rootPath: path.join(os.homedir(), '.claude', 'projects'),
  },
  {
    provider: 'cursor',
    rootPath: path.join(os.homedir(), '.cursor', 'projects'),
  },
  {
    provider: 'codex',
    rootPath: path.join(os.homedir(), '.codex', 'sessions'),
  },
  {
    provider: 'opencode',
    rootPath: path.join(os.homedir(), '.local', 'share', 'opencode'),
  },
  {
    provider: 'omp',
    rootPath: path.join(os.homedir(), '.omp', 'agent', 'sessions'),
  },
  {
    provider: 'omo',
    rootPath: path.join(os.homedir(), '.omo', 'agent', 'sessions'),
  },
];

const GJC_TERMINAL_RECEIPT_ROOT = path.join(os.homedir(), '.gjc', 'agent', 'terminal-sessions');
const GJC_WATCH_PATHS = [...new Set([
  path.join(os.homedir(), '.gjc', 'agent', 'sessions'),
  path.resolve(process.env.GJC_LIVE_SESSION_DIR || path.join(os.tmpdir(), 'gjc-live-sessions')),
  GJC_TERMINAL_RECEIPT_ROOT,
])];

const WATCHER_IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/*.tmp',
  '**/*.swp',
  '**/.DS_Store',
];

const PROJECTS_UPDATE_DEBOUNCE_MS = 500;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;
const FILE_UPDATE_DEBOUNCE_MS = 150;
const FILE_UPDATE_MAX_WAIT_MS = 1_000;
const WATCHER_FALLBACK_RECONCILE_MS = 60_000;

const watchers: FSWatcher[] = [];
let gjcWatcher: GjcSessionWatcher | null = null;
let gjcWatcherStarting: GjcSessionWatcher | null = null;
const gjcWatcherStartTasks = new Set<Promise<void>>();
const gjcWatcherStartAbortControllers = new Set<AbortController>();
let gjcWatcherRestartTimer: ReturnType<typeof setTimeout> | null = null;
let gjcWatcherRestartDelayMs = 1_000;
// Restarts are capped at GJC_WATCH_RESTART_MAX_MS, so a permanently broken watcher
// otherwise logs one indistinguishable line every 30s forever. The run length makes
// a stuck loop visible in the log without needing to count timestamps by hand.
let gjcWatcherConsecutiveFailures = 0;
let gjcWatcherEnospcObserved = false;
let gjcWatcherGeneration = 0;
let sessionWatchersClosing = false;
const GJC_WATCH_RESTART_MAX_MS = 30_000;
// #42: a watcher failing at the 30s cap because of a host condition (measured:
// inotify ENOSPC for 14.5h / 1752 attempts) cannot succeed by retrying faster.
// After this many consecutive failures the supervisor degrades to a slow probe
// cadence — recovery stays automatic, without a permanent 30s crash loop.
export const GJC_WATCH_MAX_FAST_FAILURES = 20;
export const GJC_WATCH_DEGRADED_RETRY_MS = 10 * 60_000;

/** Pure restart schedule, exported for tests: fast backoff, then slow probes. */
export function nextGjcWatcherRestartDelayMs(
  consecutiveFailures: number,
  currentDelayMs: number,
): { delayMs: number; nextDelayMs: number; degraded: boolean } {
  if (consecutiveFailures >= GJC_WATCH_MAX_FAST_FAILURES) {
    return { delayMs: GJC_WATCH_DEGRADED_RETRY_MS, nextDelayMs: currentDelayMs, degraded: true };
  }
  return {
    delayMs: currentDelayMs,
    nextDelayMs: Math.min(currentDelayMs * 2, GJC_WATCH_RESTART_MAX_MS),
    degraded: false,
  };
}

export type GjcWatcherHealth = {
  ok: boolean;
  consecutiveFailures: number;
  degraded: boolean;
  enospcObserved: boolean;
};

/** Current native-watcher health for diagnostics and status surfaces. */
export function getGjcWatcherHealth(): GjcWatcherHealth {
  return {
    ok: gjcWatcherConsecutiveFailures === 0,
    consecutiveFailures: gjcWatcherConsecutiveFailures,
    degraded: gjcWatcherConsecutiveFailures >= GJC_WATCH_MAX_FAST_FAILURES,
    enospcObserved: gjcWatcherEnospcObserved,
  };
}

type PendingWatcherUpdate = {
  providers: Set<LLMProvider>;
  changeTypes: Set<WatcherEventType>;
  /**
   * Provider-native session ids reported by the synchronizers are grouped by
   * provider so ids shared by different providers remain distinct.
   */
  updatedSessionIdsByProvider: Map<LLMProvider, Set<string>>;
};

let pendingWatcherUpdate: PendingWatcherUpdate | null = null;
let pendingWatcherUpdateStartedAt: number | null = null;
let pendingWatcherFlushTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRefreshInFlight = false;
let watcherRescheduleAfterRefresh = false;
let watcherFallbackTimer: ReturnType<typeof setInterval> | null = null;
let watcherFallbackTask: Promise<void> | null = null;
let watcherFallbackAbortController: AbortController | null = null;
let watcherFallbackGeneration = 0;
type PendingFileUpdate = {
  eventType: WatcherEventType;
  filePath: string;
  provider: LLMProvider;
  signal?: AbortSignal;
  startedAtMs: number;
  timer: ReturnType<typeof setTimeout> | null;
};
const pendingFileUpdates = new Map<string, PendingFileUpdate>();
const fileUpdatesInFlight = new Set<string>();

/**
 * Filters watcher events to provider-specific session artifact file types.
 */
function isWatcherTargetFile(provider: LLMProvider, filePath: string): boolean {
  if (provider === 'opencode') {
    return path.basename(filePath) === 'opencode.db';
  }

  return filePath.endsWith('.jsonl')
    || (provider === 'gjc' && isGjcTerminalReceiptPath(filePath));
}

function isGjcTerminalReceiptPath(filePath: string): boolean {
  return path.basename(path.dirname(filePath)) === path.basename(GJC_TERMINAL_RECEIPT_ROOT)
    && /^tmux-%\d+$/u.test(path.basename(filePath));
}

function providerSessionIdForIndexed(
  provider: LLMProvider,
  indexedSessionId: string,
): string {
  const session = sessionsDb.getSessionById(indexedSessionId);
  return session?.provider === provider && session.provider_session_id
    ? session.provider_session_id
    : indexedSessionId;
}

function clearPendingWatcherFlushTimer(): void {
  if (pendingWatcherFlushTimer) {
    clearTimeout(pendingWatcherFlushTimer);
    pendingWatcherFlushTimer = null;
  }
}

function schedulePendingWatcherFlush(): void {
  if (!pendingWatcherUpdate) {
    return;
  }

  const now = Date.now();
  if (pendingWatcherUpdateStartedAt === null) {
    pendingWatcherUpdateStartedAt = now;
  }

  const elapsed = now - pendingWatcherUpdateStartedAt;
  const remainingMaxWait = Math.max(0, PROJECTS_UPDATE_MAX_WAIT_MS - elapsed);
  const delay = Math.min(PROJECTS_UPDATE_DEBOUNCE_MS, remainingMaxWait);

  clearPendingWatcherFlushTimer();
  pendingWatcherFlushTimer = setTimeout(() => {
    void flushPendingWatcherUpdate();
  }, delay);
}

function queuePendingWatcherUpdate(
  eventType: WatcherEventType,
  provider: LLMProvider,
  updatedSessionId: string | null
): void {
  if (!pendingWatcherUpdate) {
    pendingWatcherUpdate = {
      providers: new Set<LLMProvider>(),
      changeTypes: new Set<WatcherEventType>(),
      updatedSessionIdsByProvider: new Map<LLMProvider, Set<string>>(),
    };
  }

  pendingWatcherUpdate.providers.add(provider);
  pendingWatcherUpdate.changeTypes.add(eventType);
  if (updatedSessionId) {
    const updatedSessionIds = pendingWatcherUpdate.updatedSessionIdsByProvider.get(provider);
    if (updatedSessionIds) {
      updatedSessionIds.add(updatedSessionId);
    } else {
      pendingWatcherUpdate.updatedSessionIdsByProvider.set(provider, new Set([updatedSessionId]));
    }
  }

  schedulePendingWatcherFlush();
}

/**
 * Builds one `session_upserted` delta event for a provider-native session id.
 *
 * The event carries everything a sidebar needs to upsert the session in place
 * (session summary plus owning-project metadata), so clients never need a full
 * project-list refetch when a transcript file changes on disk. Returns `null`
 * when the id cannot be resolved to an indexed session row.
 */
async function buildSessionUpsertedEvent(
  provider: LLMProvider,
  updatedProviderSessionId: string
): Promise<string | null> {
  const row = sessionsDb.getSessionByProviderSessionId(provider, updatedProviderSessionId)
    ?? sessionsDb.getSessionById(updatedProviderSessionId);
  if (!row) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  return JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  });
}

async function flushPendingWatcherUpdate(): Promise<void> {
  clearPendingWatcherFlushTimer();

  if (!pendingWatcherUpdate) {
    return;
  }

  if (watcherRefreshInFlight) {
    watcherRescheduleAfterRefresh = true;
    return;
  }

  const queuedUpdate = pendingWatcherUpdate;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = true;

  try {
    // Per-session deltas instead of full project snapshots: an upsert of one
    // session can never clobber unrelated client state, so the frontend needs
    // no "suppress updates while a run is active" protection logic.
    const events: string[] = [];
    for (const [provider, updatedSessionIds] of queuedUpdate.updatedSessionIdsByProvider) {
      for (const updatedSessionId of updatedSessionIds) {
        const event = await buildSessionUpsertedEvent(provider, updatedSessionId);
        if (event) {
          events.push(event);
        }
      }
    }

    if (events.length > 0) {
      connectedClients.forEach(client => {
        if (client.readyState === WS_OPEN_STATE) {
          for (const event of events) {
            client.send(event);
          }
        }
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session watcher refresh failed while broadcasting session_upserted', { error: message });
  } finally {
    watcherRefreshInFlight = false;

    if (pendingWatcherUpdate || watcherRescheduleAfterRefresh) {
      watcherRescheduleAfterRefresh = false;
      schedulePendingWatcherFlush();
    }
  }
}

/**
 * Handles file watcher updates and triggers provider file-level synchronization.
 */
async function onUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }
  if (provider === 'gjc' && isGjcTerminalReceiptPath(filePath)) {
    // Pane receipts are discovery bindings, not transcript artifacts. Waking
    // discovery is enough; transcript indexing is handled by its own event.
    markTranscriptChanged('gjc');
    return;
  }
  try {
    const result = await sessionSynchronizerService.synchronizeProviderFile(
      provider,
      filePath,
      signal
    );
    if (signal?.aborted) {
      return;
    }
    if (!result.indexed) {
      return;
    }
    markTranscriptChanged(
      provider,
      result.sessionId
        ? providerSessionIdForIndexed(provider, result.sessionId)
        : null,
    );

    console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
      filePath,
      sessionId: result.sessionId,
    });
    queuePendingWatcherUpdate(eventType, provider, result.sessionId);
  } catch (error) {
    if (signal?.aborted) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    markTranscriptChanged(provider);
    console.error(`Session watcher sync failed for provider "${provider}"`, {
      eventType,
      filePath,
      error: message,
    });
  }
}

function fileUpdateKey(provider: LLMProvider, filePath: string): string {
  return `${provider}\0${filePath}`;
}

function scheduleFileUpdate(entry: PendingFileUpdate, key: string): void {
  if (entry.timer) clearTimeout(entry.timer);
  const elapsedMs = Date.now() - entry.startedAtMs;
  const delayMs = Math.min(
    FILE_UPDATE_DEBOUNCE_MS,
    Math.max(0, FILE_UPDATE_MAX_WAIT_MS - elapsedMs),
  );
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (fileUpdatesInFlight.has(key)) {
      entry.startedAtMs = Date.now();
      scheduleFileUpdate(entry, key);
      return;
    }
    pendingFileUpdates.delete(key);
    fileUpdatesInFlight.add(key);
    void onUpdate(entry.eventType, entry.filePath, entry.provider, entry.signal)
      .finally(() => {
        fileUpdatesInFlight.delete(key);
        const queued = pendingFileUpdates.get(key);
        if (queued && !queued.timer) scheduleFileUpdate(queued, key);
      });
  }, delayMs);
  entry.timer.unref?.();
}

function queueFileUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider,
  signal?: AbortSignal,
): void {
  if (!isWatcherTargetFile(provider, filePath) || signal?.aborted) return;
  const key = fileUpdateKey(provider, filePath);
  const existing = pendingFileUpdates.get(key);
  if (existing) {
    existing.eventType = eventType === 'add' ? 'add' : existing.eventType;
    existing.signal = signal;
    scheduleFileUpdate(existing, key);
    return;
  }
  const entry: PendingFileUpdate = {
    eventType,
    filePath,
    provider,
    signal,
    startedAtMs: Date.now(),
    timer: null,
  };
  pendingFileUpdates.set(key, entry);
  scheduleFileUpdate(entry, key);
}

function clearGjcWatcherRestartTimer(): void {
  if (!gjcWatcherRestartTimer) return;
  clearTimeout(gjcWatcherRestartTimer);
  gjcWatcherRestartTimer = null;
}

function scheduleGjcWatcherRestart(): void {
  if (sessionWatchersClosing || gjcWatcherRestartTimer) return;
  const schedule = nextGjcWatcherRestartDelayMs(
    gjcWatcherConsecutiveFailures,
    gjcWatcherRestartDelayMs,
  );
  gjcWatcherRestartDelayMs = schedule.nextDelayMs;
  if (schedule.degraded && gjcWatcherConsecutiveFailures === GJC_WATCH_MAX_FAST_FAILURES) {
    const remedy = gjcWatcherEnospcObserved
      ? ' The watcher child reported ENOSPC: raise the inotify limit'
        + ' (sudo sysctl -w fs.inotify.max_user_watches=524288, persist in /etc/sysctl.d/)'
        + ' — other processes on this host are consuming the watches.'
      : '';
    console.error(
      `GJC native session watcher degraded after ${gjcWatcherConsecutiveFailures} consecutive failures; `
        + `retrying every ${Math.round(GJC_WATCH_DEGRADED_RETRY_MS / 60_000)} minutes. `
        + `Session discovery updates may lag until it recovers.${remedy}`,
    );
  }
  gjcWatcherRestartTimer = setTimeout(() => {
    gjcWatcherRestartTimer = null;
    void startGjcSessionWatcher(true);
  }, schedule.delayMs);
  gjcWatcherRestartTimer.unref?.();
}

async function runGjcSessionWatcherStart(
  reconcileAfterStart: boolean,
  controller: AbortController
): Promise<void> {
  const { signal } = controller;
  if (signal.aborted || sessionWatchersClosing || gjcWatcher || gjcWatcherStarting) return;
  try {
    await Promise.all(GJC_WATCH_PATHS.map((rootPath) => (
      fsPromises.mkdir(rootPath, { recursive: true })
    )));
  } catch {
    if (signal.aborted || sessionWatchersClosing) return;
    console.error('Failed to prepare GJC native session watcher roots.');
    scheduleGjcWatcherRestart();
    return;
  }
  if (signal.aborted || sessionWatchersClosing || gjcWatcher || gjcWatcherStarting) return;
  const generation = ++gjcWatcherGeneration;
  let failureReported = false;
  const reportFailure = (error?: Error): void => {
    if (failureReported || generation !== gjcWatcherGeneration || sessionWatchersClosing) return;
    failureReported = true;
    gjcWatcherConsecutiveFailures += 1;
    if (watcher.enospcObserved) gjcWatcherEnospcObserved = true;
    controller.abort();
    if (gjcWatcher === watcher) gjcWatcher = null;
    const reason = typeof error?.cause === 'string' ? error.cause : 'unreported';
    console.error(
      `GJC native session watcher failed. (${reason}; consecutive ${gjcWatcherConsecutiveFailures})`
    );
    void watcher.close()
      .catch(() => {})
      .finally(() => {
        if (gjcWatcherStarting === watcher) gjcWatcherStarting = null;
        scheduleGjcWatcherRestart();
      });
  };

  const watcher = new GjcSessionWatcher({
    roots: GJC_WATCH_PATHS,
    onEvent: (event, signal) => queueFileUpdate(event.kind, event.path, 'gjc', signal),
    onFailure: reportFailure,
    diagnostic: (message) => console.error(message),
  });
  gjcWatcherStarting = watcher;

  try {
    await watcher.start();
    if (
      failureReported
      || sessionWatchersClosing
      || generation !== gjcWatcherGeneration
    ) {
      await watcher.close();
      return;
    }
    if (gjcWatcherStarting === watcher) gjcWatcherStarting = null;
    gjcWatcher = watcher;
    if (reconcileAfterStart) {
      const reconciliation = await sessionSynchronizerService.reconcileProvider('gjc', signal);
      if (
        failureReported
        || sessionWatchersClosing
        || generation !== gjcWatcherGeneration
      ) {
        if (gjcWatcher === watcher) gjcWatcher = null;
        await watcher.close();
        return;
      }
      for (const sessionId of reconciliation.sessionIds) {
        markTranscriptChanged(
          'gjc',
          providerSessionIdForIndexed('gjc', sessionId),
        );
        queuePendingWatcherUpdate('change', 'gjc', sessionId);
      }
    }
    if (
      failureReported
      || sessionWatchersClosing
      || generation !== gjcWatcherGeneration
    ) {
      if (gjcWatcher === watcher) gjcWatcher = null;
      await watcher.close();
      return;
    }
    gjcWatcherRestartDelayMs = 1_000;
    gjcWatcherConsecutiveFailures = 0;
    gjcWatcherEnospcObserved = false;
  } catch (error) {
    reportFailure(error instanceof Error ? error : undefined);
    await watcher.close();
  }
}

function startGjcSessionWatcher(reconcileAfterStart = false): Promise<void> {
  if (sessionWatchersClosing || gjcWatcher || gjcWatcherStarting) {
    return Promise.resolve();
  }
  const controller = new AbortController();
  gjcWatcherStartAbortControllers.add(controller);
  const trackedTask = runGjcSessionWatcherStart(reconcileAfterStart, controller);
  gjcWatcherStartTasks.add(trackedTask);
  void trackedTask.then(
    () => {
      gjcWatcherStartAbortControllers.delete(controller);
      gjcWatcherStartTasks.delete(trackedTask);
    },
    () => {
      gjcWatcherStartAbortControllers.delete(controller);
      gjcWatcherStartTasks.delete(trackedTask);
    }
  );
  return trackedTask;
}

function fallbackPassIsActive(generation: number, signal: AbortSignal): boolean {
  return !signal.aborted
    && !sessionWatchersClosing
    && generation === watcherFallbackGeneration;
}

function startWatcherFallbackPass(): void {
  if (watcherFallbackTask) return;

  const generation = watcherFallbackGeneration;
  const controller = new AbortController();
  watcherFallbackAbortController = controller;
  const { signal } = controller;
  let task: Promise<void> | null = null;
  task = (async () => {
    try {
      for (const { provider } of PROVIDER_WATCH_PATHS) {
        if (!fallbackPassIsActive(generation, signal)) return;
        try {
          const reconciliation = await sessionSynchronizerService.reconcileProvider(provider, signal);
          if (!fallbackPassIsActive(generation, signal)) return;
          for (const sessionId of reconciliation.sessionIds) {
            if (!fallbackPassIsActive(generation, signal)) return;
            markTranscriptChanged(
              provider,
              providerSessionIdForIndexed(provider, sessionId),
            );
            queuePendingWatcherUpdate('change', provider, sessionId);
          }
        } catch {
          if (!fallbackPassIsActive(generation, signal)) return;
          // Native watcher events remain primary; the next bounded fallback
          // pass retries a missed or temporarily unreadable provider root.
        }
      }
    } finally {
      if (watcherFallbackTask === task) {
        watcherFallbackTask = null;
        watcherFallbackAbortController = null;
      }
    }
  })();
  watcherFallbackTask = task;
}

/**
 * Starts provider filesystem watchers and performs initial DB synchronization.
 */
export async function initializeSessionsWatcher(): Promise<void> {
  console.log('Setting up session watchers');
  sessionWatchersClosing = false;

  await startGjcSessionWatcher();

  const initialSync = await sessionSynchronizerService.synchronizeSessions();
  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    failures: initialSync.failures,
  });

  for (const { provider, rootPath } of PROVIDER_WATCH_PATHS) {
    try {
      await fsPromises.mkdir(rootPath, { recursive: true });

      const watcher = chokidar.watch(rootPath, {
        ignored: WATCHER_IGNORED_PATTERNS,
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        depth: 6,
        usePolling: process.env.CHATMUX_SESSION_WATCH_POLLING === '1',
        interval: 6_000,
        binaryInterval: 6_000,
      });

      watcher
        .on('add', (filePath: string) => {
          queueFileUpdate('add', filePath, provider);
        })
        .on('change', (filePath: string) => {
          queueFileUpdate('change', filePath, provider);
        })
        .on('error', (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          const remedy = message.includes('ENOSPC')
            ? ' (inotify watch exhaustion — raise fs.inotify.max_user_watches; transcript updates fall back to the 60s reconcile pass)'
            : '';
          console.error(`Session watcher error for provider "${provider}"${remedy}`, { error: message });
        });

      watchers.push(watcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${provider}"`, {
        rootPath,
        error: message,
      });
    }
  }

  if (!watcherFallbackTimer) {
    watcherFallbackTimer = setInterval(startWatcherFallbackPass, WATCHER_FALLBACK_RECONCILE_MS);
    watcherFallbackTimer.unref?.();
  }
}

/**
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  sessionWatchersClosing = true;
  watcherFallbackGeneration += 1;
  gjcWatcherGeneration += 1;
  clearGjcWatcherRestartTimer();
  clearPendingWatcherFlushTimer();
  for (const pending of pendingFileUpdates.values()) {
    if (pending.timer) clearTimeout(pending.timer);
  }
  pendingFileUpdates.clear();
  if (watcherFallbackTimer) {
    clearInterval(watcherFallbackTimer);
    watcherFallbackTimer = null;
  }
  watcherFallbackAbortController?.abort();
  const fallbackTask = watcherFallbackTask;
  for (const controller of gjcWatcherStartAbortControllers) {
    controller.abort();
  }
  const startTasks = [...gjcWatcherStartTasks];

  const nativeWatchers = [...new Set(
    [gjcWatcher, gjcWatcherStarting].filter(
      (watcher): watcher is GjcSessionWatcher => watcher !== null
    )
  )];
  gjcWatcher = null;
  gjcWatcherStarting = null;
  await Promise.all([
    ...watchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    }),
    ...nativeWatchers.map((watcher) => watcher.close().catch(() => {
      console.error('Failed to close GJC native session watcher.');
    })),
    ...startTasks.map((task) => task.catch(() => {
      console.error('Failed to stop GJC native session watcher startup.');
    })),
    fallbackTask?.catch(() => {
      console.error('Failed to stop session watcher fallback reconciliation.');
    }),
  ]);
  watchers.length = 0;
  gjcWatcherRestartDelayMs = 1_000;
  gjcWatcherConsecutiveFailures = 0;
  gjcWatcherEnospcObserved = false;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;
  watcherFallbackTask = null;
  watcherFallbackAbortController = null;
}
