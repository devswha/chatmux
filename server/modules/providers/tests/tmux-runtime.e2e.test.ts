import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { GjcSessionSynchronizer } from '@/modules/providers/list/gjc/gjc-session-synchronizer.provider.js';
import { GjcSessionsProvider } from '@/modules/providers/list/gjc/gjc-sessions.provider.js';
import {
  assertTmuxPaneIdentity,
  killTmuxPane,
  readTmuxPaneIdentity,
  readTmuxProcessGeneration,
  sendToTmuxPane,
} from '@/modules/providers/services/tmux-pane-actions.service.js';
import {
  getLiveGjcSessions,
  IDLE_GJC_ID_PREFIX,
  type LiveGjcSession,
} from '@/modules/providers/services/live-sessions.service.js';
import { assertLineageTmuxTarget } from '@/modules/providers/services/tmux-target-guard.service.js';
import { createTmuxE2EHarness } from '@/modules/providers/tests/support/tmux-e2e-harness.js';
import { AppError } from '@/shared/utils.js';

import {
  tmuxPaneIdentityKey,
  type TmuxPaneTarget,
} from '../../../../shared/tmux.js';

const isWindows = process.platform === 'win32';

async function waitForLiveGeneration(
  sessionName: string,
  sessionId?: string,
  timeoutMs = 8_000,
): Promise<LiveGjcSession & TmuxPaneTarget> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = (await getLiveGjcSessions()).find(
      (session) => (
        session.tmuxName === sessionName
        && session.tmux !== null
        && session.process !== null
        && (sessionId === undefined || session.tmux.sessionId === sessionId)
        && session.claim === 'lineage'
      ),
    );
    if (match?.tmux && match.process) {
      return { ...match, tmux: match.tmux, process: match.process };
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for live tmux target ${sessionName} ${sessionId ?? ''}`);
}

async function waitForStructuredPromotion(
  target: TmuxPaneTarget,
  sessionId: string,
  timeoutMs = 8_000,
): Promise<{ promoted: LiveGjcSession & TmuxPaneTarget; snapshot: LiveGjcSession[] }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await getLiveGjcSessions();
    const promoted = snapshot.find(
      (session) => (
        session.id === sessionId
        && session.tmux !== null
        && session.process !== null
        && tmuxPaneIdentityKey(session.tmux) === tmuxPaneIdentityKey(target.tmux)
        && session.process.pid === target.process.pid
        && session.process.startedAtMs === target.process.startedAtMs
        && session.claim === 'lineage'
      ),
    );
    if (promoted?.tmux && promoted.process) {
      return { promoted: { ...promoted, tmux: promoted.tmux, process: promoted.process }, snapshot };
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for structured promotion ${sessionId}`);
}

function isGenerationMismatch(error: unknown): boolean {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'TMUX_PROCESS_GENERATION_MISMATCH');
  assert.equal(error.statusCode, 409);
  return true;
}

function isStalePane(error: unknown): boolean {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'TMUX_ACTION_NOT_LINEAGE');
  assert.equal(error.statusCode, 403);
  return true;
}

