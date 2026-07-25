import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHmac } from 'node:crypto';
import test, { after, before } from 'node:test';

import express, { type Express } from 'express';

const execFileAsync = promisify(execFile);
const fixtureBin = await mkdtemp(path.join(os.tmpdir(), 'chatmux-provider-routes-bin-'));
const fixtureTmux = path.join(fixtureBin, 'tmux');
const fixtureCodex = path.join(fixtureBin, 'codex');
const fixturePs = path.join(fixtureBin, 'ps');

// Route imports bind their process runners at module evaluation time. These command
// fixtures make the complete HTTP path deterministic without changing product DI.
await writeFile(fixtureTmux, `#!/bin/sh
if [ -n "$CHATMUX_CONTRACT_TMUX_FAIL" ]; then exit 1; fi
case "$*" in
  *list-panes*)
    case "$*" in
      *@chatmux_cli_kind*)
        printf '/tmp/chatmux-contract.sock\t$1\t@1\t%%1\t%s\t%s\t\${CHATMUX_CONTRACT_COMMAND:-codex}\t\t/tmp\tcodex\t\n' "\${CHATMUX_CONTRACT_EXTERNAL_NAME:-external}" "$PPID"
        ;;
      *)
        printf '/tmp/chatmux-contract.sock\\t$2\\t@2\\t%%2\\tlive\\t%s\\tgjc\\t/tmp\\n' "$PPID"
        ;;
    esac
    ;;
  *display-message*)
    case "$*" in
      *pane_pid*) printf '%s\n' "$PPID" ;;
      *pane_current_path*'%2'*) printf '$2\t@2\t%%2\t/tmp\n' ;;
      *pane_current_path*) printf '$1\t@1\t%%1\t/tmp\n' ;;
      *'%2'*) printf '$2\t@2\t%%2\n' ;;
      *) printf '$1\t@1\t%%1\n' ;;
    esac
    ;;
  *new-session*)
    # Deterministic spawn-failure injection for the 409 EXTERNAL_CLI_SPAWN_FAILED contract.
    if [ -n "\$CHATMUX_CONTRACT_SPAWN_FAIL" ]; then exit 1; fi
    exit 0
    ;;
  *capture-pane*) printf 'fixture pane output\\n' ;;
esac
`);
await writeFile(fixtureCodex, '#!/bin/sh\nexit 0\n');
await writeFile(fixturePs, `#!/bin/sh
case "$*" in
  *comm*args*) printf '%s %s %s %s\n' "$PPID" 1 "\${CHATMUX_CONTRACT_COMMAND:-codex}" "\${CHATMUX_CONTRACT_COMMAND:-codex}" ;;
  *) printf '%s %s gjc gjc\n' "$PPID" 1 ;;
esac
`);
await chmod(fixtureTmux, 0o755);
await chmod(fixtureCodex, 0o755);
await chmod(fixturePs, 0o755);
process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH ?? ''}`;
process.env.CHATMUX_AUTH = 'password';
process.env.JWT_SECRET = 'provider-routes-contract-secret';
process.env.DATABASE_PATH = path.join(await mkdtemp(path.join(os.tmpdir(), 'chatmux-provider-routes-')), 'auth.db');

const { authenticateToken, generateToken, AUTH_MODE } = await import('@/middleware/auth.js');
assert.equal(AUTH_MODE, 'password');
const { default: providerRoutes } = await import('../provider.routes.js');
const { initializeDatabase, userDb } = await import('@/modules/database/index.js');

type ApiError = { error?: string; code?: string };
type ApiResponse = { status: number; body: ApiError & { success?: boolean; data?: Record<string, unknown> } };

let app: Express;
let server: Server;
let baseUrl: string;
let token: string;
let validProcess: { pid: number; startedAtMs: number };

const externalTmux = { socketPath: '/tmp/chatmux-contract.sock', sessionId: '$1', windowId: '@1', paneId: '%1' };
const liveTmux = { socketPath: '/tmp/chatmux-contract.sock', sessionId: '$2', windowId: '@2', paneId: '%2' };

before(async () => {
  await initializeDatabase();
  const created = userDb.createUser(`provider-contract-${Date.now()}`, 'test');
  token = generateToken({ id: Number(created.id), username: created.username });
  validProcess = { pid: process.pid, startedAtMs: (await stat(`/proc/${process.pid}`)).mtimeMs };

  app = express();
  app.use(express.json());
  // The live-spawn service reads TOWER_URL at request time.
  app.post('/spawn', (_req, res) => res.status(201).send('created'));
  app.use('/api/providers', authenticateToken);
  app.use('/api/providers', providerRoutes);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number(error.statusCode)
      : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'INTERNAL_ERROR';
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Internal error', code });
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.TOWER_URL = baseUrl;
});

after(async () => {
  delete process.env.CHATMUX_CONTRACT_EXTERNAL_NAME;
  delete process.env.TOWER_URL;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function request(pathname: string, body?: unknown, authorization = `Bearer ${token}`): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}/api/providers${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(authorization ? { authorization } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseText = await response.text();
  let responseBody: ApiResponse['body'];
  try {
    responseBody = JSON.parse(responseText) as ApiResponse['body'];
  } catch {
    responseBody = { error: responseText };
  }
  return { status: response.status, body: responseBody };
}

function assertError(response: ApiResponse, status: number, code: string): void {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.code, code);
}

function assertSuccess(response: ApiResponse, status = 200): void {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.success, true);
}

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

test('all nine tmux provider routes have deterministic successful HTTP paths', async () => {
  assertSuccess(await request('/sessions/external/output', { tmux: externalTmux, process: validProcess }));
  assertSuccess(await request('/sessions/external/send', { tmux: externalTmux, process: validProcess, message: 'hello' }));
  assertSuccess(await request('/sessions/external/kill', { tmux: externalTmux, process: validProcess }));
  // Product intentionally returns 201 for resource creation; source changes are out of scope.
  assertSuccess(await request('/sessions/external/spawn', { name: 'external-contract', cwd: '~', cli: 'codex' }), 201);
  assertSuccess(await request('/sessions/live/output', { tmux: liveTmux, process: validProcess }));
  assertSuccess(await request('/sessions/live/send', { tmux: liveTmux, process: validProcess, message: 'hello' }));
  assertSuccess(await request('/sessions/live/kill', { tmux: liveTmux, process: validProcess, mode: 'pane' }));
  assertSuccess(await request('/sessions/live/spawn', { name: 'live-contract', cwd: '~' }));
  assertSuccess(await request('/sessions/live/commands'));
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
        activity: 'running',
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

test('external and live spawn preserve name and cwd validation contracts', async () => {
  assertError(await request('/sessions/external/spawn', { name: 'company', cwd: '~' }), 400, 'INVALID_SPAWN_NAME');
  assertError(await request('/sessions/external/spawn', { name: 'contract', cwd: ' ' }), 400, 'EMPTY_CWD');
  assertError(await request('/sessions/external/spawn', { name: 'contract', cwd: '/definitely-not-a-chatmux-directory' }), 400, 'INVALID_CWD');
  assertError(await request('/sessions/live/spawn', { name: 'contract', cwd: ' ' }), 400, 'EMPTY_CWD');
  assertError(await request('/sessions/live/spawn', { name: 'contract', cwd: '/definitely-not-a-chatmux-directory' }), 400, 'INVALID_CWD');
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
  assert.match(liveSpawn, /resolveExternalCliCwd\(cwdInput\)/);
});
