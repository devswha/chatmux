import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';

type ChatRunStatus = 'running' | 'completed';

type ChatRun = {
  appSessionId: string;
  hostId: string | undefined;
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
};

const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

const runs = new Map<string, ChatRun>();
const processingListeners = new Set<() => void>();
const eventListeners = new Set<(event: NormalizedMessage) => void>();
const runKey = (appSessionId: string, hostId?: string): string => hostId === undefined ? appSessionId : `${hostId.length}:${hostId}${appSessionId.length}:${appSessionId}`;

function notifyProcessingChanged(): void {
  for (const listener of processingListeners) listener();
}

async function broadcastCanonicalSessionUpsert(appSessionId: string): Promise<void> {
  const row = sessionsDb.getSessionById(appSessionId);
  if (!row) {
    return;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  const payload = JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id,
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

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}

function evictRunLater(appSessionId: string, hostId?: string): void {
  const key = runKey(appSessionId, hostId);
  const timer = setTimeout(() => {
    const run = runs.get(key);
    if (run && run.status === 'completed') {
      runs.delete(key);
    }
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }

  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
  };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    evictRunLater(run.appSessionId, run.hostId);
  }

  run.events.push(outbound);
  if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
  }

  notifyProcessingChanged();
  for (const listener of eventListeners) {
    try {
      listener(outbound);
    } catch (error) {
      // Listeners are side channels (fleet publish, tests); the browser
      // stream that recorded this event must never fail because one broke.
      console.error('[Chat Run Registry] Event listener failed:', error instanceof Error ? error.message : error);
    }
  }
  return outbound;
}

function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, run.provider, providerSessionId);
    void broadcastCanonicalSessionUpsert(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

export const chatRunRegistry = {
  startRun(input: {
    appSessionId: string;
    hostId?: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    connection: RealtimeClientConnection;
    userId: string | number | null;
  }): ChatRun | null {
    const key = runKey(input.appSessionId, input.hostId);
    const existing = runs.get(key);
    if (existing && existing.status === 'running') {
      return null;
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      hostId: input.hostId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      lastSeq: 0,
      events: [],
      writer: new ChatSessionWriter({
        appSessionId: input.appSessionId,
        connection: input.connection,
        userId: input.userId,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        onProviderSessionId: (providerSessionId) => recordProviderSessionId(run, providerSessionId),
        decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
      }),
      startedAt: Date.now(),
      completedAt: null,
    };

    runs.set(key, run);
    notifyProcessingChanged();
    return run;
  },

  subscribeProcessing(listener: () => void): () => void {
    processingListeners.add(listener);
    return () => processingListeners.delete(listener);
  },

  subscribeEvents(listener: (event: NormalizedMessage) => void): () => void {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  },

  getRun(appSessionId: string, hostId?: string): ChatRun | undefined {
    return runs.get(runKey(appSessionId, hostId));
  },

  isProcessing(appSessionId: string, hostId?: string): boolean {
    return runs.get(runKey(appSessionId, hostId))?.status === 'running';
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
      }));
  },

  attachConnection(appSessionId: string, connection: RealtimeClientConnection, hostId?: string): boolean {
    const run = runs.get(runKey(appSessionId, hostId));
    if (!run) {
      return false;
    }

    run.writer.updateWebSocket(connection);
    return true;
  },

  replayEvents(appSessionId: string, afterSeq: number, hostId?: string): NormalizedMessage[] {
    const run = runs.get(runKey(appSessionId, hostId));
    if (!run) {
      return [];
    }

    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
  },

  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }, hostId?: string): void {
    const run = runs.get(runKey(appSessionId, hostId));
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(runKey(run.appSessionId, run.hostId)) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  clearAll(): void {
    const changed = Array.from(runs.values()).some((run) => run.status === 'running');
    runs.clear();
    if (changed) notifyProcessingChanged();
  },
};
