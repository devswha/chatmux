import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';

import { WebSocket } from 'ws';

import { startTask23Fleet } from './support/task-23-driver.js';

const tmuxE2ESkip = process.platform === 'win32'
  ? 'Production tmux discovery is supported on Unix hosts.'
  : spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0
    && 'The real-tmux E2E harness requires tmux on PATH.';

const EVIDENCE_DIR = process.env.TASK23_EVIDENCE_DIR
  ?? path.resolve('.omo/evidence/multi-pc-session-management/wave-4/task-23/task-23-two-peer-e2e');
const HOOKS = [
  'src/components/chat/hooks/useChatComposerState.ts',
  'src/components/chat/hooks/useChatSessionState.ts',
];
const TERM_NAMES = ['term-proc', 'term-pane', 'term-sess'] as const;

type Frame = Readonly<Record<string, unknown>>;
function armFile(directory: string, prefix: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, (_event, file) => { if (file?.toString().startsWith(prefix)) finish(file.toString()); });
    const timeout = setTimeout(() => { watcher.close(); reject(new Error(`file signal timed out: ${prefix}`)); }, 15_000);
    const finish = (file: string) => { clearTimeout(timeout); watcher.close(); resolve(file); };
    watcher.once('error', (error) => { clearTimeout(timeout); watcher.close(); reject(error); });
  });
}

function openRemoteShell(url: string): Readonly<{
  send: (frame: Frame) => Promise<void>;
  waitFor: (predicate: (frame: Frame) => boolean, label: string) => Promise<Frame>;
  close: () => void;
}> {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  const waiters: Array<{ predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as Frame;
    frames.push(frame);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter !== undefined && waiter.predicate(frame)) {
        waiters.splice(index, 1);
        waiter.resolve(frame);
      }
    }
  });
  const opened = new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const waitFor = async (predicate: (frame: Frame) => boolean, label: string): Promise<Frame> => {
    await opened;
    const existing = frames.find(predicate);
    if (existing !== undefined) return existing;
    return new Promise<Frame>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`remote-shell wait timed out: ${label}`)), 45_000);
      waiters.push({ predicate, resolve: (frame) => { clearTimeout(timeout); resolve(frame); } });
    });
  };
  return {
    send: async (frame) => {
      await opened;
      ws.send(JSON.stringify(frame));
    },
    waitFor,
    close: () => ws.close(),
  };
}

