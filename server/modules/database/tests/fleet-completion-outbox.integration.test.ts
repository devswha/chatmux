import assert from 'node:assert/strict';
import test from 'node:test';

import { FleetCompletionOutboxRepository } from '@/modules/database/repositories/fleet-completion-outbox.js';
import {
  addSubscription,
  addUser,
  enableCompletionPreferences,
  enablePush,
  get,
  withDatabase,
} from '@/modules/database/tests/support/completion-notification-test-support.js';

import { parseFleetCompletionReady } from '../../../../shared/fleet-completion.js';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

function completion(hostId: string, hostLabel: string) {
  return parseFleetCompletionReady({
    version: 'completion/1',
    target: { kind: 'app', hostId, localId: 'same-session' },
    provider: 'claude', occurrenceKey: 'same-turn', preferenceClass: 'stop',
    hostLabel, sessionLabel: 'Same agent',
  });
}

test('Given two peers complete identical IDs simultaneously, when recorded, then outbox tags and routes stay distinct', () => {
  withDatabase((db) => {
    addUser(db, 1); addSubscription(db, 1); enableCompletionPreferences(db, 1); enablePush(db, 1);
    const repository = new FleetCompletionOutboxRepository(db);

    const first = repository.record(1, completion(HOST_A, 'studio-a'), 100);
    const second = repository.record(1, completion(HOST_B, 'studio-b'), 100);

    assert.equal(first.kind, 'created');
    assert.equal(second.kind, 'created');
    const rows = db.prepare(`SELECT decision_key, payload_json, notification_tag
      FROM completion_notification_outbox ORDER BY id`).all() as Array<{
        decision_key: string; payload_json: string; notification_tag: string;
      }>;
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]?.decision_key, rows[1]?.decision_key);
    assert.notEqual(rows[0]?.notification_tag, rows[1]?.notification_tag);
    assert.deepEqual(rows.map(({ payload_json }) => {
      const payload = JSON.parse(payload_json) as { body: string; navigation: { href: string; hostId: string } };
      return [payload.body, payload.navigation.href, payload.navigation.hostId];
    }), [
      ['studio-a · Claude: Reply ready', `/hosts/${HOST_A}/session/same-session`, HOST_A],
      ['studio-b · Claude: Reply ready', `/hosts/${HOST_B}/session/same-session`, HOST_B],
    ]);
  });
});

test('Given a peer replays a completion after reconnect, when recorded, then the durable decision is reused once', () => {
  withDatabase((db) => {
    addUser(db, 1); addSubscription(db, 1); enableCompletionPreferences(db, 1); enablePush(db, 1);
    const repository = new FleetCompletionOutboxRepository(db);
    const event = completion(HOST_A, 'studio-a');

    const created = repository.record(1, event, 100);
    const replay = repository.record(1, event, 200);

    assert.deepEqual(replay, { kind: 'replay', decisionIds: created.decisionIds });
    assert.equal(get<{ count: number }>(db, 'SELECT count(*) AS count FROM completion_notification_outbox')?.count, 1);
  });
});

test('Given central push is disabled, when a peer completion arrives, then no decision is persisted', () => {
  withDatabase((db) => {
    addUser(db, 1); addSubscription(db, 1); enableCompletionPreferences(db, 1);

    assert.deepEqual(new FleetCompletionOutboxRepository(db).record(1, completion(HOST_A, 'studio-a'), 100), {
      kind: 'ignored', decisionIds: [],
    });
  });
});
