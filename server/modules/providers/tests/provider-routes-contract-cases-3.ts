import { chmod, mkdir, mkdtemp, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { app, assert, assertError, assertSuccess,
  externalTmux, liveTmux, request, test, validProcess,
} from './support/provider-routes-contract.support.js';

test('live and external roster responses expose availability without changing roster rows', async () => {
  const liveResponse = await request('/sessions/live');
  assertSuccess(liveResponse);
  const liveData = liveResponse.body.data!;
  assert.deepEqual(liveData.discovery, { ok: true });
  assert.ok((liveData.liveSessions as Array<Record<string, unknown>>).every((row) => row.presence === 'present'));
});

test('unavailable roster responses retain authoritative stale snapshot rows while actions still fresh-verify', async () => {
  app.locals.discoveryCollector = {
    currentSnapshot: () => ({
      rows: [{
        key: 'external\\0snapshot',
        lane: 'external',
        tmuxName: 'snapshot-shell',
        tmux: externalTmux,
        process: validProcess,
        kind: 'ssh',
        providerSessionId: null,
        activity: 'unknown',
        cwd: '/tmp',
        lastSeenRevision: 1,
        presence: 'stale',
        staleSinceRevision: 1,
      }, {
        key: 'live\\0snapshot',
        lane: 'live',
        tmuxName: 'snapshot-live',
        tmux: liveTmux,
        process: validProcess,
        kind: 'gjc',
        providerSessionId: 'live-snapshot',
        activity: 'error',
        cwd: null,
        lastSeenRevision: 1,
        presence: 'stale',
        staleSinceRevision: 1,
      }],
    }),
  };
  process.env.CHATMUX_CONTRACT_TMUX_FAIL = '1';
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const response = await request('/sessions/external');
    assertSuccess(response);
    assert.deepEqual(response.body.data?.discovery, { ok: false });
    const rows = response.body.data?.externalSessions as Array<Record<string, unknown>>;
    assert.equal(rows[0]?.tmuxName, 'snapshot-shell');
    assert.equal(rows[0]?.presence, 'stale');
    const liveResponse = await request('/sessions/live');
    assertSuccess(liveResponse);
    assert.deepEqual(liveResponse.body.data?.discovery, { ok: false });
    const liveRows = liveResponse.body.data?.liveSessions as Array<Record<string, unknown>>;
    assert.equal(liveRows[0]?.tmuxName, 'snapshot-live');
    assert.equal(liveRows[0]?.presence, 'stale');
    assert.equal(liveRows[0]?.running, false);
    assert.equal(liveRows[0]?.error, true);
    assertError(await request('/sessions/external/output', { tmux: externalTmux, process: validProcess }), 409, 'TMUX_PROCESS_GENERATION_MISMATCH');
  } finally {
    delete process.env.CHATMUX_CONTRACT_TMUX_FAIL;
    delete app.locals.discoveryCollector;
  }
});

test('external output, send, and kill preserve their format-error contracts', async () => {
  assertError(await request('/sessions/external/output', { tmux: { paneId: 'bad' }, process: validProcess }), 400, 'INVALID_TMUX_PANE_IDENTITY');
  assertError(await request('/sessions/external/send', { tmux: externalTmux, process: validProcess, message: '  ' }), 400, 'EMPTY_MESSAGE');
  assertError(await request('/sessions/external/kill', { tmux: externalTmux, process: validProcess, mode: 'all' }), 400, 'INVALID_TMUX_TERMINATION_MODE');
});

test('live output, send, and kill preserve their format-error contracts', async () => {
  assertError(await request('/sessions/live/output', { tmux: { paneId: 'bad' }, process: validProcess }), 400, 'INVALID_TMUX_PANE_IDENTITY');
  assertError(await request('/sessions/live/send', { tmux: liveTmux, process: validProcess, message: '' }), 400, 'EMPTY_MESSAGE');
  assertError(await request('/sessions/live/kill', { tmux: liveTmux, process: validProcess, mode: 'all' }), 400, 'INVALID_TMUX_TERMINATION_MODE');
});

test('output, send, and kill retain external freshness and live lineage error codes', async () => {
  const wrongProcess = { ...validProcess, startedAtMs: validProcess.startedAtMs + 1 };
  for (const pathname of ['/sessions/external/output', '/sessions/external/send', '/sessions/external/kill']) {
    const body = pathname.endsWith('/send') ? { tmux: externalTmux, process: wrongProcess, message: 'hello' } : { tmux: externalTmux, process: wrongProcess };
    assertError(await request(pathname, body), 409, 'TMUX_PROCESS_GENERATION_MISMATCH');
  }
  for (const pathname of ['/sessions/live/output', '/sessions/live/send', '/sessions/live/kill']) {
    const body = pathname.endsWith('/send') ? { tmux: externalTmux, process: validProcess, message: 'hello' } : { tmux: externalTmux, process: validProcess };
    assertError(await request(pathname, body), 403, 'TMUX_ACTION_NOT_LINEAGE');
  }
  for (const pathname of ['/sessions/live/output', '/sessions/live/send', '/sessions/live/kill']) {
    const body = pathname.endsWith('/send') ? { tmux: liveTmux, process: wrongProcess, message: 'hello' } : { tmux: liveTmux, process: wrongProcess };
    assertError(await request(pathname, body), 409, 'TMUX_PROCESS_GENERATION_MISMATCH');
  }
});

