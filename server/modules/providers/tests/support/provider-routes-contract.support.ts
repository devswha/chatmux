import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHmac } from 'node:crypto';
import test, { after, before } from 'node:test';

import express, { type Express } from 'express';

import { processStartMs } from '../../services/process-start-time.service.js';

const execFileAsync = promisify(execFile);
const fixtureBin = await mkdtemp(path.join(os.tmpdir(), 'chatmux-provider-routes-bin-'));
const fixtureTmux = path.join(fixtureBin, 'tmux');
const fixtureCodex = path.join(fixtureBin, 'codex');
const fixturePs = path.join(fixtureBin, 'ps');

// Route imports bind their process runners at module evaluation time. These command
// fixtures make the complete HTTP path deterministic without changing product DI.
await writeFile(fixtureTmux, `#!/bin/sh
if [ -n "$CHATMUX_CONTRACT_TMUX_LOG" ]; then
  printf '%s\\n' "$*" >> "$CHATMUX_CONTRACT_TMUX_LOG"
fi
if [ -n "$CHATMUX_CONTRACT_TMUX_FAIL" ]; then exit 1; fi
case "$*" in
  *list-panes*)
    if [ "$CHATMUX_CONTRACT_DISCOVERY_LANE" = "live" ]; then
      printf '/tmp/chatmux-contract.sock\t$2\t@2\t%%2\tlive\t%s\tgjc\t\t/tmp\t\t\n' "$PPID"
    else
      printf '/tmp/chatmux-contract.sock\t$1\t@1\t%%1\t%s\t%s\t\${CHATMUX_CONTRACT_COMMAND:-codex}\t\t/tmp\tcodex\t%s\n' "\${CHATMUX_CONTRACT_EXTERNAL_NAME:-external}" "$PPID" "\${CHATMUX_CONTRACT_PROVIDER_SESSION_ID:-}"
    fi
    ;;
  *display-message*)
    if [ -n "$CHATMUX_CONTRACT_SELF_PANE_FAIL" ]; then
      case "$*" in *" -t %9 "*) exit 1 ;; esac
    fi
    case "$*" in
      *'%2'*socket_path*) printf '/tmp/chatmux-contract.sock\t$2\t@2\t%%2\n' ;;
      *socket_path*) printf '/tmp/chatmux-contract.sock\t$1\t@1\t%%1\n' ;;
      *'%2'*pane_current_path*pane_pid*) printf '$2\t@2\t%%2\t/tmp\t%s\n' "$PPID" ;;
      *pane_current_path*pane_pid*) printf '$1\t@1\t%%1\t/tmp\t%s\n' "$PPID" ;;
      *pane_pid*) printf '%s\n' "$PPID" ;;
      *'%2'*pane_current_path*) printf '$2\t@2\t%%2\t/tmp\n' ;;
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
  *capture-pane*) printf '%s\\n' "\${CHATMUX_CONTRACT_CAPTURE:-fixture pane output}" ;;
esac
`);
await writeFile(fixtureCodex, '#!/bin/sh\nexit 0\n');
await writeFile(fixturePs, `#!/bin/sh
if [ "$CHATMUX_CONTRACT_DISCOVERY_LANE" = "live" ]; then
  printf '%s %s gjc gjc\n' "$PPID" 1
else
  printf '%s %s %s %s\n' "$PPID" 1 "\${CHATMUX_CONTRACT_COMMAND:-codex}" "\${CHATMUX_CONTRACT_COMMAND:-codex}"
fi
`);
await chmod(fixtureTmux, 0o755);
await chmod(fixtureCodex, 0o755);
await chmod(fixturePs, 0o755);
process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH ?? ''}`;
const originalTmuxPane = process.env.TMUX_PANE;
delete process.env.TMUX_PANE;
process.env.CHATMUX_AUTH = 'password';
process.env.JWT_SECRET = 'provider-routes-contract-secret';
process.env.DATABASE_PATH = path.join(await mkdtemp(path.join(os.tmpdir(), 'chatmux-provider-routes-')), 'auth.db');

const { authenticateToken, generateToken, AUTH_MODE } = await import('@/middleware/auth.js');
assert.equal(AUTH_MODE, 'password');
const { default: providerRoutes } = await import('../../provider.routes.js');
const { getCurrentTmuxPaneIdentityState } = await import('../../services/external-cli-sessions.service.js');
const { initializeDatabase, sessionsDb, userDb } = await import('@/modules/database/index.js');

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
  const startedAtMs = await processStartMs(process.pid);
  if (startedAtMs === null) throw new Error('test process generation unavailable');
  validProcess = { pid: process.pid, startedAtMs };

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
  delete process.env.CHATMUX_CONTRACT_PROVIDER_SESSION_ID;
  delete process.env.CHATMUX_CONTRACT_CAPTURE;
  delete process.env.TOWER_URL;
  if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = originalTmuxPane;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function request(pathname: string, body?: unknown, authorization = `Bearer ${token}`): Promise<ApiResponse> {
  process.env.CHATMUX_CONTRACT_DISCOVERY_LANE = pathname.startsWith('/sessions/live')
    ? 'live'
    : 'external';
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


export {
  access, app, assert, assertError, assertSuccess, baseUrl, createHmac, execFileAsync,
  externalTmux, fixtureBin, getCurrentTmuxPaneIdentityState, liveTmux, mkdtemp, os,
  path, processStartMs, request, sessionsDb, test, token, validProcess, writeFile,
};
export type { ApiResponse };
