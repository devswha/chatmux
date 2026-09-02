import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

type Dependencies = Parameters<typeof handleChatConnection>[2];
type SpawnGuard = NonNullable<Dependencies['findLiveTmuxSpawnBlock']>;

class FakeWebSocket extends EventEmitter {
  readonly readyState = 1;
  readonly frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  async receive(data: Record<string, unknown>): Promise<void> {
    const listeners = this.listeners('message');
    assert.equal(listeners.length, 1);
    await Promise.all(listeners.map((listener) => listener(Buffer.from(JSON.stringify(data)))));
  }
}

function dependencies(guard: SpawnGuard, onSpawn: () => void): Dependencies {
  const spawn: Dependencies['spawnFns']['claude'] = async () => {
    onSpawn();
  };
  const abort: Dependencies['abortFns']['claude'] = async () => false;

  return {
    spawnFns: {
      claude: spawn,
      codex: spawn,
      cursor: spawn,
      opencode: spawn,
      gjc: spawn,
      omp: spawn,
      omo: spawn,
    },
    abortFns: {
      claude: abort,
      codex: abort,
      cursor: abort,
      opencode: abort,
      gjc: abort,
      omp: abort,
      omo: abort,
    },
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
    findLiveTmuxSpawnBlock: guard,
  };
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-websocket-resume-guard-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('chat.send rejects a resume when fresh discovery is unavailable', async () => {
  await withIsolatedDatabase(async () => {
    // Given: a persisted provider session whose live-owner discovery failed.
    sessionsDb.createSession('provider-resume-1', 'claude', '/workspace/demo');
    let spawnCount = 0;
    const ws = new FakeWebSocket();
    handleChatConnection(
      ws as never,
      {} as never,
      dependencies(async () => ({ kind: 'discovery_unavailable' }), () => { spawnCount += 1; }),
    );

    // When: the client asks to resume that session.
    await ws.receive({ type: 'chat.send', sessionId: 'provider-resume-1', content: 'continue' });

    // Then: the gateway fails closed before starting a second writer.
    assert.equal(spawnCount, 0);
    assert.equal(ws.frames.length, 1);
    assert.equal(ws.frames[0]?.kind, 'protocol_error');
    assert.equal(ws.frames[0]?.code, 'DISCOVERY_UNAVAILABLE');
    assert.equal(ws.frames[0]?.sessionId, 'provider-resume-1');
  });
});

test('chat.send keeps blocking a resume owned by a discovered live pane', async () => {
  await withIsolatedDatabase(async () => {
    // Given: fresh discovery ties the persisted provider session to a live pane.
    sessionsDb.createSession('provider-live-1', 'claude', '/workspace/demo');
    let spawnCount = 0;
    const ws = new FakeWebSocket();
    handleChatConnection(
      ws as never,
      {} as never,
      dependencies(
        async () => ({ kind: 'blocked', tmuxName: 'live-pane' }),
        () => { spawnCount += 1; },
      ),
    );

    // When: the client asks to resume that session.
    await ws.receive({ type: 'chat.send', sessionId: 'provider-live-1', content: 'continue' });

    // Then: the existing duplicate-writer block still rejects the send.
    assert.equal(spawnCount, 0);
    assert.equal(ws.frames[0]?.kind, 'protocol_error');
    assert.equal(ws.frames[0]?.code, 'SESSION_LIVE_IN_TMUX');
  });
});

test('chat.send resumes when fresh discovery finds no live owner', async () => {
  await withIsolatedDatabase(async () => {
    // Given: fresh discovery proves no live pane owns the persisted provider session.
    sessionsDb.createSession('provider-clear-1', 'claude', '/workspace/demo');
    let spawnCount = 0;
    const ws = new FakeWebSocket();
    handleChatConnection(
      ws as never,
      {} as never,
      dependencies(async () => ({ kind: 'clear' }), () => { spawnCount += 1; }),
    );

    // When: the client asks to resume that session.
    await ws.receive({ type: 'chat.send', sessionId: 'provider-clear-1', content: 'continue' });

    // Then: the provider run starts as it did before the tri-state guard.
    assert.equal(spawnCount, 1);
    assert.equal(ws.frames.some((frame) => frame.kind === 'protocol_error'), false);
  });
});

test('chat.send starts a new session when fresh discovery is unavailable', async () => {
  await withIsolatedDatabase(async () => {
    // Given: an app session that has no provider-native session id yet.
    sessionsDb.createAppSession('app-new-1', 'claude', '/workspace/demo');
    let spawnCount = 0;
    let guardCount = 0;
    const ws = new FakeWebSocket();
    handleChatConnection(
      ws as never,
      {} as never,
      dependencies(
        async () => {
          guardCount += 1;
          return { kind: 'discovery_unavailable' };
        },
        () => { spawnCount += 1; },
      ),
    );

    // When: the client sends the first message.
    await ws.receive({ type: 'chat.send', sessionId: 'app-new-1', content: 'start' });

    // Then: discovery is irrelevant and the new provider run starts normally.
    assert.equal(guardCount, 0);
    assert.equal(spawnCount, 1);
    assert.equal(ws.frames.some((frame) => frame.kind === 'protocol_error'), false);
  });
});
