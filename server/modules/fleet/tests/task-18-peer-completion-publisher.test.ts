import assert from 'node:assert/strict';
import test from 'node:test';

import { FleetCompletionPeerPublisher } from '@/modules/fleet/completion/peer-publisher.js';

const HOST = '11111111-1111-4111-8111-111111111111';

test('Given app and pane completions, when a peer publishes, then only redacted typed identity crosses the fleet boundary', () => {
  const bodies: unknown[] = [];
  const publisher = new FleetCompletionPeerPublisher(HOST, 'studio');
  const release = publisher.subscribe((body) => { bodies.push(body); });

  publisher.app({ provider: 'claude', localId: 'session', occurrenceKey: 'turn-app', sessionLabel: 'Agent' });
  publisher.pane({
    provider: 'claude', lane: 'external', appLocalId: 'session', occurrenceKey: 'turn-pane',
    sessionLabel: 'Agent', tmux: { sessionId: '$1', windowId: '@1', paneId: '%1' },
    process: { pid: 42, startedAtMs: 100 },
  });
  release();
  publisher.app({ provider: 'claude', localId: 'ignored', occurrenceKey: 'later', sessionLabel: null });

  assert.deepEqual(bodies, [
    {
      version: 'completion/1', target: { kind: 'app', hostId: HOST, localId: 'session' },
      provider: 'claude', occurrenceKey: 'turn-app', preferenceClass: 'stop',
      hostLabel: 'studio', sessionLabel: 'Agent',
    },
    {
      version: 'completion/1',
      target: {
        kind: 'pane_generation', hostId: HOST, lane: 'external', appLocalId: 'session',
        tmux: { sessionId: '$1', windowId: '@1', paneId: '%1' },
        process: { pid: 42, startedAtMs: 100 },
      },
      provider: 'claude', occurrenceKey: 'turn-pane', preferenceClass: 'liveStop',
      hostLabel: 'studio', sessionLabel: 'Agent',
    },
  ]);
  assert.equal(JSON.stringify(bodies).includes('/home/'), false);
});
