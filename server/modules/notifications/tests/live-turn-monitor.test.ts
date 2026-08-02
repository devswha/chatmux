import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveTurnMonitor, findAssistantTurnEnds } from '@/modules/notifications/services/live-turn-monitor.service.js';

const line = (reason: 'stop' | 'error' = 'stop') => JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: reason } });
const askLine = () => JSON.stringify({
  type: 'message',
  message: {
    role: 'assistant',
    stopReason: 'toolUse',
    content: [{ type: 'toolCall', name: 'ask', id: 'ask-1', arguments: { question: 'Continue?' } }],
  },
});
function harness() {
  let text = ''; let available = true; let rows: Array<any> = [{ id: 's1', tmuxName: 'pane', claim: 'lineage' }];
  const notices: any[] = []; const actionNotices: any[] = []; const diagnostics: any[] = []; let failStop = false;
  const monitor = createLiveTurnMonitor({
    getUserId: () => 1,
    getDetailed: async () => ({ ok: available, sessions: rows, transcriptPaths: new Map(rows.filter((row) => row.id !== 'no-path').map((row) => [row.id, `/tmp/${row.id}`])) }),
    statSize: async () => Buffer.byteLength(text), readDelta: async (_path, start, end) => Buffer.from(text).subarray(start, end).toString(),
    notify: async (notice) => { notices.push(notice); if (failStop && notice.stopReason === 'stop') throw new Error('outbox unavailable'); },
    notifyActionRequired: async (notice) => { actionNotices.push(notice); },
    diagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
  });
  return { monitor, notices, actionNotices, diagnostics, append: (value: string) => { text += value; }, rows: (value: any[]) => { rows = value; }, available: (value: boolean) => { available = value; }, failStop: (value: boolean) => { failStop = value; } };
}

test('findAssistantTurnEnds preserves stable occurrence order and ignores incomplete or non-terminal records', () => {
  assert.deepEqual(findAssistantTurnEnds(`${line()}\n${line('error')}\n`), ['stop', 'error']);
  assert.deepEqual(findAssistantTurnEnds(`${JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse' } })}\n{`), []);
});

test('monitor baselines then emits a byte-stable occurrence key for each appended completion', async () => {
  const h = harness(); await h.monitor.tick();
  h.append(`${line()}\n`); await h.monitor.tick();
  const first = h.notices[0]; await h.monitor.tick();
  assert.equal(h.notices.length, 1);
  assert.match(first.occurrenceKey, /^gjc:s1:\d+:[a-f0-9]{64}$/);
  h.append(`${line()}\n`); await h.monitor.tick();
  assert.equal(h.notices.length, 2);
  assert.notEqual(h.notices[1].occurrenceKey, first.occurrenceKey);
});

test('monitor baselines old prompts and emits one action event for each appended GJC ask', async () => {
  const h = harness();
  h.append(`${askLine()}\n`);
  await h.monitor.tick();
  assert.equal(h.actionNotices.length, 0, 'historical INPUT is not replayed');

  h.append(`${askLine()}\n`);
  await h.monitor.tick();
  await h.monitor.tick();
  assert.deepEqual(
    { ...h.actionNotices[0], occurrenceKey: typeof h.actionNotices[0]?.occurrenceKey },
    { userId: 1, sessionId: 's1', tmuxName: 'pane', occurrenceKey: 'string' },
  );
  assert.match(h.actionNotices[0]?.occurrenceKey ?? '', /^gjc:s1:\d+:[a-f0-9]{64}$/);

  h.append(`${line()}\n${askLine()}\n`);
  await h.monitor.tick();
  assert.notEqual(h.actionNotices[0]?.occurrenceKey, h.actionNotices[1]?.occurrenceKey);
  assert.equal(h.actionNotices.length, 2);
});

test('a failed completion notification retries the same post-commit cursor occurrence', async () => {
  const h = harness(); await h.monitor.tick(); h.append(`${line()}\n`); h.failStop(true); await h.monitor.tick();
  const failed = h.notices.at(-1).occurrenceKey;
  h.failStop(false); await h.monitor.tick();
  assert.equal(h.notices.at(-1).occurrenceKey, failed);
  assert.equal(h.notices.length, 2);
});

test('error terminators do not create completion retries', async () => {
  const h = harness(); await h.monitor.tick(); h.append(`${line('error')}\n`); await h.monitor.tick();
  assert.equal(h.notices[0].stopReason, 'error');
  await h.monitor.tick(); assert.equal(h.notices.length, 1);
});
test('unavailable discovery preserves cursors and emits a rate-limited diagnostic', async () => {
  const h = harness();
  await h.monitor.tick();
  h.available(false);
  await h.monitor.tick();
  await h.monitor.tick();
  assert.deepEqual(h.diagnostics, [{ code: 'discovery_unavailable', count: 1 }]);
  assert.equal(h.monitor.cursorCount(), 1);

  h.append(`${line()}\n`);
  h.available(true);
  await h.monitor.tick();
  assert.equal(h.notices.length, 1);
});

test('disappearance and manual interruption silently retire cursors without a final sweep', async () => {
  const h = harness(); await h.monitor.tick(); h.append(`${line()}\n`); h.rows([]); await h.monitor.tick();
  assert.equal(h.notices.length, 0); assert.equal(h.monitor.cursorCount(), 0);
});

test('retiring a session clears its per-session diagnostic throttle', async () => {
  let present = true;
  const diagnostics: Array<{ code: string; count: number }> = [];
  const monitor = createLiveTurnMonitor({
    getUserId: () => 1,
    getDetailed: async () => ({
      ok: true,
      sessions: present ? [{ id: 's1', tmuxName: 'pane', claim: 'lineage' as const }] : [],
      transcriptPaths: present ? new Map([['s1', '/tmp/s1']]) : new Map<string, string>(),
    }),
    statSize: async () => { throw new Error('unavailable'); },
    notify: async () => {},
    diagnostic: (event) => { diagnostics.push(event); },
  });

  await monitor.tick();
  present = false;
  await monitor.tick();
  present = true;
  await monitor.tick();
  assert.deepEqual(diagnostics.map(({ code, count }) => ({ code, count })), [
    { code: 'transcript_unavailable', count: 1 },
    { code: 'transcript_unavailable', count: 2 },
  ]);
});

test('omits cwd, idle, and transcript-pathless rows', async () => {
  const h = harness();
  h.rows([{ id: 'cwd', tmuxName: 'pane', claim: 'cwd' }, { id: 'idle-gjc:1', tmuxName: 'pane', claim: 'lineage' }, { id: 'no-path', tmuxName: 'pane', claim: 'lineage' }]);
  await h.monitor.tick(); h.append(`${line()}\n`); await h.monitor.tick();
  assert.equal(h.notices.length, 0); assert.equal(h.monitor.cursorCount(), 0);
});
