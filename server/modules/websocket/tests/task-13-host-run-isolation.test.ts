import assert from 'node:assert/strict';
import test from 'node:test';

import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const REMOTE = '22222222-2222-4222-8222-222222222222';

test('Given equal session IDs on two hosts, when replay and abort target one host, then run state remains isolated', () => {
  // Given
  const connection = { readyState: 1, send: (_payload: string): void => {} };
  chatRunRegistry.clearAll();
  const local = chatRunRegistry.startRun({ appSessionId: 'collision', hostId: LOCAL, provider: 'codex', providerSessionId: null, connection, userId: null });
  const remote = chatRunRegistry.startRun({ appSessionId: 'collision', hostId: REMOTE, provider: 'codex', providerSessionId: null, connection, userId: null });
  assert.ok(local); assert.ok(remote);
  local.writer.send({ kind: 'text', provider: 'codex', sessionId: 'native', content: 'local-only' });
  remote.writer.send({ kind: 'text', provider: 'codex', sessionId: 'native', content: 'remote-only' });

  // When
  chatRunRegistry.completeRun('collision', { exitCode: 0, aborted: true }, REMOTE);

  // Then
  assert.equal(chatRunRegistry.isProcessing('collision', LOCAL), true);
  assert.equal(chatRunRegistry.isProcessing('collision', REMOTE), false);
  assert.deepEqual(chatRunRegistry.replayEvents('collision', 0, LOCAL).map((event) => event.content), ['local-only']);
  assert.deepEqual(chatRunRegistry.replayEvents('collision', 0, REMOTE).map((event) => event.content), ['remote-only', undefined]);
  chatRunRegistry.clearAll();
});
