import { app, assert, assertError, assertSuccess,
  externalTmux, fixtureBin, getCurrentTmuxPaneIdentityState, liveTmux,
  path, request, sessionsDb, test, validProcess, writeFile,
} from './support/provider-routes-contract.support.js';

test('external ask routes verify the transcript and active Codex selector before sending input', async () => {
  const providerSessionId = '019fbd4a-08f9-7ab0-a87e-5986efb405d4';
  const transcriptPath = path.join(fixtureBin, 'codex-ask.jsonl');
  await writeFile(transcriptPath, `${JSON.stringify({
    type: 'response_item',
    timestamp: '2026-07-31T00:00:00.000Z',
    payload: {
      type: 'function_call',
      name: 'request_user_input',
      call_id: 'ask-contract-1',
      arguments: JSON.stringify({
        questions: [{
          question: 'Choose an action',
          options: [{ label: 'Allow' }, { label: 'Reject' }],
        }],
      }),
    },
  })}\n`);
  const sessionId = sessionsDb.createSession(
    providerSessionId,
    'codex',
    '/tmp',
    'Ask route contract',
    undefined,
    undefined,
    transcriptPath,
  );
  process.env.CHATMUX_CONTRACT_PROVIDER_SESSION_ID = providerSessionId;

  try {
    process.env.CHATMUX_CONTRACT_CAPTURE = [
      'Choose an action',
      '› 1. Allow',
      '  2. Reject',
      '  3. None of the above',
      'tab to add notes | enter to submit answer | esc to interrupt',
    ].join('\n');
    assertSuccess(await request('/sessions/external/ask', {
      tmux: externalTmux,
      process: validProcess,
      sessionId,
      toolId: 'ask-contract-1',
      optionIndex: 1,
    }));

    process.env.CHATMUX_CONTRACT_CAPTURE = [
      'Choose an action',
      '3. None of the above',
      '› Add notes',
      'tab or esc to clear notes | enter to submit answer',
    ].join('\n');
    assertSuccess(await request('/sessions/external/ask/custom', {
      tmux: externalTmux,
      process: validProcess,
      sessionId,
      toolId: 'ask-contract-1',
      message: 'Use the safe fallback',
    }));

    process.env.CHATMUX_CONTRACT_CAPTURE = [
      'Would you like to run the following command?',
      '$ git status',
      '› 1. Yes, proceed',
      '  2. No, and tell Codex what to do differently',
    ].join('\n');
    const approval = await request('/sessions/external/approval', {
      tmux: externalTmux,
      process: validProcess,
      sessionId,
    });
    assertSuccess(approval);
    assert.equal(
      (approval.body.data?.approval as { canRemember?: boolean } | undefined)?.canRemember,
      false,
    );
    assertSuccess(await request('/sessions/external/approval/respond', {
      tmux: externalTmux,
      process: validProcess,
      sessionId,
      decision: 'reject',
    }));
  } finally {
    delete process.env.CHATMUX_CONTRACT_PROVIDER_SESSION_ID;
    delete process.env.CHATMUX_CONTRACT_CAPTURE;
  }
});

test('successful spawn routes schedule an immediate discovery refresh', async () => {
  let refreshes = 0;
  app.locals.discoveryCollector = {
    forceRefresh: () => {
      refreshes += 1;
    },
  };

  try {
    assertSuccess(
      await request('/sessions/external/spawn', { name: 'external-refresh', cwd: '~', cli: 'codex' }),
      201,
    );
    assertSuccess(await request('/sessions/live/spawn', { name: 'live-refresh', cwd: '~' }));
    assert.equal(refreshes, 2);
  } finally {
    delete app.locals.discoveryCollector;
  }
});
test('process action routes reject unallowlisted keys and preserve freshness and lineage boundaries', async () => {
  assertError(
    await request('/sessions/external/actions', { tmux: externalTmux, process: validProcess, action: 'Enter' }),
    400,
    'INVALID_TMUX_TERMINATION_MODE',
  );
  assertError(
    await request('/sessions/external/actions', {
      tmux: externalTmux,
      process: { ...validProcess, startedAtMs: validProcess.startedAtMs + 1 },
      action: 'interrupt',
    }),
    409,
    'TMUX_PROCESS_GENERATION_MISMATCH',
  );
  assertError(
    await request('/sessions/live/actions', { tmux: externalTmux, process: validProcess, action: 'interrupt' }),
    403,
    'TMUX_ACTION_NOT_LINEAGE',
  );
});
test('termination routes fail closed when the ChatMux pane is unavailable and protect the hosted pane', async () => {
  const previousTmuxPane = process.env.TMUX_PANE;
  try {
    delete process.env.TMUX_PANE;
    assertSuccess(await request('/sessions/external/actions', { tmux: externalTmux, process: validProcess, action: 'interrupt' }));
    assertSuccess(await request('/sessions/external/kill', { tmux: externalTmux, process: validProcess, mode: 'pane' }));

    for (const [pathname, tmux] of [
      ['/sessions/external/kill', externalTmux],
      ['/sessions/live/kill', liveTmux],
    ] as const) {
      process.env.TMUX_PANE = tmux.paneId;
      assert.deepEqual(await getCurrentTmuxPaneIdentityState(), { state: 'hosted', tmux });
      for (const mode of ['process', 'pane', 'session'] as const) {
        assertError(
          await request(pathname, { tmux, process: validProcess, mode }),
          403,
          'EXTERNAL_CLI_SESSION_PROTECTED',
        );
      }
    }

    process.env.TMUX_PANE = '%9';
    process.env.CHATMUX_CONTRACT_SELF_PANE_FAIL = '1';
    assert.deepEqual(await getCurrentTmuxPaneIdentityState(), { state: 'unavailable' });
    assertError(await request('/sessions/external/actions', { tmux: externalTmux, process: validProcess, action: 'interrupt' }), 403, 'EXTERNAL_CLI_SESSION_PROTECTED');
    assertError(await request('/sessions/external/kill', { tmux: externalTmux, process: validProcess, mode: 'pane' }), 403, 'EXTERNAL_CLI_SESSION_PROTECTED');
  } finally {
    delete process.env.CHATMUX_CONTRACT_SELF_PANE_FAIL;
    if (previousTmuxPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = previousTmuxPane;
  }
});
test('external session route issues capabilities only for ssh and shell branches', async () => {
  const response = await request('/sessions/external');
  assertSuccess(response);
  const data = response.body.data!;
  const rows = data.externalSessions as Array<Record<string, unknown>>;
  assert.deepEqual(data.discovery, { ok: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].presence, 'present');
  assert.equal('attachCapability' in rows[0], false);

  const routeSource = await (await import('node:fs/promises')).readFile(
    path.resolve(process.cwd(), 'server/modules/providers/provider.routes.ts'),
    'utf8',
  );
  assert.match(routeSource, /session\.kind === 'ssh' \|\| session\.kind === 'shell'/);
  assert.match(routeSource, /return attachCapability \? \{ \.\.\.base, attachCapability \} : base;/);
});

