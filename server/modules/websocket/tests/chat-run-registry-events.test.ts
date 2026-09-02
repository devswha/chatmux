import assert from 'node:assert/strict';
import test from 'node:test';

import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';

class Connection {
  readonly readyState = 1;
  send(): void {}
}

test('Given an event subscriber, when a run streams and completes, then sequenced events publish exactly once', () => {
  // Given
  chatRunRegistry.clearAll();
  const observed: Array<{ readonly sessionId: string; readonly seq?: number; readonly content?: string }> = [];
  const unsubscribe = chatRunRegistry.subscribeEvents((event) => observed.push(event));
  const run = chatRunRegistry.startRun({
    appSessionId: 'remote-stream', provider: 'codex', providerSessionId: null,
    connection: new Connection(), userId: null,
  });
  assert.ok(run);

  // When
  run.writer.send({ kind: 'stream_delta', provider: 'codex', sessionId: 'native', content: 'one' });
  run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native', exitCode: 0 });
  unsubscribe();
  run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native', exitCode: 1 });

  // Then
  assert.deepEqual(observed.map(({ sessionId, seq, content }) => ({ sessionId, seq, content })), [
    { sessionId: 'remote-stream', seq: 1, content: 'one' },
    { sessionId: 'remote-stream', seq: 2, content: undefined },
  ]);
  chatRunRegistry.clearAll();
});

test('Given a processing subscriber, when runs materially mutate, then notifications are exact and unsubscribe is final', () => {
  chatRunRegistry.clearAll();
  const observed: number[] = [];
  const unsubscribe = chatRunRegistry.subscribeProcessing(() => observed.push(chatRunRegistry.listRunningRuns()[0]?.lastSeq ?? -1));
  const run = chatRunRegistry.startRun({ appSessionId: 'events', provider: 'codex', providerSessionId: null, connection: new Connection(), userId: null });
  assert.ok(run);
  assert.equal(chatRunRegistry.startRun({ appSessionId: 'events', provider: 'codex', providerSessionId: null, connection: new Connection(), userId: null }), null);
  run.writer.send({ kind: 'text', provider: 'codex', sessionId: 'native', content: 'one' });
  run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native', exitCode: 0 });
  run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native', exitCode: 1 });
  assert.deepEqual(observed, [0, 1, -1]);
  unsubscribe();
  chatRunRegistry.startRun({ appSessionId: 'after-release', provider: 'codex', providerSessionId: null, connection: new Connection(), userId: null });
  assert.deepEqual(observed, [0, 1, -1]);
  chatRunRegistry.clearAll();
});

test('Given a throwing event subscriber, when a run streams, then the other subscriber and the run itself are unaffected', () => {
  chatRunRegistry.clearAll();
  const observed: Array<{ readonly seq?: number }> = [];
  const unsubscribeBad = chatRunRegistry.subscribeEvents(() => { throw new Error('listener bug'); });
  const unsubscribeGood = chatRunRegistry.subscribeEvents((event) => observed.push(event));
  const run = chatRunRegistry.startRun({
    appSessionId: 'listener-isolation', provider: 'codex', providerSessionId: null,
    connection: new Connection(), userId: null,
  });
  assert.ok(run);
  try {
    assert.doesNotThrow(() => run.writer.send({ kind: 'stream_delta', provider: 'codex', sessionId: 'native', content: 'one' }));
    assert.doesNotThrow(() => run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native', exitCode: 0 }));
    assert.deepEqual(observed.map(({ seq }) => seq), [1, 2], 'the healthy subscriber still receives every event');
  } finally {
    unsubscribeBad();
    unsubscribeGood();
    chatRunRegistry.clearAll();
  }
});
