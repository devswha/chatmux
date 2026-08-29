import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';

import { WebSocket } from 'ws';

import type { FleetBrowserCatalog } from './support/task-23-driver.js';
import { startTask23Fleet } from './support/task-23-driver.js';
import { armTask23Outbox, configureTask23Notifications } from './support/task-23-notification.js';

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

type Frame = Readonly<Record<string, unknown>>;
type Json = Readonly<Record<string, unknown>>;
const data = (body: unknown): Json => {
  assert.ok(body !== null && typeof body === 'object' && 'data' in body, `missing data envelope: ${JSON.stringify(body)}`);
  const envelope = Object.fromEntries(Object.entries(body));
  return Object.fromEntries(Object.entries(envelope.data as Readonly<Record<string, unknown>>));
};

function collisionPane(catalog: FleetBrowserCatalog, sessionName: string) {
  const pane = catalog.panes.find((row) => row.tmuxName === sessionName && row.process !== null);
  assert.ok(pane !== undefined && pane.process !== null, `live collision pane missing for ${sessionName}`);
  return { localId: pane.localId, lane: pane.lane, tmux: pane.tmux, process: pane.process };
}

function openRemoteChat(url: string): Readonly<{
  send: (frame: Frame) => Promise<Frame>;
  waitFor: (predicate: (frame: Frame) => boolean, label: string) => Promise<Frame>;
  close: () => void;
}> {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  const waiters: Array<{ predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void; label: string }> = [];
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
  return {
    send: async (frame) => {
      await opened;
      const expected = new Promise<Frame>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`remote-chat reply timed out for ${String(frame.type)}`)), 15_000);
        waiters.push({
          predicate: (candidate) => candidate.kind === 'chat_accepted' || candidate.kind === 'chat_aborted'
            || candidate.kind === 'chat_subscribed' || candidate.kind === 'protocol_error',
          label: String(frame.type),
          resolve: (value) => { clearTimeout(timeout); resolve(value); },
        });
      });
      ws.send(JSON.stringify(frame));
      return expected;
    },
    waitFor: async (predicate, label) => {
      await opened;
      const existing = frames.find(predicate);
      if (existing !== undefined) return existing;
      return new Promise<Frame>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`remote-chat wait timed out: ${label}`)), 15_000);
        waiters.push({ predicate, label, resolve: (frame) => { clearTimeout(timeout); resolve(frame); } });
      });
    },
    close: () => ws.close(),
  };
}

