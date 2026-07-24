import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { ExternalCliSession } from '@/modules/providers/services/external-cli-sessions.service.js';

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const DISCOVERY_MARKER = '__CHATMUX_TMUX_E2E_SESSIONS__=';
const ENVIRONMENT_KEYS = ['HOME', 'DATABASE_PATH', 'TMUX', 'TMUX_TMPDIR'] as const;
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,}$/;

type EnvironmentKey = typeof ENVIRONMENT_KEYS[number];
type EnvironmentSnapshot = Record<EnvironmentKey, string | undefined>;
type FakeAgentEvent =
  | { type: 'ready'; pid: number }
  | { type: 'input'; value: string }
  | { type: 'transcript'; path: string; sessionId: string };

export type FakeTmuxAgent = {
  sessionName: string;
  logPath: string;
  events: () => Promise<FakeAgentEvent[]>;
  waitUntilReady: () => Promise<void>;
  waitForInput: (value: string) => Promise<void>;
};

export type FakeTranscriptTmuxAgent = FakeTmuxAgent & {
  sessionId: string;
  transcriptPath: string;
  waitForTranscript: () => Promise<void>;
};

export type TmuxE2EHarness = {
  root: string;
  workspace: string;
  discoverFromFreshProcess: () => Promise<ExternalCliSession[]>;
  dispose: () => Promise<void>;
  getSessionId: (sessionName: string) => Promise<string>;
  hasSession: (sessionName: string) => Promise<boolean>;
  killSession: (sessionName: string) => Promise<void>;
  startFakeCodex: (sessionName: string, cwd?: string) => Promise<FakeTmuxAgent>;
  startFakeCodexPane: (sessionName: string, cwd?: string) => Promise<FakeTmuxAgent>;
  startFakeGjc: (sessionName: string, cwd?: string) => Promise<FakeTmuxAgent>;
  startFakeGjcWithTranscript: (
    sessionName: string,
    sessionId: string,
    cwd?: string,
  ) => Promise<FakeTranscriptTmuxAgent>;
  startFakeGjcWithBun: (sessionName: string, cwd?: string) => Promise<FakeTmuxAgent>;
  startFakeGjcWithNpmShim: (sessionName: string, cwd?: string) => Promise<FakeTmuxAgent>;
};

function snapshotEnvironment(): EnvironmentSnapshot {
  return Object.fromEntries(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  ) as EnvironmentSnapshot;
}

function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  for (const key of ENVIRONMENT_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertSafeSessionName(sessionName: string): void {
  if (!SESSION_NAME_RE.test(sessionName)) {
    throw new Error(`Unsafe tmux test session name: ${sessionName}`);
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function readEvents(logPath: string): Promise<FakeAgentEvent[]> {
  let content: string;
  try {
    content = await readFile(logPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeAgentEvent);
}

async function writeFakeAgent(executablePath: string): Promise<void> {
  await writeFile(executablePath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const logPath = process.argv[2];
const transcriptPath = process.argv[3];
const sessionId = process.argv[4];
const cwd = process.argv[5];
const emit = (event) => fs.appendFileSync(logPath, JSON.stringify(event) + '\\n');
let transcriptFd;
let turn = 0;
const appendRecord = (record) => fs.appendFileSync(transcriptFd, JSON.stringify(record) + '\\n');
emit({ type: 'ready', pid: process.pid });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on('line', (value) => {
  emit({ type: 'input', value });
  if (!transcriptPath || !sessionId || !cwd) return;
  if (transcriptFd === undefined) {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    transcriptFd = fs.openSync(transcriptPath, 'a');
    appendRecord({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd });
  }
  turn += 1;
  appendRecord({
    type: 'message',
    id: 'user-' + turn,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: value }] },
  });
  appendRecord({
    type: 'message',
    id: 'assistant-' + turn,
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'fake reply ' + turn }] },
  });
  fs.fsyncSync(transcriptFd);
  emit({ type: 'transcript', path: transcriptPath, sessionId });
});
`, 'utf8');
  await chmod(executablePath, 0o755);
}

async function writeNpmBinShim(shimPath: string, entryPath: string): Promise<void> {
  await writeFile(shimPath, `#!/bin/sh
