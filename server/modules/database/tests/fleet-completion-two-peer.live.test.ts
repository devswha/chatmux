import assert from 'node:assert/strict';
import test from 'node:test';

import { FleetCompletionOutboxRepository } from '@/modules/database/repositories/fleet-completion-outbox.js';
import {
  createFleetCompletionHubAdapter,
  FleetCompletionPeerPublisher,
} from '@/modules/fleet/index.js';

import {
  addSubscription,
  addUser,
  enableCompletionPreferences,
  enablePush,
  withDatabase,
} from './support/completion-notification-test-support.js';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

function emit(publisher: FleetCompletionPeerPublisher): void {
  publisher.app({
    provider: 'claude', localId: 'identical-session', occurrenceKey: 'identical-turn',
    sessionLabel: 'Identical agent',
  });
}

test('Given two live peer publishers share every local completion ID, when both emit, then the hub creates two routes and outbox tags', () => {
  withDatabase((db) => {
    addUser(db, 1); addSubscription(db, 1); enableCompletionPreferences(db, 1); enablePush(db, 1);
    const repository = new FleetCompletionOutboxRepository(db);
    const states = new Map([
      [HOST_A, { state: 'online' as const, capabilities: ['completion.event'] as const }],
      [HOST_B, { state: 'online' as const, capabilities: ['completion.event'] as const }],
    ]);
    const labels = new Map([[HOST_A, 'studio-a'], [HOST_B, 'studio-b']]);
    const adapter = createFleetCompletionHubAdapter({
      status: (hostId) => states.get(hostId), hostLabel: (hostId) => labels.get(hostId),
      ownerId: () => 1, record: (ownerId, event, now) => repository.record(ownerId, event, now),
      wake: () => undefined, now: () => 100,
    });
    const peerA = new FleetCompletionPeerPublisher(HOST_A, 'untrusted-a');
    const peerB = new FleetCompletionPeerPublisher(HOST_B, 'untrusted-b');
    const releaseA = peerA.subscribe((event) => { adapter.accept(HOST_A, event); });
    const releaseB = peerB.subscribe((event) => { adapter.accept(HOST_B, event); });
    try {
      emit(peerA);
      emit(peerB);
    } finally {
      releaseA();
      releaseB();
    }

    const rows = db.prepare(`SELECT notification_tag, payload_json FROM completion_notification_outbox
      ORDER BY id`).all() as Array<{ notification_tag: string; payload_json: string }>;
    assert.equal(new Set(rows.map(({ notification_tag }) => notification_tag)).size, 2);
    assert.deepEqual(rows.map(({ payload_json }) => {
      const payload = JSON.parse(payload_json) as { navigation: { href: string } };
      return payload.navigation.href;
    }), [
      `/hosts/${HOST_A}/session/identical-session`,
      `/hosts/${HOST_B}/session/identical-session`,
    ]);
  });
});