test('task-23 chat, approval, and pane actions route only to the addressed peer', {
  skip: tmuxE2ESkip, timeout: 300_000, concurrency: false,
}, async (t) => {
  const hookBefore = await Promise.all(HOOKS.map((file) => readFile(path.resolve(file))));
  const fleet = await startTask23Fleet({ evidenceDir: EVIDENCE_DIR, liveNotify: true });
  after(async () => {
    await fleet.dispose();
    assert.deepEqual(await Promise.all(HOOKS.map((file) => readFile(path.resolve(file)))), hookBefore);
  });
  const { collision } = fleet.harness;
  configureTask23Notifications(fleet, collision.appSessionId);
  const offline = fleet.waitForFrame((frame) => frame.kind === 'fleet.host_state'
    && (frame.host as { hostId?: unknown; state?: unknown })?.hostId === fleet.hostIds.a
    && (frame.host as { state?: unknown }).state === 'offline', 'peer A offline before seeded restart');
  await fleet.stopServer('peer-a');
  await offline;
  const online = fleet.waitForFrame((frame) => frame.kind === 'fleet.host_state'
    && (frame.host as { hostId?: unknown; state?: unknown })?.hostId === fleet.hostIds.a
    && (frame.host as { state?: unknown }).state === 'online', 'peer A online after seeded restart');
  await fleet.restartServer('peer-a');
  await online;
  const catalogA = await fleet.awaitCatalog(fleet.hostIds.a, (snap) => snap.sessions.length > 0, 'peer A catalog');
  await fleet.awaitCatalog(fleet.hostIds.b, (snap) => snap.sessions.length > 0, 'peer B catalog');
  await fleet.awaitPeerState(fleet.hostIds.a, 'online');
  await fleet.awaitPeerState(fleet.hostIds.b, 'online');
  const paneA = collisionPane(catalogA, collision.tmuxSessionName);
  const logBBefore = await fleet.agentLogText(fleet.agents.b);

  await t.test('remote chat send and abort mutate only the addressed peer agent', async () => {
    // Given: an armed remote-chat socket and peer B's log snapshot.
    const chat = openRemoteChat(`${fleet.servers.hub.url.replace('http', 'ws')}/remote-chat`);
    t.after(() => chat.close());
    const message = '__fake_long_running_turn__';
    const observed = fleet.agents.a.waitForInput(message);
    // When: a chat message is sent to peer A's colliding session.
    const accepted = await chat.send({
      type: 'chat.send', hostId: fleet.hostIds.a, sessionId: collision.appSessionId, content: message,
    });
    // Then: the hub accepts it and only peer A's agent receives the input.
    assert.equal(accepted.kind, 'chat_accepted', JSON.stringify(accepted));
    await observed;
    await fleet.awaitCatalog(fleet.hostIds.a, (snapshot) => snapshot.panes.some(
      (pane) => pane.tmuxName === collision.tmuxSessionName && pane.activity === 'running',
    ), 'peer A running turn arm');
    const notification = armTask23Outbox(fleet.harness.hub.databasePath, fleet.hostIds.a);
    const finished = fleet.agents.a.waitForInput('__fake_finish_turn__');
    const finish = await fleet.hostRequest('POST', `/api/hosts/${fleet.hostIds.a}/providers/panes/${encodeURIComponent(paneA.localId)}/actions`, {
      action: 'send', lane: paneA.lane, tmux: paneA.tmux, process: paneA.process, message: '__fake_finish_turn__',
    });
    assert.equal(finish.status, 200, JSON.stringify(finish.body));
    await finished;
    const payload = await notification;
    assert.equal((payload.navigation as { hostId?: unknown }).hostId, fleet.hostIds.a);
    assert.ok(String((payload.navigation as { href?: unknown }).href).startsWith(`/hosts/${fleet.hostIds.a}/session/`));
    assert.ok(!JSON.stringify(payload).includes(fleet.hostIds.b));
    const subscribed = await chat.send({
      type: 'chat.subscribe', hostId: fleet.hostIds.a, sessionId: collision.appSessionId, lastSeq: 0,
    });
    assert.equal(subscribed.kind, 'chat_subscribed', JSON.stringify(subscribed));
    const interrupt = fleet.agents.a.waitForInterrupt();
    const aborted = await chat.send({ type: 'chat.abort', hostId: fleet.hostIds.a, sessionId: collision.appSessionId });
    assert.equal(aborted.kind, 'chat_aborted', JSON.stringify(aborted));
    await interrupt;
    assert.equal(await fleet.agentLogText(fleet.agents.b), logBBefore);
    await fleet.record('chat-assertions', { accepted: accepted.kind, aborted: aborted.kind, siblingIntact: true });
    await fleet.record('notification-assertions', { payload, siblingHostAbsent: true });
  });

  await t.test('pane send, interrupt, and escape reach only the addressed pane', async () => {
    // Given: peer A's live pane target and peer B's byte-frozen log.
    const line = 'peer-alpha-pane-line';
    const observed = fleet.agents.a.waitForInput(line);
    // When: pane send/interrupt/escape are issued against peer A's pane.
    const send = await fleet.hostRequest('POST', `/api/hosts/${fleet.hostIds.a}/providers/panes/${encodeURIComponent(paneA.localId)}/actions`, {
      action: 'send', lane: paneA.lane, tmux: paneA.tmux, process: paneA.process, message: line,
    });
    assert.equal(send.status, 200, JSON.stringify(send.body));
    await observed;
    const eventsBefore = (await fleet.agents.a.events()).filter((event) => event.type === 'interrupt').length;
    const interruptObserved = fleet.agents.a.waitForInterrupt(eventsBefore + 1);
    const interrupt = await fleet.hostRequest('POST', `/api/hosts/${fleet.hostIds.a}/providers/panes/${encodeURIComponent(paneA.localId)}/actions`, {
      action: 'interrupt', lane: paneA.lane, tmux: paneA.tmux, process: paneA.process,
    });
    assert.equal(interrupt.status, 200, JSON.stringify(interrupt.body));
    await interruptObserved;
    const escapeObserved = fleet.agents.a.waitForInterrupt(eventsBefore + 2);
    const escape = await fleet.hostRequest('POST', `/api/hosts/${fleet.hostIds.a}/providers/panes/${encodeURIComponent(paneA.localId)}/actions`, {
      action: 'escape', lane: paneA.lane, tmux: paneA.tmux, process: paneA.process,
    });
    assert.equal(escape.status, 200, JSON.stringify(escape.body));
    await escapeObserved;
    // Then: peer B's log is byte-identical and the controller owns no new tmux session.
    assert.equal(await fleet.agentLogText(fleet.agents.b), logBBefore);
    assert.deepEqual(await fleet.tmuxSessions(fleet.harness.hub), ['fleet-bootstrap']);
  });

  await t.test('approval read and both decisions act on the addressed peer only', async () => {
    // Given: an approval prompt raised on peer A's collision agent through the hub.
    for (const [decision, expected] of [['approve-once', 'approve'], ['reject', 'escape']] as const) {
      const requested = fleet.agents.a.waitForInput('__fake_approval__');
      const send = await fleet.hostRequest('POST', `/api/hosts/${fleet.hostIds.a}/providers/panes/${encodeURIComponent(paneA.localId)}/actions`, {
        action: 'send', lane: paneA.lane, tmux: paneA.tmux, process: paneA.process, message: '__fake_approval__',
      });
      assert.equal(send.status, 200, JSON.stringify(send.body));
      await requested;
      // When: the approval is read and answered through the hub.
      const read = await fleet.hostRequest('GET', `/api/hosts/${fleet.hostIds.a}/providers/sessions/${collision.appSessionId}/approval`);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      const prompt = data(read.body).approval;
      assert.ok(prompt !== null && typeof prompt === 'object', JSON.stringify(read.body).slice(0, 200));
      const answered = fleet.agents.a.waitForApproval(expected);
      const respond = await fleet.hostRequest('POST', `/api/hosts/${fleet.hostIds.a}/providers/sessions/${collision.appSessionId}/approval/respond`, { decision });
      assert.equal(respond.status, 200, JSON.stringify(respond.body));
      // Then: peer A's agent records the exact decision and peer B is untouched.
      await answered;
      assert.equal(await fleet.agentLogText(fleet.agents.b), logBBefore);
    }
    await fleet.record('approval-assertions', { decisions: ['approve-once', 'reject'], siblingIntact: true });
  });

  await t.test('stale prompt and approval responses fail explicitly with zero side effects', async () => {
    // Given: no pending prompt or approval on peer A and two already-answered approvals.
    const answeredBefore = (await fleet.agents.a.events()).filter((event) => event.type === 'approval').length;
    const promptRespond = await fleet.hostRequest('POST', `/api/hosts/${fleet.hostIds.a}/providers/sessions/${collision.appSessionId}/prompt/respond`, {
      response: 'choices', promptId: 'no-such-prompt', choices: [1],
    });
    const approvalRespond = await fleet.hostRequest('POST', `/api/hosts/${fleet.hostIds.a}/providers/sessions/${collision.appSessionId}/approval/respond`, {
      decision: 'approve-once',
    });
    // Then: both fail with an explicit typed conflict, no peer mutation, and a live connection.
    assert.equal(promptRespond.status, 409, JSON.stringify(promptRespond.body));
    assert.equal(approvalRespond.status, 409, JSON.stringify(approvalRespond.body));
    const stillOnline = await fleet.hostRequest('GET', `/api/hosts/${fleet.hostIds.a}/providers/sessions/${collision.appSessionId}`);
    assert.equal(stillOnline.status, 200, JSON.stringify(stillOnline.body));
    assert.equal(await fleet.agentLogText(fleet.agents.b), logBBefore);
    const eventsA = await fleet.agents.a.events();
    assert.equal(eventsA.filter((event) => event.type === 'approval').length, answeredBefore);
  });
});
