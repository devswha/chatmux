import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createTmuxFleetE2EHarness } from '@/modules/providers/tests/support/tmux-e2e-harness.js';

import { startFleetServers, stopFleetProcesses } from '../../../../scripts/cua/fleet-process-lifecycle.js';


const tmuxE2ESkip = process.platform === 'win32'
  ? 'Production tmux discovery is supported on Unix hosts.'
  : spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0
    && 'The real-tmux E2E harness requires tmux on PATH.';

test('fleet harness isolates two peers with colliding local identities', {
  skip: tmuxE2ESkip, timeout: 30_000, concurrency: false,
}, async (t) => {
  // Given: a cleanly bounded hub and two peer fixtures, plus unrelated dirty hooks.
  const dirtyHookPaths = [
    path.resolve('src/components/chat/hooks/useChatComposerState.ts'),
    path.resolve('src/components/chat/hooks/useChatSessionState.ts'),
  ];
  const dirtyHookContents = await Promise.all(dirtyHookPaths.map((filePath) => readFile(filePath)));
  const harness = await createTmuxFleetE2EHarness();
  let disposed = false;
  t.after(async () => {
    if (!disposed) await harness.dispose();
    assert.deepEqual(await Promise.all(dirtyHookPaths.map((filePath) => readFile(filePath))), dirtyHookContents);
  });
  const [peerAAgent, peerBAgent] = await harness.startCollisionPeers();
  const [peerAIdentity, peerBIdentity] = await Promise.all([
    harness.peers.a.tmuxIdentity(harness.collision.tmuxSessionName),
    harness.peers.b.tmuxIdentity(harness.collision.tmuxSessionName),
  ]);
  assert.deepEqual([harness.hub.hostId, harness.peers.a.hostId, harness.peers.b.hostId], [
    '2e0e6a2c-8ae7-4bd7-93b1-4cfcd26a4eb1', 'c4a35e5a-17bb-43a2-9b80-ef64c5d091c2',
    '8ef5ed72-4b11-45a3-9eea-e99eef389853',
  ]);
  assert.deepEqual(peerAIdentity, harness.collision.tmux);
  assert.deepEqual(peerBIdentity, harness.collision.tmux);
  for (const values of [
    [harness.hub.home, harness.peers.a.home, harness.peers.b.home],
    [harness.hub.databasePath, harness.peers.a.databasePath, harness.peers.b.databasePath],
    [harness.hub.socketPath, harness.peers.a.socketPath, harness.peers.b.socketPath],
    [harness.hub.tmuxTmpDir, harness.peers.a.tmuxTmpDir, harness.peers.b.tmuxTmpDir],
    [harness.hub.fakeAgentPath, harness.peers.a.fakeAgentPath, harness.peers.b.fakeAgentPath],
    [harness.hub.logRoot, harness.peers.a.logRoot, harness.peers.b.logRoot],
  ]) assert.equal(new Set<string | number>(values).size, 3);
  assert.equal(harness.peers.a.workspace, harness.peers.b.workspace);
  assert.equal(harness.peers.a.workspace, harness.collision.projectPath);
  assert.equal(harness.collision.providerSessionId, harness.collision.nativeSessionId);
  assert.equal(harness.collision.nativeSessionId, harness.collision.appSessionId);
  for (const node of [harness.hub, harness.peers.a, harness.peers.b]) {
    assert.ok(node.environment.PATH?.startsWith(`${node.fakeAgentPath}${path.delimiter}`));
  }
  assert.equal(peerAAgent.sessionId, harness.collision.providerSessionId);
  assert.equal(peerBAgent.sessionId, harness.collision.providerSessionId);

  // When: subscriptions are installed before input and interrupt target peer A.
  const peerBLogBefore = await readFile(peerBAgent.logPath);
  const peerAEvent = 'peer-a-only-event';
  const interruptObserved = peerAAgent.waitForInterrupt();
  await harness.peers.a.sendInterrupt(harness.collision.tmuxSessionName);
  await interruptObserved;
  const inputObserved = peerAAgent.waitForInput(peerAEvent);
  await harness.peers.a.sendInput(harness.collision.tmuxSessionName, peerAEvent);
  await inputObserved;
  const inputs = (await peerAAgent.events()).filter((event) => event.type === 'input');
  assert.deepEqual(inputs.at(-1), { type: 'input', value: peerAEvent });
  assert.equal((await peerAAgent.events()).filter((event) => event.type === 'interrupt').length, 1);
  // Then: peer B is byte-identical and all state is removable.
  assert.deepEqual(await readFile(peerBAgent.logPath), peerBLogBefore);
  const root = harness.root;
  await harness.dispose();
  disposed = true;
  await assert.rejects(stat(root));
});