test('task-23 terminal, spawn, termination, and pane respawn stay on the addressed peer', {
  skip: tmuxE2ESkip, timeout: 420_000, concurrency: false,
}, async (t) => {
  const hookBefore = await Promise.all(HOOKS.map((file) => readFile(path.resolve(file))));
  const fleet = await startTask23Fleet({ evidenceDir: EVIDENCE_DIR });
  after(async () => {
    await fleet.dispose();
    assert.deepEqual(await Promise.all(HOOKS.map((file) => readFile(path.resolve(file)))), hookBefore);
  });
  const { harness } = fleet;
  const { collision } = harness;
  const catalogA = await fleet.awaitCatalog(fleet.hostIds.a, (snap) => snap.sessions.length > 0, 'peer A catalog');
  await fleet.awaitPeerState(fleet.hostIds.b, 'online');
  const paneA = catalogA.panes.find((row) => row.tmuxName === collision.tmuxSessionName && row.process !== null);
  assert.ok(paneA !== undefined && paneA.process !== null);
  const targetA = { localId: paneA.localId, lane: paneA.lane, tmux: paneA.tmux, process: paneA.process };
  const logBBefore = await fleet.agentLogText(fleet.agents.b);

  await t.test('remote attach streams peer A output and forwards input and resize', async () => {
    // Given: an armed remote-shell socket addressed at peer A's collision pane.
    const shell = openRemoteShell(`${fleet.servers.hub.url.replace('http', 'ws')}/remote-shell`);
    t.after(() => shell.close());
    const attachReply = shell.waitFor((frame) => frame.type === 'replay_start' || frame.type === 'error', 'attach reply');
    const output = shell.waitFor((frame) => frame.type === 'output' && String(frame.data).includes('ChatMux CUA fixture ready'), 'pane output');
    await shell.send({
      type: 'init', shellProtocolVersion: 2, mode: 'remote-attach',
      target: { kind: 'pane', hostId: fleet.hostIds.a, ...targetA }, cols: 100, rows: 30, resume: null,
    });
    // Then: the attach replays peer A's pane, carries typed input, and survives resize.
    const attach = await attachReply;
    assert.equal(attach.type, 'replay_start', JSON.stringify(attach));
    await output;
    const marker = 'terminal-alpha-line';
    const observed = fleet.agents.a.waitForInput(marker);
    await shell.send({ type: 'input', data: `${marker}\r` });
    await observed;
    const settled = fleet.agents.a.waitForInput(`${marker}-after-resize`);
    await shell.send({ type: 'resize', cols: 120, rows: 40 });
    await shell.send({ type: 'input', data: `${marker}-after-resize\r` });
    await settled;
    const dimensions = (await fleet.tmux(harness.peers.a, ['display-message', '-p', '-t', `=${collision.tmuxSessionName}:`, '#{pane_width}x#{pane_height}'])).trim();
    assert.equal(dimensions, '120x39', 'tmux reserves one requested row for its status line');
    const closed = shell.waitFor((frame) => frame.type === 'remote_closed' && frame.reason === 'closed', 'closed attachment');
    await shell.send({ type: 'close' });
    await closed;
    assert.equal(await fleet.agentLogText(fleet.agents.b), logBBefore);
    assert.deepEqual(await fleet.tmuxSessions(harness.hub), ['fleet-bootstrap']);
    await fleet.record('terminal-assertions', { attach: attach.type, dimensions, siblingIntact: true });
  });

  await t.test('spawn creates a live session on the addressed peer only', async () => {
    // Given: a home-relative work directory on both peers and peer A's project id.
    await Promise.all([harness.peers.a, harness.peers.b].flatMap((node) => [
      mkdir(path.join(node.home, 'spawn-work'), { recursive: true }),
      mkdir(fleet.spawnedDir(node), { recursive: true }),
    ]));
    const projectId = catalogA.projects[0]?.localId;
    assert.ok(projectId !== undefined);
    const spawnSignalName = `task23-spawn-${process.pid}`;
    await fleet.tmux(harness.peers.a, ['set-hook', '-g', 'after-new-session', `wait-for -S ${spawnSignalName}`]);
    t.after(() => fleet.tmux(harness.peers.a, ['set-hook', '-gu', 'after-new-session']).then(() => undefined, () => undefined));
    const spawnedSignal = fleet.tmux(harness.peers.a, ['wait-for', spawnSignalName]);
    const agentReady = armFile(fleet.spawnedDir(harness.peers.a), 'gjc-');
    // When: a session is spawned on peer A through the hub.
    const spawn = await fleet.hostRequest('POST', `/api/hosts/${fleet.hostIds.a}/projects/${encodeURIComponent(projectId)}/sessions/spawn`, {
      name: 'fleet-spawn-a', cwd: 'spawn-work',
    });
    assert.equal(spawn.status, 200, JSON.stringify(spawn.body));
    assert.equal((spawn.body as { data?: { ok?: unknown } }).data?.ok, true, JSON.stringify(spawn.body));
    // Then: the exact tmux creation hook fires only on peer A.
    await Promise.all([spawnedSignal, agentReady]);
    await fleet.tmux(harness.peers.a, ['set-hook', '-gu', 'after-new-session']);
    assert.ok((await fleet.tmuxSessions(harness.peers.a)).includes('fleet-spawn-a'));
    assert.ok(!(await fleet.tmuxSessions(harness.peers.b)).includes('fleet-spawn-a'));
    assert.deepEqual(await fleet.tmuxSessions(harness.hub), ['fleet-bootstrap']);
    const spawnedA = await readdir(fleet.spawnedDir(harness.peers.a)).catch(() => [] as string[]);
    assert.ok(spawnedA.some((file) => file.startsWith('gjc-')), JSON.stringify(spawnedA));
    assert.deepEqual(await readdir(fleet.spawnedDir(harness.peers.b)).catch(() => [] as string[]), []);
    await fleet.record('spawn-assertions', { peerA: 'fleet-spawn-a', siblingIntact: true });
  });

  await t.test('all three termination kinds affect only the addressed peer target', async () => {
    // Given: three identically named fake agents on both peers, published in both catalogs.
    const agents = { a: [] as Array<{ pid: number; agent: { waitForInput: (value: string) => Promise<void> } }>, b: [] as Array<{ pid: number; agent: { waitForInput: (value: string) => Promise<void> } }> };
    for (const name of TERM_NAMES) {
      const [agentA, agentB] = await Promise.all([
        harness.peers.a.startFakeExternal('codex', name),
        harness.peers.b.startFakeExternal('codex', name),
      ]);
      await Promise.all([agentA.waitUntilReady(), agentB.waitUntilReady()]);
      const [readyA] = (await agentA.events()).filter((event) => event.type === 'ready');
      const [readyB] = (await agentB.events()).filter((event) => event.type === 'ready');
      assert.ok(readyA?.type === 'ready' && readyB?.type === 'ready');
      agents.a.push({ pid: readyA.pid, agent: agentA });
      agents.b.push({ pid: readyB.pid, agent: agentB });
    }
    const paneRow = async (hostId: string, name: string) => {
      const catalog = await fleet.awaitCatalog(hostId, (snap) => snap.panes.some((row) => row.tmuxName === name && row.process !== null), `${name} pane on ${hostId}`);
      const row = catalog.panes.find((pane) => pane.tmuxName === name && pane.process !== null);
      assert.ok(row !== undefined && row.process !== null);
      return { localId: row.localId, lane: row.lane, tmux: row.tmux, process: row.process };
    };
    const actions = [
      ['term-proc', 'terminate-process'],
      ['term-pane', 'terminate-pane'],
      ['term-sess', 'terminate-session'],
    ] as const;
    for (const [index, [name, action]] of actions.entries()) {
      const target = await paneRow(fleet.hostIds.a, name);
      const removed = fleet.awaitCatalog(fleet.hostIds.a, (snapshot) => {
        const row = snapshot.panes.find((pane) => pane.tmuxName === name);
        return action === 'terminate-process' ? row?.process === null : row === undefined;
      }, `${name} termination published by peer A`);
      // When: the termination is issued against peer A's target.
      const response = await fleet.hostRequest('POST', `/api/hosts/${fleet.hostIds.a}/providers/panes/${encodeURIComponent(target.localId)}/actions`, {
        action, lane: target.lane, tmux: target.tmux, process: target.process,
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      // Then: the target process and session disappear on peer A only.
      const ownPid = agents.a[index]?.pid;
      assert.ok(ownPid !== undefined);
      await fleet.waitForProcessExit(ownPid);
      await removed;
      assert.equal(
        (await fleet.tmuxSessions(harness.peers.a)).includes(name),
        action === 'terminate-process',
        `${name} had the wrong tmux lifetime on peer A`,
      );
      // And: peer B's identical agent keeps answering input through the hub.
      const sibling = agents.b[index];
      assert.ok(sibling !== undefined);
      process.kill(sibling.pid, 0);
      const siblingTarget = await paneRow(fleet.hostIds.b, name);
      const proof = `sibling-proof-${name}`;
      const observed = sibling.agent.waitForInput(proof);
      const sent = await fleet.hostRequest('POST', `/api/hosts/${fleet.hostIds.b}/providers/panes/${encodeURIComponent(siblingTarget.localId)}/actions`, {
        action: 'send', lane: siblingTarget.lane, tmux: siblingTarget.tmux, process: siblingTarget.process, message: proof,
      });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      await observed;
    }
    assert.deepEqual(await fleet.tmuxSessions(harness.hub), ['fleet-bootstrap']);
    await fleet.record('termination-assertions', { kinds: actions.map(([, action]) => action), siblingsAlive: true });
  });

  await t.test('pane respawn rejects the stale generation explicitly and serves the fresh one', async () => {
    // Given: the live collision pane target on peer A.
    const staleTarget = targetA;
    const respawned = fleet.awaitCatalog(fleet.hostIds.a,
      (snapshot) => snapshot.panes.some((pane) => pane.tmuxName === collision.tmuxSessionName
        && pane.process !== null && pane.process.pid !== staleTarget.process.pid),
      'collision pane generation change');
    // When: the pane is respawned with a new agent process on peer A.
    await fleet.tmux(harness.peers.a, [
      'respawn-pane', '-k', '-t', `=${collision.tmuxSessionName}:`,
      fleet.agentCommand(harness.peers.a, 'codex', [fleet.agents.a.logPath, fleet.agents.a.transcriptPath, collision.providerSessionId, harness.workspace]),
    ]);
    await respawned;
    // Then: the stale generation fails explicitly and the fresh generation serves actions.
    const stale = await fleet.hostRequest('POST', `/api/hosts/${fleet.hostIds.a}/providers/panes/${encodeURIComponent(staleTarget.localId)}/actions`, {
      action: 'interrupt', lane: staleTarget.lane, tmux: staleTarget.tmux, process: staleTarget.process,
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    const fresh = await fleet.awaitCatalog(fleet.hostIds.a, (snap) => snap.panes.some((row) => row.tmuxName === collision.tmuxSessionName
      && row.process !== null && row.process.pid !== staleTarget.process.pid), 'fresh collision generation');
    const freshRow = fresh.panes.find((row) => row.tmuxName === collision.tmuxSessionName && row.process !== null && row.process.pid !== staleTarget.process.pid);
    assert.ok(freshRow !== undefined && freshRow.process !== null);
    const interruptObserved = fleet.agents.a.waitForInterrupt();
    const served = await fleet.hostRequest('POST', `/api/hosts/${fleet.hostIds.a}/providers/panes/${encodeURIComponent(freshRow.localId)}/actions`, {
      action: 'interrupt', lane: freshRow.lane, tmux: freshRow.tmux, process: freshRow.process,
    });
    assert.equal(served.status, 200, JSON.stringify(served.body));
    await interruptObserved;
    assert.equal(await fleet.agentLogText(fleet.agents.b), logBBefore);
    await fleet.record('respawn-assertions', { staleStatus: stale.status, freshStatus: served.status });
  });
});
