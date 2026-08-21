import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import {
  createTmuxE2EHarness,
  type FakeTmuxAgent,
} from '../../server/modules/providers/tests/support/tmux-e2e-harness.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);
const operatorHome = process.env.HOME;
const serverPort = Number.parseInt(process.env.CUA_SERVER_PORT ?? '4311', 10);
const vitePort = Number.parseInt(process.env.CUA_VITE_PORT ?? '4310', 10);
const runId = process.env.CUA_RUN_ID
  ?? new Date().toISOString().replaceAll(/[:.]/g, '-');
const evidenceRoot = path.join(repositoryRoot, '.omo', 'cua', 'runs', runId);
const currentPath = path.join(repositoryRoot, '.omo', 'cua', 'current.json');
const baseUrl = `http://127.0.0.1:${vitePort}`;
const apiUrl = `http://127.0.0.1:${serverPort}`;

type FixtureAgent = {
  kind: 'omo' | 'claude' | 'codex' | 'cursor' | 'opencode' | 'gjc' | 'omp';
  displayName: string;
  tmuxName: string;
  agent: FakeTmuxAgent;
};

async function waitForHttp(url: string, description: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(5_000).then(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }),
  ]);
}

await mkdir(evidenceRoot, { recursive: true });
const harness = await createTmuxE2EHarness();
let devProcess: ChildProcess | null = null;
let stopping = false;

const stop = async (reason: string, exitCode = 0): Promise<never> => {
  if (stopping) {
    await new Promise(() => undefined);
  }
  stopping = true;
  await stopChild(devProcess);
  await harness.dispose();
  await rm(currentPath, { force: true });
  await writeFile(
    path.join(evidenceRoot, 'stopped.json'),
    `${JSON.stringify({ runId, reason, stoppedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  process.exit(exitCode);
};

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

try {
  const definitions = [
    ['omo', 'Oh My OpenAgent', 'cua-01-omo'],
    ['claude', 'Claude Code', 'cua-02-claude'],
    ['codex', 'Codex', 'cua-03-codex'],
    ['cursor', 'Cursor', 'cua-04-cursor'],
    ['opencode', 'OpenCode', 'cua-05-opencode'],
    ['gjc', 'Gajae Code', 'cua-06-gjc'],
    ['omp', 'Oh My Pi', 'cua-07-omp'],
  ] as const;
  const fixtures: FixtureAgent[] = [];
  let gjcTranscriptAgent: Awaited<ReturnType<typeof harness.startFakeGjcWithTranscript>> | null = null;
  let codexTranscriptAgent: Awaited<ReturnType<typeof harness.startFakeCodexWithTranscript>> | null = null;
  for (const [kind, displayName, tmuxName] of definitions) {
    const agent = kind === 'codex'
      ? await harness.startFakeCodexWithTranscript(
        tmuxName,
        '019f0000-0000-7000-8000-000000000103',
      )
      : kind === 'gjc'
        ? await harness.startFakeGjcWithTranscript(
          tmuxName,
          '019f0000-0000-7000-8000-000000000106',
        )
        : await harness.startFakeExternal(kind, tmuxName);
    if (kind === 'codex') codexTranscriptAgent = agent;
    if (kind === 'gjc') gjcTranscriptAgent = agent;
    fixtures.push({ kind, displayName, tmuxName, agent });
  }
  await Promise.all(fixtures.map(({ agent }) => agent.waitUntilReady()));
  const openingPrompt = 'Give a concise status update for the ChatMux validation run.';
  await execFileAsync('tmux', [
    'send-keys',
    '-t',
    '=cua-03-codex:',
    '-l',
    openingPrompt,
  ], { env: process.env });
  await execFileAsync('tmux', ['send-keys', '-t', '=cua-03-codex:', 'Enter'], {
    env: process.env,
  });
  await codexTranscriptAgent?.waitForInput(openingPrompt);
  await codexTranscriptAgent?.waitForTranscript();

  const externalSessions = await harness.discoverFromFreshProcess();
  const runtimeEnv = {
    ...process.env,
    CHATMUX_AUTH: 'none',
    CHATMUX_LIVE_NOTIFY: '0',
    HOST: '127.0.0.1',
    SERVER_PORT: String(serverPort),
    VITE_PORT: String(vitePort),
    PATH: [
      harness.root,
      path.join(harness.workspace, 'node_modules', '.bin'),
      process.env.PATH ?? '',
    ].join(path.delimiter),
    ...(operatorHome
      ? {
        CARGO_HOME: process.env.CARGO_HOME ?? path.join(operatorHome, '.cargo'),
        RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(operatorHome, '.rustup'),
      }
      : {}),
  };
  devProcess = spawn('npm', ['run', 'dev'], {
    cwd: repositoryRoot,
    env: runtimeEnv,
    stdio: 'inherit',
  });
  devProcess.once('exit', (code, signal) => {
    if (!stopping) void stop(`development server exited (${code ?? signal ?? 'unknown'})`, 1);
  });

  await Promise.all([
    waitForHttp(`${apiUrl}/health`, 'ChatMux API'),
    waitForHttp(baseUrl, 'ChatMux frontend'),
  ]);

  const [externalResponse, liveResponse] = await Promise.all([
    fetch(`${apiUrl}/api/providers/sessions/external`).then((response) => response.json()),
    fetch(`${apiUrl}/api/providers/sessions/live`).then((response) => response.json()),
  ]);
  const manifest = {
    runId,
    startedAt: new Date().toISOString(),
    baseUrl,
    apiUrl,
    evidenceRoot,
    harnessRoot: harness.root,
    workspace: harness.workspace,
    gjcTranscriptPath: gjcTranscriptAgent?.transcriptPath ?? null,
    codexTranscriptPath: codexTranscriptAgent?.transcriptPath ?? null,
    agents: fixtures.map(({ kind, displayName, tmuxName, agent }) => ({
      kind,
      displayName,
      tmuxName,
      logPath: agent.logPath,
    })),
    discoveryProbe: externalSessions,
    api: {
      external: externalResponse,
      live: liveResponse,
    },
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(evidenceRoot, 'fixture.json'), manifestJson, 'utf8'),
    mkdir(path.dirname(currentPath), { recursive: true }).then(
      () => writeFile(currentPath, manifestJson, 'utf8'),
    ),
  ]);
  process.stdout.write(`\nCUA_FIXTURE_READY=${JSON.stringify({
    runId,
    baseUrl,
    apiUrl,
    evidenceRoot,
  })}\n`);

  await new Promise<void>(() => undefined);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await stop('startup failure', 1);
}
