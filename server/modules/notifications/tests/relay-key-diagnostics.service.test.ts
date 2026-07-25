import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRelayKeyDiagnosticEmitter,
  type RelayKeyDiagnostic,
} from '@/modules/notifications/services/relay-key-diagnostics.service.js';

test('relay key diagnostics have a sensitive-data-free payload and rate limit across emitters', () => {
  const events: RelayKeyDiagnostic[] = [];
  let now = 0;
  const sink = (event: RelayKeyDiagnostic) => events.push(event);
  const firstConnection = createRelayKeyDiagnosticEmitter(sink, () => now);
  const secondConnection = createRelayKeyDiagnosticEmitter(sink, () => now);

  firstConnection('relay_key_sent', 'codex');
  secondConnection('relay_key_sent', 'codex');
  assert.deepEqual(events, [{ code: 'relay_key_sent', provider: 'codex', count: 1 }]);
  assert.deepEqual(Object.keys(events[0]!).sort(), ['code', 'count', 'provider']);
  assert.equal(JSON.stringify(events).includes('/tmp/tmux.sock'), false);
  assert.equal(JSON.stringify(events).includes('company-secret'), false);

  now += 60_000;
  secondConnection('relay_key_sent', 'codex');
  assert.deepEqual(events, [
    { code: 'relay_key_sent', provider: 'codex', count: 1 },
    { code: 'relay_key_sent', provider: 'codex', count: 3 },
  ]);
});
