import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { unwrapClaudePastedContent } from '@/modules/providers/list/claude/claude-transcript-content.js';

test('Claude pasted-content envelopes expose only their user-visible text', () => {
  const observed = '\n\n<pasted_content id="5c52">\n같은 방법을 pose Q20에 적용해서 확인해보자.\n</pasted_content id="5c52">\n';
  assert.equal(
    unwrapClaudePastedContent(observed),
    '같은 방법을 pose Q20에 적용해서 확인해보자.',
  );

  const multiple = [
    'before',
    '<pasted_content id="first_1">',
    'first pasted block',
    '</pasted_content id="first_1">',
    'between',
    '<pasted_content id="second-2">',
    'second pasted block',
    '</pasted_content id="second-2">',
    'after',
  ].join('\n');
  assert.equal(
    unwrapClaudePastedContent(multiple),
    ['before', 'first pasted block', 'between', 'second pasted block', 'after'].join('\n'),
  );
});

test('Claude pasted-content envelopes fail closed when their ids do not match', () => {
  const malformed = '<pasted_content id="first">\nkeep this literal\n</pasted_content id="second">';
  assert.equal(unwrapClaudePastedContent(malformed), malformed);
});

test('Claude message normalization hides native pasted-content markup', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'pasted-user-message',
    timestamp: '2026-09-19T13:56:30.703Z',
    message: {
      role: 'user',
      content: '\n\n<pasted_content id="5c52">\nvisible prompt\n</pasted_content id="5c52">\n',
    },
  }, 'claude-session');

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, 'user');
  assert.equal(messages[0]?.content, 'visible prompt');
});

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-provider-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('claude history starts after the latest tagged /clear command', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-session-clear-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const sessionId = 'claude-clear-history';
  const transcriptPath = path.join(tempRoot, `${sessionId}.jsonl`);
  const clearCommand = '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>';
  const rows = [
    { type: 'user', uuid: 'old-user', timestamp: '2026-07-09T00:00:01.000Z', sessionId, message: { role: 'user', content: [{ type: 'text', text: 'Old question' }] } },
    // A slightly later timestamp before the boundary proves file order, not
    // clock order, owns `/clear` segmentation.
    { type: 'assistant', uuid: 'old-assistant', timestamp: '2026-07-09T00:00:03.100Z', sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'Old answer' }] } },
    { type: 'user', uuid: 'clear-one', timestamp: '2026-07-09T00:00:03.000Z', sessionId, userType: 'external', message: { role: 'user', content: clearCommand } },
    { type: 'user', uuid: 'middle-user', timestamp: '2026-07-09T00:00:04.000Z', sessionId, message: { role: 'user', content: [{ type: 'text', text: 'Middle question' }] } },
    { type: 'user', uuid: 'clear-two', timestamp: '2026-07-09T00:00:05.000Z', sessionId, userType: 'external', message: { role: 'user', content: clearCommand } },
    { type: 'user', uuid: 'new-user', timestamp: '2026-07-09T00:00:06.000Z', sessionId, message: { role: 'user', content: [{ type: 'text', text: 'Explain /clear without running it' }] } },
    { type: 'assistant', uuid: 'new-assistant', timestamp: '2026-07-09T00:00:07.000Z', sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'New answer' }] } },
  ];
  await writeFile(transcriptPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(
        sessionId,
        'claude',
        workspacePath,
        undefined,
        undefined,
        undefined,
        transcriptPath,
      );
      const provider = new ClaudeSessionsProvider();

      const newest = await provider.fetchHistory(sessionId, { limit: 1 });
      assert.equal(newest.historyEpoch, 'claude:clear-two');
      assert.equal(newest.total, 2);
      assert.equal(newest.hasMore, true);
      assert.deepEqual(newest.messages.map(message => message.content), ['New answer']);

      const older = await provider.fetchHistory(sessionId, { limit: 1, offset: 1 });
      assert.equal(older.historyEpoch, 'claude:clear-two');
      assert.equal(older.hasMore, false);
      assert.deepEqual(older.messages.map(message => message.content), ['Explain /clear without running it']);

      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'user',
        uuid: 'clear-three',
        timestamp: '2026-07-09T00:00:08.000Z',
        sessionId,
        userType: 'external',
        message: { role: 'user', content: clearCommand },
      })}\n`, 'utf8');
      const empty = await provider.fetchHistory(sessionId);
      assert.equal(empty.historyEpoch, 'claude:clear-three');
      assert.equal(empty.total, 0);
      assert.equal(empty.hasMore, false);
      assert.deepEqual(empty.messages, []);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
