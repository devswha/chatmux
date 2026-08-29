import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';

import { startTask23Fleet } from './support/task-23-driver.js';

const skip = process.platform === 'win32'
  ? 'Production tmux discovery is supported on Unix hosts.'
  : spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0
    && 'The real-tmux E2E harness requires tmux on PATH.';
const EVIDENCE_DIR = process.env.TASK23_EVIDENCE_DIR
  ?? path.resolve('.omo/evidence/multi-pc-session-management/wave-4/task-23/task-23-two-peer-e2e');
type Frame = Readonly<Record<string, unknown>>;
const hostState = (frame: Frame, hostId: string, state: string) => frame.kind === 'fleet.host_state'
  && (frame.host as { hostId?: unknown; state?: unknown })?.hostId === hostId
  && (frame.host as { state?: unknown }).state === state;
const errorCode = (body: unknown): unknown => body && typeof body === 'object' && 'error' in body
  ? (body.error as { code?: unknown })?.code : undefined;
function armSocket(directory: string, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, (_event, changed) => {
      if (changed?.toString() === filename) { clearTimeout(timeout); watcher.close(); resolve(); }
    });
    const timeout = setTimeout(() => { watcher.close(); reject(new Error('socket recreation timed out')); }, 15_000);
    watcher.once('error', (error) => { clearTimeout(timeout); watcher.close(); reject(error); });
  });
}

