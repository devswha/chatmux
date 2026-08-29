import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import test, { after, before } from 'node:test';

import express, { type Express } from 'express';

// --- Fixture binaries for deterministic subprocesses ---
const fixtureBin = await mkdtemp(path.join(os.tmpdir(), 'provider-skills-http-bin-'));

// Stub `gjc` - the GJC adapter may shell out to `gjc skills list --json`.
// Make it exit non-zero or return empty so we exercise safe-empty fallback.
const fixtureGjc = path.join(fixtureBin, 'gjc');
await writeFile(fixtureGjc, `#!/bin/sh
# Simulate native probe failure or empty manifest depending on env.
if [ -n "$CHATMUX_SKILLS_PROBE_FAIL" ]; then exit 1; fi
echo '[]'
`);
await chmod(fixtureGjc, 0o755);

// Stub tmux / ps so provider-commands.service doesn't hit real tmux.
const fixtureTmux = path.join(fixtureBin, 'tmux');
await writeFile(fixtureTmux, '#!/bin/sh\nexit 0\n');
await chmod(fixtureTmux, 0o755);
const fixturePs = path.join(fixtureBin, 'ps');
await writeFile(fixturePs, '#!/bin/sh\nexit 0\n');
await chmod(fixturePs, 0o755);

process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH ?? ''}`;
const originalTmuxPane = process.env.TMUX_PANE;
delete process.env.TMUX_PANE;
process.env.CHATMUX_AUTH = 'password';
process.env.JWT_SECRET = 'provider-skills-http-contract-secret';
process.env.DATABASE_PATH = path.join(
  await mkdtemp(path.join(os.tmpdir(), 'provider-skills-http-db-')),
  'auth.db',
);

const { authenticateToken, generateToken, AUTH_MODE } = await import('@/middleware/auth.js');
assert.equal(AUTH_MODE, 'password');
const { default: providerRoutes } = await import('../provider.routes.js');
const { initializeDatabase, userDb } = await import('@/modules/database/index.js');

type LLMProvider = 'claude' | 'codex' | 'cursor' | 'opencode' | 'gjc' | 'omp' | 'omo';
const ALL_PROVIDERS: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'gjc', 'omp', 'omo'];

// --- Workspace sandboxes: one distinct path per provider ---
const patchHomeDir = (dir: string): (() => void) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => dir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

type Sandbox = { homeDir: string; workspacePath: string; restore: () => void };
const sandboxes = new Map<LLMProvider, Sandbox>();

const SKILL_DIRS: Record<LLMProvider, { project: string[]; user: string[] }> = {
  claude: { project: ['.claude', 'skills'], user: ['.claude', 'skills'] },
  codex: { project: ['.agents', 'skills'], user: ['.agents', 'skills'] },
  cursor: { project: ['.cursor', 'skills'], user: ['.cursor', 'skills'] },
  opencode: { project: ['.opencode', 'skills'], user: ['.config', 'opencode', 'skills'] },
  gjc: { project: ['.gjc', 'skills'], user: ['.gjc', 'agent', 'skills'] },
  omp: { project: ['.omp', 'skills'], user: ['.omp', 'agent', 'skills'] },
  omo: { project: ['.omo', 'skills'], user: ['.omo', 'agent', 'skills'] },
};

async function writeSkillMd(dir: string, dirName: string, name: string): Promise<void> {
  const skillDir = path.join(dir, dirName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBody.\n`,
    'utf8',
  );
}

let homeDir: string;
let restoreHome: () => void;

let app: Express;
let server: Server;
let baseUrl: string;
let token: string;

