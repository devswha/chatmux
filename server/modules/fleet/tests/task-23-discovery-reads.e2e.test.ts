import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';

import { startTask23Fleet, type FleetBrowserCatalog } from './support/task-23-driver.js';

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

type Json = Readonly<Record<string, unknown>>;
const data = (body: unknown): Json => {
  assert.ok(body !== null && typeof body === 'object' && 'data' in body, `missing data envelope: ${JSON.stringify(body)}`);
  return body.data as Json;
};
const errorCode = (body: unknown): string | undefined => {
  if (body === null || typeof body !== 'object' || !('error' in body)) return undefined;
  const error = body.error;
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
};

test('task-23 discovery and read routing across two colliding peers', {
  skip: tmuxE2ESkip, timeout: 240_000, concurrency: false,
}, async (t) => {
  const hookBefore = await Promise.all(HOOKS.map((file) => readFile(path.resolve(file))));
  const operatorBefore = spawnSync('tmux', ['list-sessions', '-F', '#{socket_path}\t#{pid}\t#{session_name}'], { encoding: 'utf8' }).stdout;
  const fleet = await startTask23Fleet({ evidenceDir: EVIDENCE_DIR });
  after(async () => {
    await fleet.dispose();
    assert.deepEqual(await Promise.all(HOOKS.map((file) => readFile(path.resolve(file)))), hookBefore);
    assert.equal(spawnSync('tmux', ['list-sessions', '-F', '#{socket_path}\t#{pid}\t#{session_name}'], { encoding: 'utf8' }).stdout, operatorBefore);
  });
  const { collision } = fleet.harness;
  const catalogA = await fleet.awaitCatalog(fleet.hostIds.a, (snap) => snap.sessions.length > 0, 'peer A catalog');
  const catalogB = await fleet.awaitCatalog(fleet.hostIds.b, (snap) => snap.sessions.length > 0, 'peer B catalog');
  await fleet.awaitPeerState(fleet.hostIds.a, 'online');
  await fleet.awaitPeerState(fleet.hostIds.b, 'online');

  await t.test('colliding identities stay distinct per host in the hub catalog', async () => {
    // Given: both peers publish the same session/project ids and tmux tuple.
    for (const [catalog, hostId] of [[catalogA, fleet.hostIds.a], [catalogB, fleet.hostIds.b]] as const) {
      assert.deepEqual(catalog.sessions.map((row) => row.localId), [collision.appSessionId]);
      assert.equal(catalog.projects.length, 1);
      const pane = catalog.panes.find((row) => row.tmuxName === collision.tmuxSessionName);
      assert.ok(pane !== undefined, `collision pane missing for ${hostId}`);
      assert.deepEqual([pane.tmux.sessionId, pane.tmux.windowId, pane.tmux.paneId], ['$1', '@1', '%1']);
      assert.equal(pane.localId.includes('\0'), false);
      assert.equal(catalog.hostId, hostId);
    }
    // Then: the tmux tuple collides exactly while the wire keys stay host-qualified.
    // Project ids are per-installation UUIDs; the colliding project PATH never
    // crosses the browser boundary, so identity here is the session linkage.
    const paneA = catalogA.panes.find((row) => row.tmuxName === collision.tmuxSessionName);
    const paneB = catalogB.panes.find((row) => row.tmuxName === collision.tmuxSessionName);
    assert.ok(paneA !== undefined && paneB !== undefined);
    assert.notEqual(paneA.localId, paneB.localId);
    assert.equal(catalogA.sessions[0]?.projectLocalId, catalogA.projects[0]?.localId);
    assert.equal(catalogB.sessions[0]?.projectLocalId, catalogB.projects[0]?.localId);
    await fleet.record('discovery-snapshots', { a: catalogA, b: catalogB });
  });

  await t.test('history and search answers come from the addressed peer only', async () => {
    // Given: identical session ids on both peers with different transcript content.
    const historyA = await fleet.hostRequest('GET', `/api/hosts/${fleet.hostIds.a}/providers/sessions/${collision.appSessionId}/messages?limit=50`);
    const historyB = await fleet.hostRequest('GET', `/api/hosts/${fleet.hostIds.b}/providers/sessions/${collision.appSessionId}/messages?limit=50`);
    assert.equal(historyA.status, 200, JSON.stringify(historyA.body));
    assert.equal(historyB.status, 200, JSON.stringify(historyB.body));
    const textA = JSON.stringify(data(historyA.body));
    const textB = JSON.stringify(data(historyB.body));
    // Then: each answer carries only its own peer's bootstrap line.
    assert.ok(textA.includes('peer-alpha-bootstrap'), textA.slice(0, 300));
    assert.ok(!textA.includes('peer-bravo-bootstrap'));
    assert.ok(textB.includes('peer-bravo-bootstrap'), textB.slice(0, 300));
    assert.ok(!textB.includes('peer-alpha-bootstrap'));
    const projectId = catalogA.projects[0]?.localId;
    assert.ok(projectId !== undefined);
    const searchA = await fleet.hostRequest('GET', `/api/hosts/${fleet.hostIds.a}/projects/${encodeURIComponent(projectId)}/search?query=${encodeURIComponent('peer-alpha-bootstrap')}`);
    const searchWrong = await fleet.hostRequest('GET', `/api/hosts/${fleet.hostIds.a}/projects/${encodeURIComponent(projectId)}/search?query=${encodeURIComponent('peer-bravo-bootstrap')}`);
    assert.equal(searchA.status, 200);
    assert.equal(searchWrong.status, 200);
    const searchDataA = data(searchA.body);
    const searchDataWrong = data(searchWrong.body);
    assert.ok(Number(searchDataA.totalMatches) > 0, JSON.stringify(searchDataA).slice(0, 300));
    assert.equal(searchDataWrong.totalMatches, 0);
    await fleet.record('read-assertions', {
      historyA: textA.includes('peer-alpha-bootstrap'),
      historyB: textB.includes('peer-bravo-bootstrap'),
      searchAMatches: searchDataA.totalMatches,
      searchWrongMatches: searchDataWrong.totalMatches,
    });
  });

  await t.test('prompt and approval reads answer null with no pending state on the addressed peer', async () => {
    // Given: no pending prompt or approval on either collision session.
    const prompt = await fleet.hostRequest('GET', `/api/hosts/${fleet.hostIds.a}/providers/sessions/${collision.appSessionId}/prompt`);
    const approval = await fleet.hostRequest('GET', `/api/hosts/${fleet.hostIds.a}/providers/sessions/${collision.appSessionId}/approval`);
    // Then: the addressed peer answers explicitly and its sibling log is untouched.
    assert.equal(prompt.status, 200, JSON.stringify(prompt.body));
    assert.equal(approval.status, 200, JSON.stringify(approval.body));
    assert.equal(data(prompt.body).prompt, null);
    assert.equal(data(approval.body).approval, null);
    const siblingLog = await fleet.agentLogText(fleet.agents.b);
    assert.ok(!siblingLog.includes('approval'));
  });

  await t.test('pane capture returns the addressed peer screen with its own content', async () => {
    // Given: the collision pane target from each peer's catalog row.
    const capture = async (hostId: string, catalog: FleetBrowserCatalog): Promise<Readonly<{ status: number; body: unknown }>> => {
      const pane = catalog.panes.find((row) => row.tmuxName === collision.tmuxSessionName && row.process !== null);
      assert.ok(pane !== undefined && pane.process !== null);
      return fleet.hostRequest('POST', `/api/hosts/${hostId}/providers/panes/${encodeURIComponent(pane.localId)}/capture`, {
        lane: pane.lane, tmux: pane.tmux, process: pane.process,
      });
    };
    // When: both panes are captured through the hub.
    const captureA = await capture(fleet.hostIds.a, catalogA);
    const captureB = await capture(fleet.hostIds.b, catalogB);
    // Then: each screen shows its own agent's output.
    assert.equal(captureA.status, 200, JSON.stringify(captureA.body));
    assert.equal(captureB.status, 200, JSON.stringify(captureB.body));
    const outputA = JSON.stringify(data(captureA.body));
    const outputB = JSON.stringify(data(captureB.body));
    assert.ok(outputA.includes('peer-alpha-bootstrap'), outputA.slice(0, 300));
    assert.ok(outputB.includes('peer-bravo-bootstrap'), outputB.slice(0, 300));
    await fleet.record('pane-captures', { a: data(captureA.body), b: data(captureB.body) });
  });

  await t.test('inventory, metadata, and path suggestions resolve on the owning peer', async () => {
    // Given: the colliding session and project ids.
    const metadataA = await fleet.hostRequest('GET', `/api/hosts/${fleet.hostIds.a}/providers/sessions/${collision.appSessionId}`);
    const inventoryA = await fleet.hostRequest('GET', `/api/hosts/${fleet.hostIds.a}/providers/sessions/${collision.appSessionId}/inventory`);
    const projectId = catalogA.projects[0]?.localId;
    assert.ok(projectId !== undefined);
    const suggestionsA = await fleet.hostRequest('GET', `/api/hosts/${fleet.hostIds.a}/projects/${encodeURIComponent(projectId)}/dir-suggestions?prefix=`);
    // Then: peer A answers its own provider state and home-relative suggestions.
    assert.equal(metadataA.status, 200, JSON.stringify(metadataA.body));
    assert.equal(data(metadataA.body).provider, 'codex');
    assert.equal(inventoryA.status, 200, JSON.stringify(inventoryA.body));
    assert.equal(data(inventoryA.body).provider, 'codex');
    assert.equal(suggestionsA.status, 200, JSON.stringify(suggestionsA.body));
    assert.ok(Array.isArray(data(suggestionsA.body).suggestions));
    // And: an unknown host fails explicitly without touching either peer.
    const unknownHostId = '00000000-0000-4000-8000-000000000099';
    const unknown = await fleet.hostRequest('GET', `/api/hosts/${unknownHostId}/providers/sessions/${collision.appSessionId}`);
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(errorCode(unknown.body), 'HOST_NOT_FOUND');
  });
});