exec ${shellQuote(process.execPath)} ${shellQuote(entryPath)} "$@"
`, 'utf8');
  await chmod(shimPath, 0o755);
}

export async function createTmuxE2EHarness(): Promise<TmuxE2EHarness> {
  const root = await mkdtemp(path.join(tmpdir(), 'chatmux-tmux-e2e-'));
  const home = path.join(root, 'home');
  const socketRoot = path.join(root, 'sockets');
  const workspace = path.join(root, 'workspace');
  const fakeCodexPath = path.join(root, 'codex');
  const fakeGjcPath = path.join(root, 'gjc');
  const npmBinDirectory = path.join(workspace, 'node_modules', '.bin');
  const npmPackageDirectory = path.join(
    workspace,
    'node_modules',
    '@chatmux-code',
    'coding-agent',
  );
  const npmGjcPath = path.join(npmPackageDirectory, 'gjc');
  const npmGjcShimPath = path.join(npmBinDirectory, 'gjc');
  const environment = snapshotEnvironment();

  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(socketRoot, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(npmBinDirectory, { recursive: true }),
    mkdir(npmPackageDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFakeAgent(fakeCodexPath),
    writeFakeAgent(fakeGjcPath),
    writeFakeAgent(npmGjcPath),
    writeNpmBinShim(npmGjcShimPath, npmGjcPath),
    writeFile(path.join(workspace, 'package.json'), '{"private":true}\n', 'utf8'),
  ]);

  process.env.HOME = home;
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  process.env.TMUX_TMPDIR = socketRoot;
  delete process.env.TMUX;

  const runTmux = async (args: string[]): Promise<string> => {
    const result = await execFileAsync('tmux', args, {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: 8_000,
    });
    return String(result.stdout);
  };

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      await runTmux(['kill-server']);
    } catch {
      // The isolated server may already be gone after a failed assertion.
    } finally {
      restoreEnvironment(environment);
      await rm(root, { recursive: true, force: true });
    }
  };

  try {
    await execFileAsync('tmux', ['-V'], { encoding: 'utf8', timeout: 5_000 });
  } catch (error) {
    await dispose();
    throw new Error('The real-tmux E2E harness requires tmux on PATH.', { cause: error });
  }

  const hasSession = async (sessionName: string): Promise<boolean> => {
    assertSafeSessionName(sessionName);
    try {
      await runTmux(['has-session', '-t', `=${sessionName}`]);
      return true;
    } catch {
      return false;
    }
  };

  const getSessionId = async (sessionName: string): Promise<string> => {
    assertSafeSessionName(sessionName);
    const sessionId = (await runTmux([
      'display-message',
      '-p',
      '-t',
      `=${sessionName}:`,
      '#{session_id}',
    ])).trim();
    if (!/^\$\d+$/.test(sessionId)) {
      throw new Error(`Unexpected tmux session id for ${sessionName}: ${sessionId}`);
    }
    return sessionId;
  };

  const killSession = async (sessionName: string): Promise<void> => {
    assertSafeSessionName(sessionName);
    await runTmux(['kill-session', '-t', `=${sessionName}`]);
  };

  let agentGeneration = 0;
  const startFakeAgentCommand = async (
    sessionName: string,
    commandPrefix: string[],
    cwd = workspace,
    commandSuffix: string[] = [],
    splitExistingSession = false,
  ): Promise<FakeTmuxAgent> => {
    assertSafeSessionName(sessionName);
    await mkdir(cwd, { recursive: true });
    agentGeneration += 1;
    const logPath = path.join(root, `${sessionName}-${agentGeneration}.ndjson`);
    const command = [...commandPrefix, logPath, ...commandSuffix].map(shellQuote).join(' ');
    await runTmux(splitExistingSession
      ? ['split-window', '-d', '-t', `=${sessionName}:`, '-c', cwd, command]
      : ['new-session', '-d', '-s', sessionName, '-c', cwd, command]);

    const events = (): Promise<FakeAgentEvent[]> => readEvents(logPath);
    return {
      sessionName,
      logPath,
      events,
      waitUntilReady: () => waitFor(
        async () => (await events()).some((event) => event.type === 'ready'),
        `${sessionName} fake agent readiness`,
      ),
      waitForInput: (value) => waitFor(
        async () => (await events()).some((event) => event.type === 'input' && event.value === value),
        `${sessionName} input ${JSON.stringify(value)}`,
      ),
    };
  };

  const startFakeGjcWithTranscript = async (
    sessionName: string,
    sessionId: string,
    cwd = workspace,
  ): Promise<FakeTranscriptTmuxAgent> => {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new Error(`Invalid fake transcript session id: ${sessionId}`);
    }
    const transcriptPath = path.join(
      home,
      '.gjc',
      'agent',
      'sessions',
      '-workspace',
      `2026-07-23T00-00-00_${sessionId}.jsonl`,
    );
    const agent = await startFakeAgentCommand(
      sessionName,
      [process.execPath, fakeGjcPath],
      cwd,
      [transcriptPath, sessionId, cwd],
    );
    return {
      ...agent,
      sessionId,
      transcriptPath,
      waitForTranscript: () => waitFor(
        async () => (await agent.events()).some(
          (event) => event.type === 'transcript' && event.sessionId === sessionId,
        ),
        `${sessionName} transcript creation`,
      ),
    };
  };

  const discoverFromFreshProcess = async (): Promise<ExternalCliSession[]> => {
    const tsx = path.join(REPOSITORY_ROOT, 'node_modules', '.bin', 'tsx');
    const probe = path.join(
      REPOSITORY_ROOT,
      'server/modules/providers/tests/support/discover-external-sessions.probe.ts',
    );
    const result = await execFileAsync(tsx, [
      '--tsconfig',
      'server/tsconfig.json',
      probe,
    ], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 20_000,
    });
    const markerLine = String(result.stdout)
      .split('\n')
      .find((line) => line.startsWith(DISCOVERY_MARKER));
    if (!markerLine) {
      throw new Error(`Fresh discovery process produced no session marker:\n${String(result.stdout)}\n${String(result.stderr)}`);
    }
    return JSON.parse(markerLine.slice(DISCOVERY_MARKER.length)) as ExternalCliSession[];
  };

  return {
    root,
    workspace,
    discoverFromFreshProcess,
    dispose,
    hasSession,
    getSessionId,
    killSession,
    startFakeCodex: (sessionName, cwd) => (
      startFakeAgentCommand(sessionName, [process.execPath, fakeCodexPath], cwd)
    ),
    startFakeCodexPane: (sessionName, cwd) => (
      startFakeAgentCommand(sessionName, [process.execPath, fakeCodexPath], cwd, [], true)
    ),
    startFakeGjc: (sessionName, cwd) => (
      startFakeAgentCommand(sessionName, [process.execPath, fakeGjcPath], cwd)
    ),
    startFakeGjcWithTranscript,
    startFakeGjcWithBun: (sessionName, cwd) => (
      startFakeAgentCommand(sessionName, ['bun', fakeGjcPath], cwd)
    ),
    startFakeGjcWithNpmShim: (sessionName, cwd) => (
      startFakeAgentCommand(sessionName, ['npm', 'exec', '--offline', '--', 'gjc'], cwd)
    ),
  };
}