before(async () => {
  // Single shared home directory for all providers.
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'provider-skills-http-home-'));
  restoreHome = patchHomeDir(homeDir);

  // Create per-provider workspace with project + user skills.
  for (const provider of ALL_PROVIDERS) {
    const workspacePath = path.join(homeDir, `workspace-${provider}`);
    await mkdir(workspacePath, { recursive: true });

    const dirs = SKILL_DIRS[provider];
    // Project skill
    await writeSkillMd(
      path.join(workspacePath, ...dirs.project),
      `${provider}-project-dir`,
      `${provider}-project`,
    );
    // User skill
    await writeSkillMd(
      path.join(homeDir, ...dirs.user),
      `${provider}-user-dir`,
      `${provider}-user`,
    );

    sandboxes.set(provider, { homeDir, workspacePath, restore: () => {} });
  }

  await initializeDatabase();
  const created = userDb.createUser(`skills-http-${Date.now()}`, 'test');
  token = generateToken({ id: Number(created.id), username: created.username });

  app = express();
  app.use(express.json());
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
});

after(async () => {
  restoreHome();
  if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = originalTmuxPane;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// --- HTTP helpers ---
type ApiResponse = {
  status: number;
  body: Record<string, unknown>;
};

async function get(pathname: string, authorization?: string): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}/api/providers${pathname}`, {
    method: 'GET',
    headers: authorization !== undefined
      ? (authorization ? { authorization } : {})
      : { authorization: `Bearer ${token}` },
  });
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, body };
}

// --- Tests ---

test('auth failure: missing bearer returns 401', async () => {
  const res = await get('/claude/skills', '');
  assert.equal(res.status, 401);
});

test('auth failure: malformed JWT returns 403', async () => {
  const res = await get('/claude/skills', 'Bearer not-a-real-jwt');
  assert.equal(res.status, 403);
});

test('auth failure: expired JWT returns 403', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ userId: 1, username: 'expired', tokenVersion: 0, exp: 1 })).toString('base64url');
  const expired = `${header}.${payload}.${createHmac('sha256', process.env.JWT_SECRET!).update(`${header}.${payload}`).digest('base64url')}`;
  const res = await get('/claude/skills', `Bearer ${expired}`);
  assert.equal(res.status, 403);
});

test('invalid provider returns 400 UNSUPPORTED_PROVIDER', async () => {
  const res = await get('/invalidprovider/skills');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'UNSUPPORTED_PROVIDER');
});

for (const provider of ALL_PROVIDERS) {
  test(`${provider}: GET /api/providers/:provider/skills returns exact {data:{provider,skills}} shape`, async () => {
    const sandbox = sandboxes.get(provider)!;
    const res = await get(`/${provider}/skills?workspacePath=${encodeURIComponent(sandbox.workspacePath)}`);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);

    // data must exist and be an object
    const data = res.body.data as Record<string, unknown>;
    assert.ok(data, 'response must include data');

    // Exact top-level keys: only provider + skills
    const dataKeys = Object.keys(data).sort();
    assert.deepEqual(dataKeys, ['provider', 'skills'], `no extra fields allowed; got: ${dataKeys.join(', ')}`);

    // provider field matches
    assert.equal(data.provider, provider);

    // skills is an array
    assert.ok(Array.isArray(data.skills), 'skills must be an array');
  });
}

test('workspace forwarding: skills change with workspacePath', async () => {
  // Use the claude sandbox workspace, then a workspace with no skills dir.
  const claudeSandbox = sandboxes.get('claude')!;
  const emptyWorkspace = path.join(homeDir, 'workspace-empty');
  await mkdir(emptyWorkspace, { recursive: true });

  const withSkills = await get(`/claude/skills?workspacePath=${encodeURIComponent(claudeSandbox.workspacePath)}`);
  const withoutSkills = await get(`/claude/skills?workspacePath=${encodeURIComponent(emptyWorkspace)}`);

  assert.equal(withSkills.status, 200);
  assert.equal(withoutSkills.status, 200);

  const skillsA = (withSkills.body.data as Record<string, unknown>).skills as unknown[];
  const skillsB = (withoutSkills.body.data as Record<string, unknown>).skills as unknown[];

  // With project skills in the workspace: more results (project + user).
  // Without: only user skills visible.
  assert.ok(
    skillsA.length > skillsB.length,
    `workspace forwarding: with skills (${skillsA.length}) must exceed without (${skillsB.length})`,
  );
});

test('stable order and dedupe: duplicate names across sources yield single entry', async () => {
  // Write a user-level skill AND a project-level skill with same name for codex.
  const dedupeWorkspace = path.join(homeDir, 'workspace-dedupe');
  await mkdir(dedupeWorkspace, { recursive: true });

  // Project skill
  await writeSkillMd(
    path.join(dedupeWorkspace, '.agents', 'skills'),
    'dedupe-test-dir',
    'dedupe-skill',
  );
  // User skill with same name (already written in .agents/skills under homeDir)
  await writeSkillMd(
    path.join(homeDir, '.agents', 'skills'),
    'dedupe-test-user-dir',
    'dedupe-skill',
  );

  const res = await get(`/codex/skills?workspacePath=${encodeURIComponent(dedupeWorkspace)}`);
  assert.equal(res.status, 200);
  const skills = (res.body.data as Record<string, unknown>).skills as Array<{ name: string; command: string }>;

  // Only one entry for 'dedupe-skill'
  const dupeEntries = skills.filter((s) => s.name === 'dedupe-skill');
  assert.equal(dupeEntries.length, 1, 'same-command skills must be deduped to one entry');

  // Verify the response is sorted stably: call twice, compare order.
  const res2 = await get(`/codex/skills?workspacePath=${encodeURIComponent(dedupeWorkspace)}`);
  const skills2 = (res2.body.data as Record<string, unknown>).skills as Array<{ name: string }>;
  assert.deepEqual(
    skills.map((s) => s.name),
    skills2.map((s) => s.name),
    'skills order must be stable across calls',
  );
});

test('native probe failure yields safe-empty skills array (not 500)', async () => {
  // Set gjc probe to fail.
  process.env.CHATMUX_SKILLS_PROBE_FAIL = '1';
  try {
    const gjcWorkspace = sandboxes.get('gjc')!.workspacePath;
    const res = await get(`/gjc/skills?workspacePath=${encodeURIComponent(gjcWorkspace)}`);
    // Must NOT be a 500 - the route must still succeed with whatever skills it can find.
    assert.equal(res.status, 200, `native probe failure must not crash; got ${res.status}`);
    assert.equal(res.body.success, true);
    const data = res.body.data as Record<string, unknown>;
    assert.ok(Array.isArray(data.skills));
  } finally {
    delete process.env.CHATMUX_SKILLS_PROBE_FAIL;
  }
});

test('manifest failure (gjc binary absent) yields safe-empty skills array', async () => {
  // Remove gjc from PATH temporarily.
  const origPath = process.env.PATH;
  process.env.PATH = (origPath ?? '').split(path.delimiter).filter((p) => p !== fixtureBin).join(path.delimiter);
  try {
    const gjcWorkspace = sandboxes.get('gjc')!.workspacePath;
    const res = await get(`/gjc/skills?workspacePath=${encodeURIComponent(gjcWorkspace)}`);
    // File-based skills should still work even if the native binary is missing.
    assert.equal(res.status, 200, `absent binary must not crash; got ${res.status}`);
    assert.equal(res.body.success, true);
    const data = res.body.data as Record<string, unknown>;
    assert.ok(Array.isArray(data.skills));
  } finally {
    process.env.PATH = origPath!;
  }
});

test('all seven provider IDs are covered with distinct workspace paths', () => {
  const paths = new Set<string>();
  for (const provider of ALL_PROVIDERS) {
    const sandbox = sandboxes.get(provider)!;
    paths.add(sandbox.workspacePath);
  }
  assert.equal(paths.size, ALL_PROVIDERS.length, 'each provider must use a distinct workspace');
});