test('task-23 peer/hub restart, offline catalog, and socket recovery preserve exact isolation', {
  skip, timeout: 300_000, concurrency: false,
}, async (t) => {
  const operatorBefore = spawnSync('tmux', ['list-sessions', '-F', '#{socket_path}\t#{pid}\t#{session_name}'], { encoding: 'utf8' }).stdout;
  const worktreeBefore = spawnSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' }).stdout;
  const fleet = await startTask23Fleet({ evidenceDir: EVIDENCE_DIR });
  after(async () => {
    await fleet.dispose();
    assert.equal(spawnSync('tmux', ['list-sessions', '-F', '#{socket_path}\t#{pid}\t#{session_name}'], { encoding: 'utf8' }).stdout, operatorBefore);
    assert.equal(spawnSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' }).stdout, worktreeBefore);
  });
  const name = fleet.harness.collision.tmuxSessionName;
  const initialA = await fleet.awaitCatalog(fleet.hostIds.a, (catalog) => catalog.sessions.length > 0, 'initial A');
  await fleet.awaitCatalog(fleet.hostIds.b, (catalog) => catalog.sessions.length > 0, 'initial B');
  const pane = initialA.panes.find((row) => row.tmuxName === name && row.process !== null);
  assert.ok(pane !== undefined && pane.process !== null);
  const target = { localId: pane.localId, lane: pane.lane, tmux: pane.tmux, process: pane.process };
  const logA = await fleet.agentLogText(fleet.agents.a);
  const logB = await fleet.agentLogText(fleet.agents.b);

  await t.test('offline rejects A, retains its stale snapshot, and leaves B writable', async () => {
    const offline = fleet!.waitForFrame((frame) => hostState(frame, fleet!.hostIds.a, 'offline'), 'peer A offline');
    await fleet!.stopServer('peer-a');
    await offline;
    assert.equal(fleet!.catalogNow(fleet!.hostIds.a)?.revision, initialA.revision);
    const rejected = await fleet!.hostRequest('POST', `/api/hosts/${fleet!.hostIds.a}/providers/panes/${encodeURIComponent(target.localId)}/actions`, {
      action: 'send', lane: target.lane, tmux: target.tmux, process: target.process, message: 'must-not-route-offline',
    });
    assert.equal(rejected.status, 503, JSON.stringify(rejected.body));
    assert.equal(errorCode(rejected.body), 'HOST_OFFLINE');
    assert.equal(await fleet!.agentLogText(fleet!.agents.a), logA);
    const bCatalog = fleet!.catalogNow(fleet!.hostIds.b)!;
    const bPane = bCatalog.panes.find((row) => row.tmuxName === name && row.process !== null)!;
    assert.ok(bPane.process !== null);
    const received = fleet!.agents.b.waitForInput('B-survives-A-offline');
    const sent = await fleet!.hostRequest('POST', `/api/hosts/${fleet!.hostIds.b}/providers/panes/${encodeURIComponent(bPane.localId)}/actions`, {
      action: 'send', lane: bPane.lane, tmux: bPane.tmux, process: bPane.process, message: 'B-survives-A-offline',
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await received;
  });

  await t.test('peer restart passes syncing and a fresh snapshot before writes recover', async () => {
    const syncing = fleet!.waitForFrame((frame) => hostState(frame, fleet!.hostIds.a, 'syncing'), 'peer A syncing');
    const snapshot = fleet!.waitForFrame((frame) => frame.kind === 'fleet.catalog.snapshot' && frame.hostId === fleet!.hostIds.a, 'peer A fresh snapshot');
    const online = fleet!.waitForFrame((frame) => hostState(frame, fleet!.hostIds.a, 'online'), 'peer A online');
    await fleet!.restartServer('peer-a');
    await Promise.all([syncing, snapshot, online]);
    const current = await fleet!.awaitCatalog(fleet!.hostIds.a, (catalog) => catalog.panes.some((row) => row.tmuxName === name && row.process !== null), 'restarted A catalog');
    const row = current.panes.find((item) => item.tmuxName === name && item.process !== null)!;
    assert.ok(row.process !== null);
    const received = fleet!.agents.a.waitForInput('A-recovers-after-restart');
    const transcriptCount = (await fleet!.agents.a.events()).filter((event) => event.type === 'transcript').length;
    const transcript = fleet!.agents.a.waitForTranscript(transcriptCount + 1);
    const sent = await fleet!.hostRequest('POST', `/api/hosts/${fleet!.hostIds.a}/providers/panes/${encodeURIComponent(row.localId)}/actions`, {
      action: 'send', lane: row.lane, tmux: row.tmux, process: row.process, message: 'A-recovers-after-restart',
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await Promise.all([received, transcript]);
  });

  await t.test('hub restart rebuilds both snapshots without peer cross-talk', async () => {
    const logsBefore = await Promise.all([fleet!.agentLogText(fleet!.agents.a), fleet!.agentLogText(fleet!.agents.b)]);
    const snapshots = [fleet!.hostIds.a, fleet!.hostIds.b].map((hostId) => fleet!.waitForFrame(
      (frame) => frame.kind === 'fleet.catalog.snapshot' && frame.hostId === hostId,
      `hub restart snapshot ${hostId}`,
    ));
    await fleet!.stopServer('hub');
    await fleet!.restartServer('hub');
    await Promise.all(snapshots);
    assert.deepEqual(await Promise.all([fleet!.agentLogText(fleet!.agents.a), fleet!.agentLogText(fleet!.agents.b)]), logsBefore);
  });

  await t.test('socket disappearance fails stale A explicitly, then SIGUSR1 snapshot recovery serves A', async () => {
    const current = fleet!.catalogNow(fleet!.hostIds.a)!;
    const row = current.panes.find((item) => item.tmuxName === name && item.process !== null)!;
    assert.ok(row.process !== null);
    const revisionBefore = current.revision;
    await unlink(fleet!.harness.peers.a.socketPath);
    const rejected = await fleet!.hostRequest('POST', `/api/hosts/${fleet!.hostIds.a}/providers/panes/${encodeURIComponent(row.localId)}/actions`, {
      action: 'interrupt', lane: row.lane, tmux: row.tmux, process: row.process,
    });
    assert.ok(rejected.status >= 409, JSON.stringify(rejected.body));
    assert.equal(fleet!.catalogNow(fleet!.hostIds.a)?.revision, revisionBefore, 'unavailable discovery retains the last catalog');
    const socketPath = fleet!.harness.peers.a.socketPath;
    const recreated = armSocket(path.dirname(socketPath), path.basename(socketPath));
    process.kill(fleet!.harness.peers.a.tmuxServerPid, 'SIGUSR1');
    await recreated;
    const present = fleet!.awaitCatalog(fleet!.hostIds.a, (catalog) => catalog.panes.some(
      (item) => item.localId === row.localId && item.presence === 'present' && item.process !== null,
    ), 'socket recovery present catalog');
    const received = fleet!.agents.a.waitForInput('socket-recovered-A');
    const sent = await fleet!.hostRequest('POST', `/api/hosts/${fleet!.hostIds.a}/providers/panes/${encodeURIComponent(row.localId)}/actions`, {
      action: 'send', lane: row.lane, tmux: row.tmux, process: row.process, message: 'socket-recovered-A',
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await Promise.all([present, received]);
    assert.ok((await fleet!.agentLogText(fleet!.agents.b)).startsWith(logB));
  });
  await fleet.record('recovery-assertions', { worktreePreserved: true, peerRestart: true, hubRestart: true, socketRecovery: true });
});
