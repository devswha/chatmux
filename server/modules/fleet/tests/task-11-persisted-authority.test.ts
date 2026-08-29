import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { FleetMutationRpcError, createFleetMutationHandlers, createPersistedMutationAuthority, type FleetMutationServices, type MutationActionTarget } from '../rpc/mutations/index.js';

const HOST = '123e4567-e89b-42d3-a456-426614174000';
const session = { kind: 'session', hostId: HOST, localId: 'same-session' } as const;
const verified: MutationActionTarget = { token: 'verified' };
function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE fleet_hub_grants (peer_id TEXT NOT NULL, grant_state TEXT NOT NULL);');
  db.prepare('INSERT INTO app_config VALUES (?, ?)').run(`fleet.peer.connection-generation.${HOST}`, '7');
  db.prepare('INSERT INTO fleet_hub_grants VALUES (?, ?)').run(HOST, 'active');
  return db;
}
function request() { return { kind: 'request', protocolVersion: 'fleet/1', connectionGeneration: 7, requestId: 'persisted-race', operation: 'chat.send', target: session, body: { deadlineAtMs: 9_000, message: 'never-send' } } as const; }

test('Given the persisted final-check adapter is pending, when its grant is revoked or generation superseded, then release rejects before action', async () => {
  for (const race of ['revoke', 'supersede'] as const) {
    const db = database(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let actions = 0;
    const authority = createPersistedMutationAuthority({ db, localHostId: HOST, beforeRead: async () => { entered.resolve(); await release.promise; } });
    const action = async (): Promise<void> => { actions += 1; };
    const services: FleetMutationServices = { verifySession: async () => verified, verifyPane: async () => verified, verifySpawn: async () => ({ cwd: '/home/peer' }), finalCheck: (value) => authority.assertCurrent(value), send: action, abort: action, interrupt: action, escape: action, respondPrompt: async () => { await action(); return null; }, respondApproval: action, spawn: async () => { await action(); return null; }, terminateProcess: action, terminatePane: action, terminateSession: action };
    const handler = createFleetMutationHandlers(HOST, services, () => 1_000)['chat.send']; if (handler === undefined) throw new TypeError('chat handler missing');
    const pending = handler(request()); await entered.promise;
    if (race === 'revoke') db.prepare("UPDATE fleet_hub_grants SET grant_state = 'revoked'").run(); else db.prepare('UPDATE app_config SET value = ?').run('8');
    release.resolve();
    await assert.rejects(pending, (error) => error instanceof FleetMutationRpcError && error.code === (race === 'revoke' ? 'HOST_REVOKED' : 'FLEET_STALE_GENERATION'));
    assert.equal(actions, 0); db.close();
  }
});