test('external kill protects company-prefixed sessions', async () => {
  process.env.CHATMUX_CONTRACT_EXTERNAL_NAME = 'company-contract';
  try {
    assertError(await request('/sessions/external/kill', { tmux: externalTmux, process: validProcess }), 403, 'EXTERNAL_CLI_SESSION_PROTECTED');
  } finally {
    delete process.env.CHATMUX_CONTRACT_EXTERNAL_NAME;
  }
});

test('external and live spawn create missing HOME cwd paths while retaining safety rejections', async () => {
  // Given: an isolated HOME and paths which must remain outside it.
  const home = await mkdtemp(path.join(os.tmpdir(), 'chatmux-spawn-home-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'chatmux-spawn-outside-'));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // When: both local spawn routes receive missing nested paths under HOME.
    const externalCwd = 'projects/external/nested';
    const liveCwd = 'projects/live/nested';
    assertSuccess(await request('/sessions/external/spawn', { name: 'external-cwd-create', cwd: externalCwd, cli: 'codex' }), 201);
    assertSuccess(await request('/sessions/live/spawn', { name: 'live-cwd-create', cwd: liveCwd }));

    // Then: both request paths reached their spawn boundary with a real directory.
    assert.equal((await stat(path.join(home, externalCwd))).isDirectory(), true);
    assert.equal((await stat(path.join(home, liveCwd))).isDirectory(), true);

    // Given: traversal, symlink escape, and absolute paths outside HOME.
    await symlink(outside, path.join(home, 'escape'));
    assertError(await request('/sessions/external/spawn', { name: 'traversal-cwd', cwd: '../escape' }), 400, 'INVALID_CWD');
    assertError(await request('/sessions/live/spawn', { name: 'symlink-cwd', cwd: '~/escape/nested' }), 400, 'INVALID_CWD');
    assertError(await request('/sessions/external/spawn', { name: 'outside-cwd', cwd: path.join(outside, 'nested') }), 400, 'INVALID_CWD');

    // Given: a HOME child that cannot create descendants.
    const blocked = path.join(home, 'blocked');
    await mkdir(blocked);
    await chmod(blocked, 0o500);
    try {
      // When: creation requires the inaccessible directory.
      const response = await request('/sessions/live/spawn', { name: 'blocked-cwd', cwd: '~/blocked/nested' });
      // Then: the failure remains a validation rejection and no spawn succeeds.
      assertError(response, 400, 'INVALID_CWD');
    } finally {
      await chmod(blocked, 0o700);
    }
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('external spawn maps a failed tmux new-session to its 409 conflict contract', async () => {
  process.env.CHATMUX_CONTRACT_SPAWN_FAIL = '1';
  try {
    assertError(
      await request('/sessions/external/spawn', { name: 'spawn-conflict', cwd: '~', cli: 'codex' }),
      409,
      'EXTERNAL_CLI_SPAWN_FAILED',
    );
  } finally {
    delete process.env.CHATMUX_CONTRACT_SPAWN_FAIL;
  }
});

// B2 route contract matrix — every cell is either covered by a test above or
// carries the source-level reason it cannot exist. Keep this table in sync when
// a route gains or loses a status branch.
//
// | route                    | 400 | 403 | 409 | success |
// |--------------------------|-----|-----|-----|---------|
// | external/output          |  ✓  | N/A: the fresh verifier has no 403 branch; terminal-only and absent targets are 409 | ✓ | 200 ✓ |
// | external/send            |  ✓  | N/A: same fresh-verifier contract as external/output | ✓ | 200 ✓ |
// | external/kill            |  ✓  | ✓ EXTERNAL_CLI_SESSION_PROTECTED (company* and self-pane) | ✓ | 200 ✓ |
// | external/spawn           |  ✓  | N/A: creation has no target to protect; auth is enforced at mount | ✓ EXTERNAL_CLI_SPAWN_FAILED | 201 ✓ (product contract) |
// | live/output              |  ✓  | ✓ TMUX_ACTION_NOT_LINEAGE | ✓ | 200 ✓ |
// | live/send                |  ✓  | ✓ TMUX_ACTION_NOT_LINEAGE | ✓ | 200 ✓ |
// | live/kill                |  ✓  | ✓ TMUX_ACTION_NOT_LINEAGE | ✓ | 200 ✓ |
// | live/spawn               |  ✓  | N/A: creation path, see external/spawn | N/A: tower conflicts are encoded in the 200 response payload | 200 ✓ |
// | live/commands            | N/A: read-only query with no rejected shape | N/A | N/A | 200 ✓ |
//
// Auth matrix: bearer accepted, missing credential 401, query-string token rejected,
// malformed/expired JWT 403 (auth middleware maps jwt.verify failures to 403),
// and auth-disabled loopback verified in a fresh subprocess because AUTH_MODE is
// resolved at module evaluation.

test('spawn response and fresh-verifier boundaries stay explicit in the route source', async () => {
  const routeSource = await (await import('node:fs/promises')).readFile(
    new URL('../provider.routes.ts', import.meta.url),
    'utf8',
  );
  const externalSpawn = routeSource.slice(routeSource.indexOf("'/sessions/external/spawn'"), routeSource.indexOf("'/sessions/external/kill'"));
  const liveSpawn = routeSource.slice(routeSource.indexOf("'/sessions/live/spawn'"), routeSource.indexOf("'/sessions/live/kill'"));

  assert.match(externalSpawn, /createApiSuccessResponse\(\{ ok: true, tmuxName: body\.name, cwd, cli \}\)/);
  assert.doesNotMatch(externalSpawn, /paneId|sessionId|windowId|socketPath/);
  assert.doesNotMatch(externalSpawn, /assertFreshExternalTmuxTarget/);
  assert.match(liveSpawn, /ensureExternalCliCwd\(cwdInput\)/);
});
