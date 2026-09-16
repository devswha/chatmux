import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  type DiscoveryCollector,
  type DiscoveryRow,
  type VerifiedTmuxActionTarget,
} from '@/modules/providers/index.js';

import { FleetReadRpcError } from '../rpc/reads/errors.js';
import { resolveFreshSessionReadTarget } from '../rpc/reads/local-services.js';

const tmux = { socketPath: '/tmp/binding-read.sock', sessionId: '$1', windowId: '@1', paneId: '%1' };
const generation = { pid: 4242, startedAtMs: 1234 };
const unproven = [null, undefined, 'inferred', 'unknown', '', 'TAGGED', true, {}, ['observed']];

before(async () => { await initializeDatabase(); });

function fixture(provider: 'codex' | 'gjc') {
  const nativeId = `native-read-${provider}`;
  const sessionId = sessionsDb.createSession(nativeId, provider, '/tmp', 'Binding read fixture');
  const row: DiscoveryRow = {
    key: 'read-fixture-row', lane: provider === 'gjc' ? 'live' : 'external', tmuxName: 'fixture',
    tmux, process: generation, kind: provider, providerSessionId: nativeId, binding: 'tagged',
    activity: 'unknown', cwd: '/tmp', lastSeenRevision: 1, presence: 'present', staleSinceRevision: null,
  };
  let rows = [row];
  const discovery = {
    ensureFresh: async () => {}, currentSnapshot: () => ({ rows }),
  } as unknown as DiscoveryCollector;
  const verify = async (candidate: DiscoveryRow): Promise<VerifiedTmuxActionTarget> => ({
    tmux: candidate.tmux,
    process: candidate.process ?? generation,
    kind: candidate.kind as 'codex' | 'gjc',
    tmuxName: candidate.tmuxName,
    providerSessionId: candidate.providerSessionId,
    binding: candidate.binding ?? null,
  } as VerifiedTmuxActionTarget);
  return {
    sessionId,
    resolve: () => resolveFreshSessionReadTarget(discovery, sessionId, verify),
    setRows: (value: DiscoveryRow[]) => { rows = value; },
    row,
  };
}

function isReadError(error: unknown, code: FleetReadRpcError['code']): boolean {
  return error instanceof FleetReadRpcError && error.code === code;
}

for (const provider of ['codex', 'gjc'] as const) {
  test(`${provider} fleet session reads require a unique proven pane before returning approval UI`, async () => {
    const f = fixture(provider);
    assert.equal((await f.resolve()).providerSessionId, `native-read-${provider}`);

    for (const binding of unproven) {
      f.setRows([{ ...f.row, binding: binding as DiscoveryRow['binding'] }]);
      await assert.rejects(f.resolve(), (error: unknown) => isReadError(error, 'FLEET_CAPABILITY_UNAVAILABLE'));
    }

    f.setRows([{ ...f.row, binding: 'observed' }]);
    assert.equal((await f.resolve()).binding, 'observed');
  });
}

test('fleet session reads reject a cross-provider or ambiguous pane', async () => {
  const f = fixture('codex');
  f.setRows([{ ...f.row, kind: 'gjc', lane: 'live' }]);
  await assert.rejects(f.resolve(), (error: unknown) => isReadError(error, 'HOST_NOT_FOUND'));

  f.setRows([f.row, { ...f.row, tmux: { ...tmux, paneId: '%2' } }]);
  await assert.rejects(f.resolve(), (error: unknown) => isReadError(error, 'HOST_NOT_FOUND'));
});

test('fleet session reads refuse a session with no native provider identity', async () => {
  const f = fixture('gjc');
  getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(f.sessionId);
  await assert.rejects(f.resolve(), (error: unknown) => isReadError(error, 'FLEET_CAPABILITY_UNAVAILABLE'));
});