test('live tmux actions require exact pane and process generations', () => {
  assert.throws(
    () => readTmuxPaneIdentity(undefined),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'TMUX_PANE_IDENTITY_REQUIRED');
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
  assert.throws(
    () => readTmuxProcessGeneration({ pid: 42, startedAtMs: 0 }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_TMUX_PROCESS_GENERATION');
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

test('lineage guard rejects a stale agent process generation in the same pane', async () => {
  const tmux = {
    socketPath: '/tmp/chatmux-test.sock',
    sessionId: '$1',
    windowId: '@2',
    paneId: '%3',
  };
  const current: LiveGjcSession = {
    id: 'current',
    tmuxName: 'same-pane',
    tmux,
    process: { pid: 202, startedAtMs: 2_000 },
    claim: 'lineage',
    kind: 'interactive',
    model: null,
    effort: null,
    running: false,
  };
  await assert.rejects(
    assertLineageTmuxTarget(
      tmux,
      { pid: 101, startedAtMs: 1_000 },
      async () => [current],
    ),
    isGenerationMismatch,
  );
});

test('real tmux promotes one idle GJC row to indexed structured history after first input', {
  skip: isWindows && 'Production tmux discovery is supported on Unix hosts.',
  timeout: 30_000,
  concurrency: false,
}, async (t) => {
  const harness = await createTmuxE2EHarness();
  t.after(async () => {
    closeConnection();
    await harness.dispose();
  });
  closeConnection();
  await initializeDatabase();

  const sessionName = 'e2e-gjc-promotion';
  const sessionId = '019f0000-0000-7000-8000-000000000001';
  const agent = await harness.startFakeGjcWithTranscript(sessionName, sessionId);
  await agent.waitUntilReady();
  const tmuxSessionId = await harness.getSessionId(sessionName);

  const idle = await waitForLiveGeneration(sessionName, tmuxSessionId);
  assert.equal(idle.id, `${IDLE_GJC_ID_PREFIX}${sessionName}:${idle.tmux.paneId}`);

  const firstPrompt = 'promote this terminal into structured chat';
  await assertLineageTmuxTarget(idle.tmux, idle.process);
  await sendToTmuxPane(idle.tmux, firstPrompt);
  await Promise.all([agent.waitForInput(firstPrompt), agent.waitForTranscript()]);

  const { promoted, snapshot } = await waitForStructuredPromotion(
    idle,
    sessionId,
  );
  assert.equal(promoted.kind, 'interactive');
  assert.deepEqual(
    snapshot
      .filter((session) => session.tmux && tmuxPaneIdentityKey(session.tmux) === tmuxPaneIdentityKey(idle.tmux))
      .map((session) => session.id),
    [sessionId],
    'one scan must replace the idle id instead of returning duplicate rows',
  );

  const sessionsRoot = path.dirname(path.dirname(agent.transcriptPath));
  const synchronizer = new GjcSessionSynchronizer({
    sessionsDir: sessionsRoot,
    additionalSessionDirs: [],
  });
  assert.equal(await synchronizer.synchronizeFile(agent.transcriptPath), sessionId);
  const indexed = sessionsDb.getSessionById(sessionId);
  assert.equal(indexed?.provider, 'gjc');
  assert.equal(indexed?.project_path, harness.workspace);
  assert.equal(indexed?.custom_name, firstPrompt);
  assert.equal(indexed?.jsonl_path, agent.transcriptPath);
  assert.ok(projectsDb.getProjectPath(harness.workspace), 'structured handoff requires an indexed project');

  const history = await new GjcSessionsProvider().fetchHistory(sessionId);
  assert.deepEqual(
    history.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: 'user', content: firstPrompt },
      { role: 'assistant', content: 'fake reply 1' },
    ],
  );

  const followUp = 'continue on the promoted tmux generation';
  await assertLineageTmuxTarget(promoted.tmux, promoted.process);
  await sendToTmuxPane(promoted.tmux, followUp);
  await agent.waitForInput(followUp);
  const stillPromoted = await waitForStructuredPromotion(promoted, sessionId);
  assert.equal(stillPromoted.promoted.id, sessionId);
});

test('real tmux resolves Bun and npm-shim GJC wrappers to actionable lineage rows', {
  skip: isWindows && 'Production tmux discovery is supported on Unix hosts.',
  timeout: 30_000,
}, async (t) => {
  const harness = await createTmuxE2EHarness();
  t.after(() => harness.dispose());

  const bunAgent = await harness.startFakeGjcWithBun('e2e-gjc-bun');
  const npmAgent = await harness.startFakeGjcWithNpmShim('e2e-gjc-npm');
  await Promise.all([bunAgent.waitUntilReady(), npmAgent.waitUntilReady()]);

  const [bunTmuxId, npmTmuxId] = await Promise.all([
    harness.getSessionId('e2e-gjc-bun'),
    harness.getSessionId('e2e-gjc-npm'),
  ]);
  const [bunLive, npmLive] = await Promise.all([
    waitForLiveGeneration('e2e-gjc-bun', bunTmuxId),
    waitForLiveGeneration('e2e-gjc-npm', npmTmuxId),
  ]);

  assert.deepEqual(
    [bunLive, npmLive].map(({ id, tmuxName, tmux, claim, kind }) => ({
      id,
      tmuxName,
      tmuxSessionId: tmux.sessionId,
      claim,
      kind,
    })),
    [
      {
        id: `${IDLE_GJC_ID_PREFIX}e2e-gjc-bun:${bunLive.tmux.paneId}`,
        tmuxName: 'e2e-gjc-bun',
        tmuxSessionId: bunTmuxId,
        claim: 'lineage',
        kind: 'interactive',
      },
      {
        id: `${IDLE_GJC_ID_PREFIX}e2e-gjc-npm:${npmLive.tmux.paneId}`,
        tmuxName: 'e2e-gjc-npm',
        tmuxSessionId: npmTmuxId,
        claim: 'lineage',
        // npm remains the pane foreground wrapper, so kind stays conservatively batch;
        // subtree lineage—not the presentational kind—is the actionable authority.
        kind: 'batch',
      },
    ],
  );

  await Promise.all([
    assertLineageTmuxTarget(bunLive.tmux, bunLive.process),
    assertLineageTmuxTarget(npmLive.tmux, npmLive.process),
  ]);
  await Promise.all([
    sendToTmuxPane(bunLive.tmux, 'bun wrapper input'),
    sendToTmuxPane(npmLive.tmux, 'npm shim input'),
  ]);
  await Promise.all([
    bunAgent.waitForInput('bun wrapper input'),
    npmAgent.waitForInput('npm shim input'),
  ]);
});

test('real tmux preserves pre-existing agents across fresh discovery processes and targets input exactly', {
  skip: isWindows && 'Production tmux discovery is supported on Unix hosts.',
  timeout: 30_000,
}, async (t) => {
  const harness = await createTmuxE2EHarness();
  t.after(() => harness.dispose());

  const alpha = await harness.startFakeCodex('e2e-alpha');
  const beta = await harness.startFakeCodex('e2e-beta', harness.workspace);
  await Promise.all([alpha.waitUntilReady(), beta.waitUntilReady()]);

  // Both agents exist before either short-lived discovery process starts. Running
  // discovery twice models a ChatMux process restart against the same tmux server.
  const firstDiscovery = await harness.discoverFromFreshProcess();
  const secondDiscovery = await harness.discoverFromFreshProcess();

  for (const sessions of [firstDiscovery, secondDiscovery]) {
    assert.deepEqual(
      sessions.map(({ tmuxName, kind, cwd }) => ({ tmuxName, kind, cwd })),
      [
        { tmuxName: 'e2e-alpha', kind: 'codex', cwd: harness.workspace },
        { tmuxName: 'e2e-beta', kind: 'codex', cwd: harness.workspace },
      ],
    );
  }
  assert.equal(await harness.hasSession('e2e-alpha'), true, 'discovery process exit must not own the tmux session');
  assert.equal(await harness.hasSession('e2e-beta'), true, 'same-cwd peer must remain independently addressable');

  const alphaTarget = firstDiscovery.find((session) => session.tmuxName === 'e2e-alpha');
  assert.ok(alphaTarget);
  const literalMessage = 'alpha only; $(not-a-shell) -Enter';
  await assertTmuxPaneIdentity(alphaTarget.tmux);
  await sendToTmuxPane(alphaTarget.tmux, literalMessage);
  await alpha.waitForInput(literalMessage);
  await delay(100);
  assert.equal(
    (await beta.events()).some((event) => event.type === 'input'),
    false,
    'input for one tmux target must not leak to a same-cwd peer',
  );


  await assert.rejects(
    assertTmuxPaneIdentity({ ...alphaTarget.tmux, paneId: '%999999' }),
    (error) => error instanceof AppError && error.code === 'TMUX_PANE_GENERATION_MISMATCH',
  );
  assert.equal(await harness.hasSession('e2e-alpha'), true, 'a rejected target must not disturb a live session');
  assert.equal(await harness.hasSession('e2e-beta'), true, 'test completion must leave tmux ownership external to ChatMux');
});

test('real tmux treats two agents in one session as independent pane targets', {
  skip: isWindows && 'Production tmux discovery is supported on Unix hosts.',
  timeout: 30_000,
}, async (t) => {
  const harness = await createTmuxE2EHarness();
  t.after(() => harness.dispose());

  const first = await harness.startFakeCodex('e2e-multipane');
  const second = await harness.startFakeCodexPane('e2e-multipane', harness.workspace);
  await Promise.all([first.waitUntilReady(), second.waitUntilReady()]);
  const firstPid = (await first.events()).find((event) => event.type === 'ready')?.pid;
  const secondPid = (await second.events()).find((event) => event.type === 'ready')?.pid;
  assert.ok(firstPid);
  assert.ok(secondPid);

  const panes = (await harness.discoverFromFreshProcess())
    .filter((session) => session.tmuxName === 'e2e-multipane');
  assert.equal(panes.length, 2);
  assert.equal(new Set(panes.map(({ tmux }) => tmux.sessionId)).size, 1);
  assert.equal(new Set(panes.map(({ tmux }) => tmux.paneId)).size, 2);

  const firstTarget = panes.find(({ agentPid }) => agentPid === firstPid);
  const secondTarget = panes.find(({ agentPid }) => agentPid === secondPid);
  assert.ok(firstTarget);
  assert.ok(secondTarget);

  const message = 'first pane only';
  await assertTmuxPaneIdentity(firstTarget.tmux);
  await sendToTmuxPane(firstTarget.tmux, message);
  await first.waitForInput(message);
  await delay(100);
  assert.equal(
    (await second.events()).some((event) => event.type === 'input'),
    false,
    'an exact-pane send must not leak to a sibling pane',
  );

  await killTmuxPane(firstTarget.tmux);
  assert.equal(await harness.hasSession('e2e-multipane'), true, 'killing one pane must preserve the tmux session');
  const survivors = (await harness.discoverFromFreshProcess())
    .filter((session) => session.tmuxName === 'e2e-multipane');
  assert.deepEqual(survivors.map(({ tmux }) => tmux.paneId), [secondTarget.tmux.paneId]);
});

test('real tmux rejects stale generation input and termination after same-name recreation', {
  skip: isWindows && 'Production tmux discovery is supported on Unix hosts.',
  timeout: 30_000,
}, async (t) => {
  const harness = await createTmuxE2EHarness();
  t.after(() => harness.dispose());

  // Keep the isolated tmux server alive while the target session is replaced;
  // generation ids are monotonic only within one server lifetime.
  const keeper = await harness.startFakeCodex('e2e-generation-keeper');
  await keeper.waitUntilReady();

  const sessionName = 'e2e-generation';
  const originalAgent = await harness.startFakeGjc(sessionName);
  await originalAgent.waitUntilReady();
  const originalTmuxId = await harness.getSessionId(sessionName);
  const originalLive = await waitForLiveGeneration(sessionName, originalTmuxId);
  assert.equal(originalLive.id, `${IDLE_GJC_ID_PREFIX}${sessionName}:${originalLive.tmux.paneId}`);
  await assertLineageTmuxTarget(originalLive.tmux, originalLive.process);

  await harness.killSession(sessionName);
  const replacementAgent = await harness.startFakeGjc(sessionName);
  await replacementAgent.waitUntilReady();
  const replacementTmuxId = await harness.getSessionId(sessionName);
  assert.notEqual(replacementTmuxId, originalTmuxId, 'same-name replacement must receive a new tmux generation');
  const replacementLive = await waitForLiveGeneration(sessionName, replacementTmuxId);
  await assertLineageTmuxTarget(replacementLive.tmux, replacementLive.process);

  await assert.rejects(
    assertLineageTmuxTarget(originalLive.tmux, originalLive.process),
    isStalePane,
  );
  await delay(100);
  assert.equal(
    (await replacementAgent.events()).some((event) => event.type === 'input'),
    false,
    'the replacement must not receive input authorized for the prior generation',
  );
  assert.equal(await harness.hasSession(sessionName), true);

  await assert.rejects(
    assertLineageTmuxTarget(originalLive.tmux, originalLive.process),
    isStalePane,
  );
  assert.equal(
    await harness.hasSession(sessionName),
    true,
    'the replacement must survive termination authorized for the prior generation',
  );

  const currentMessage = 'current generation input';
  await assertLineageTmuxTarget(replacementLive.tmux, replacementLive.process);
  await sendToTmuxPane(replacementLive.tmux, currentMessage);
  await replacementAgent.waitForInput(currentMessage);
});
