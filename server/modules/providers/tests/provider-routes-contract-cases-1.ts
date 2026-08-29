import {
  access, assert, assertSuccess, baseUrl, createHmac, execFileAsync,
  externalTmux, fixtureBin, liveTmux, mkdtemp, os,
  path, request, sessionsDb, test, token, validProcess, writeFile,
} from './support/provider-routes-contract.support.js';

test('provider routes enforce bearer-only password authentication and reject malformed credentials', async () => {
  assert.equal((await request('/sessions/live/commands', undefined, '')).status, 401);
  assert.equal((await request(`/sessions/live/commands?token=${encodeURIComponent(token)}`, undefined, '')).status, 401);
  assertSuccess(await request('/sessions/live/commands'));
  // authenticateToken currently maps jwt.verify failures (bad and expired JWTs) to 403,
  // not 401; this locks the implemented contract rather than claiming unsupported 401.
  assert.equal((await request('/sessions/live/commands', undefined, 'Basic abc')).status, 401);
  assert.equal((await request('/sessions/live/commands', undefined, 'Bearer definitely-not-a-jwt')).status, 403);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ userId: 1, username: 'expired', tokenVersion: 0, exp: 1 })).toString('base64url');
  const expired = `${header}.${payload}.${createHmac('sha256', process.env.JWT_SECRET!).update(`${header}.${payload}`).digest('base64url')}`;
  assert.equal((await request('/sessions/live/commands', undefined, `Bearer ${expired}`)).status, 403);
});

test('archive session routes are removed and deletion is permanent', async () => {
  assert.equal((await request('/sessions/archived')).status, 404);
  assert.equal((await request('/sessions/missing/restore', {})).status, 404);

  const transcriptPath = path.join(fixtureBin, 'delete-session.jsonl');
  await writeFile(transcriptPath, '{"type":"message"}\n');
  const sessionId = sessionsDb.createSession(
    'delete-provider-session',
    'claude',
    '/workspace/provider-delete-contract',
    'Delete me',
    undefined,
    undefined,
    transcriptPath,
  );

  const response = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    data: {
      sessionId,
      action: 'deleted',
      deletedFromDisk: true,
    },
  });
  assert.equal(sessionsDb.getSessionById(sessionId), null);
  await assert.rejects(
    access(transcriptPath),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
});