test('fleet hub starts Cursor through its cursor-agent executable', {
  skip: tmuxE2ESkip, timeout: 15_000, concurrency: false,
}, async (t) => {
  // Given: an isolated fleet hub with only its fake-agent PATH.
  const harness = await createTmuxFleetE2EHarness();
  t.after(() => harness.dispose());
  // When: the hub starts the Cursor fixture.
  const cursor = await harness.hub.startFakeExternal('cursor', 'fleet-cursor');
  await cursor.waitUntilReady();
  // Then: the executable records readiness.
  assert.ok((await cursor.events()).some(({ type }) => type === 'ready'));
});

test('fleet fixture starts three independently healthy ChatMux server processes', {
  skip: tmuxE2ESkip, timeout: 90_000, concurrency: false,
}, async (t) => {
  // Given: three isolated nodes whose servers ask the OS for exclusive listeners.
  const harness = await createTmuxFleetE2EHarness();
  const processes = await startFleetServers(path.resolve('.'), [harness.hub, harness.peers.a, harness.peers.b]);
  t.after(async () => { await stopFleetProcesses(processes, null); await harness.dispose(); });
  // When: each declared health endpoint is addressed directly.
  const healthStatuses = await Promise.all(processes.map(async ({ url }) => (
    await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) })
  ).status));
  // Then: all listener PIDs are real, distinct, and healthy.
  assert.equal(new Set(processes.map(({ pid }) => pid)).size, 3);
  assert.equal(new Set(processes.map(({ port }) => port)).size, 3);
  assert.deepEqual(processes.map(({ listenerPid, pid }) => listenerPid === pid), [true, true, true]);
  assert.deepEqual(healthStatuses, [200, 200, 200]);
  await Promise.all(processes.map(({ pid }) => stat(`/proc/${pid}`)));
});


test('disposing concurrent fleet fixtures reaps only their owned processes and listeners', {
  skip: tmuxE2ESkip, timeout: 90_000, concurrency: false,
}, async () => {
  // Given: an operator snapshot and two complete, independently owned three-server fleets.
  const operatorBefore = spawnSync('tmux', ['list-sessions', '-F', '#{socket_path}\t#{pid}\t#{session_name}'], { encoding: 'utf8' }).stdout;
  const fixtures = await Promise.all([
    createTmuxFleetE2EHarness(),
    createTmuxFleetE2EHarness(),
  ]);
  const agents = await Promise.all(fixtures.map((fixture) => fixture.startCollisionPeers()));
  const serversByFixture = await Promise.all(fixtures.map((fixture) => startFleetServers(path.resolve('.'), [
    fixture.hub, fixture.peers.a, fixture.peers.b,
  ])));
  const servers = serversByFixture.flat();
  const readyPids = await Promise.all(agents.flat().map(async (agent) => (
    await agent.events()
  ).filter((event) => event.type === 'ready').map((event) => event.pid)));
  const tmuxPids = fixtures.flatMap((fixture) => [
    fixture.hub.tmuxServerPid, fixture.peers.a.tmuxServerPid, fixture.peers.b.tmuxServerPid,
  ]);
  const roots = fixtures.map(({ root }) => root);
  // When: server groups stop before both fixture roots are disposed.
  await Promise.all(serversByFixture.map((processes) => stopFleetProcesses(processes, null)));
  await Promise.all(fixtures.map((fixture) => fixture.dispose()));
  // Then: every exact owned PID/group/listener/root is gone and operator tmux is byte-identical.
  for (const pid of [...tmuxPids, ...readyPids.flat(), ...servers.flatMap(({ listenerPid, processGroupPid }) => [listenerPid, processGroupPid])]) {
    assert.throws(() => process.kill(pid, 0));
  }
  for (const processGroupId of [...tmuxPids, ...readyPids.flat(), ...servers.map(({ processGroupPid }) => processGroupPid)]) {
    assert.throws(() => process.kill(-processGroupId, 0));
  }
  await Promise.all(roots.map((root) => assert.rejects(stat(root))));
  await Promise.all(servers.map(({ url }) => assert.rejects(fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) }))));
  const operatorAfter = spawnSync('tmux', ['list-sessions', '-F', '#{socket_path}\t#{pid}\t#{session_name}'], { encoding: 'utf8' }).stdout;
  assert.equal(operatorAfter, operatorBefore);
});