test('session deletion rejects a transcript shared with another session', async () => {
  const transcriptPath = path.join(fixtureBin, 'shared-delete-session.jsonl');
  await writeFile(transcriptPath, '{"type":"message"}\n');
  const targetSessionId = sessionsDb.createSession(
    'shared-delete-target',
    'claude',
    '/workspace/provider-shared-delete',
    undefined,
    undefined,
    undefined,
    transcriptPath,
  );
  const survivorSessionId = sessionsDb.createSession(
    'shared-delete-survivor',
    'claude',
    '/workspace/provider-shared-delete',
    undefined,
    undefined,
    undefined,
    transcriptPath,
  );

  const response = await fetch(`${baseUrl}/api/providers/sessions/${targetSessionId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json() as { code?: string };

  assert.equal(response.status, 409);
  assert.equal(body.code, 'SESSION_TRANSCRIPT_SHARED');
  assert.ok(sessionsDb.getSessionById(targetSessionId));
  assert.ok(sessionsDb.getSessionById(survivorSessionId));
  await access(transcriptPath);
});

test('auth-disabled mode accepts loopback provider requests without a bearer token', async () => {
  const script = `
    import express from 'express';
    import { createServer } from 'node:http';
    const { initializeDatabase } = await import('./server/modules/database/index.js');
    await initializeDatabase();
    const { authenticateToken, AUTH_MODE } = await import('./server/middleware/auth.js');
    const { default: providerRoutes } = await import('./server/modules/providers/provider.routes.js');
    const app = express();
    app.use('/api/providers', authenticateToken, providerRoutes);
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const statuses = await Promise.all(['', 'Basic malformed'].map(async (authorization) => {
      const response = await fetch('http://127.0.0.1:' + port + '/api/providers/sessions/live/commands', {
        headers: authorization ? { authorization } : {},
      });
      return response.status;
    }));
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    console.log(JSON.stringify({ AUTH_MODE, statuses }));
  `;
  const databasePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'chatmux-auth-none-')), 'auth.db');
  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, CHATMUX_AUTH: 'none', DATABASE_PATH: databasePath },
  });
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!) as { AUTH_MODE: string; statuses: number[] };
  assert.equal(result.AUTH_MODE, 'none');
  assert.deepEqual(result.statuses, [200, 200]);
});

test('core tmux provider routes have deterministic successful HTTP paths', async () => {
  assertSuccess(await request('/sessions/external/output', { tmux: externalTmux, process: validProcess }));
  assertSuccess(await request('/sessions/external/send', { tmux: externalTmux, process: validProcess, message: 'hello' }));
  assertSuccess(await request('/sessions/external/actions', { tmux: externalTmux, process: validProcess, action: 'interrupt' }));
  assertSuccess(await request('/sessions/external/kill', { tmux: externalTmux, process: validProcess }));
  // Product intentionally returns 201 for resource creation; source changes are out of scope.
  assertSuccess(await request('/sessions/external/spawn', { name: 'external-contract', cwd: '~', cli: 'codex' }), 201);
  assertSuccess(await request('/sessions/live/output', { tmux: liveTmux, process: validProcess }));
  assertSuccess(await request('/sessions/live/send', { tmux: liveTmux, process: validProcess, message: 'hello' }));
  assertSuccess(await request('/sessions/live/actions', { tmux: liveTmux, process: validProcess, action: 'escape' }));
  assertSuccess(await request('/sessions/live/kill', { tmux: liveTmux, process: validProcess, mode: 'pane' }));
  assertSuccess(await request('/sessions/live/spawn', { name: 'live-contract', cwd: '~' }));
  assertSuccess(await request('/sessions/live/commands'));
});

test('interactive routes read and answer active external and live TUI prompts without transcript ids', async () => {
  try {
    process.env.CHATMUX_CONTRACT_CAPTURE = [
      'Question 1/1 (1 unanswered)',
      'Choose an action',
      '› 1. Allow',
      '  2. Reject',
      '  3. None of the above',
      'tab to add notes | enter to submit answer | esc to interrupt',
    ].join('\n');
    const external = await request('/sessions/external/interactive', {
      tmux: externalTmux,
      process: validProcess,
    });
    assertSuccess(external);
    const externalPrompt = external.body.data?.prompt as { id?: string; options?: unknown[] } | undefined;
    assert.match(externalPrompt?.id ?? '', /^[a-f0-9]{32}$/);
    assert.equal(externalPrompt?.options?.length, 2);
    assertSuccess(await request('/sessions/external/interactive/respond', {
      tmux: externalTmux,
      process: validProcess,
      promptId: externalPrompt?.id,
      choices: [2],
    }));

    process.env.CHATMUX_CONTRACT_CAPTURE = [
      'Choose a target',
      '╭─────────────────────────╮',
      '│❯ CUDA                   │',
      '│  CPU                    │',
      '│  Other (type your own)  │',
      '╰─────────────────────────╯',
      'up/down navigate  enter select  esc cancel',
    ].join('\n');
    const live = await request('/sessions/live/interactive', {
      tmux: liveTmux,
      process: validProcess,
    });
    assertSuccess(live);
    const livePrompt = live.body.data?.prompt as { id?: string; options?: unknown[] } | undefined;
    assert.match(livePrompt?.id ?? '', /^[a-f0-9]{32}$/);
    assert.equal(livePrompt?.options?.length, 2);
    assertSuccess(await request('/sessions/live/interactive/respond', {
      tmux: liveTmux,
      process: validProcess,
      promptId: livePrompt?.id,
      choices: [1],
    }));
  } finally {
    delete process.env.CHATMUX_CONTRACT_CAPTURE;
  }
});

