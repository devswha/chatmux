import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type {
  ExternalCliSession,
  ExternalLocalCliKind,
} from '@/modules/providers/services/external-cli-sessions.service.js';

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
  | { type: 'interrupt' }
  | { type: 'turn_started' }
  | { type: 'turn_interrupted' }
  | { type: 'turn_completed' }
  | { type: 'transcript'; path: string; sessionId: string };

export type FakeTmuxAgent = {
  sessionName: string;
  logPath: string;
  events: () => Promise<FakeAgentEvent[]>;
  waitUntilReady: () => Promise<void>;
  waitForInput: (value: string) => Promise<void>;
  /** Resolves once at least `count` interrupts have been recorded. */
  waitForInterrupt: (count?: number) => Promise<void>;
  waitForTurnStarted: () => Promise<void>;
  waitForTurnInterrupted: () => Promise<void>;
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
  capturePane: (paneId: string) => Promise<string>;
  killSession: (sessionName: string) => Promise<void>;
  startFakeExternal: (
    kind: ExternalLocalCliKind,
    sessionName: string,
    cwd?: string,
  ) => Promise<FakeTmuxAgent>;
  respawnFakeCodexPane: (sessionName: string, paneId: string, cwd?: string) => Promise<FakeTmuxAgent>;
  startFakeCodex: (sessionName: string, cwd?: string) => Promise<FakeTmuxAgent>;
  startFakeCodexWithTranscript: (
    sessionName: string,
    sessionId: string,
    cwd?: string,
  ) => Promise<FakeTranscriptTmuxAgent>;
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
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const agentName = path.basename(process.argv[1]);
const firstArgument = process.argv[2];
if (
  firstArgument === '--list-models'
  || (firstArgument === 'models' && process.argv.includes('--verbose'))
  || (firstArgument === 'models' && process.argv.includes('--json'))
) {
  if (agentName === 'omp' && firstArgument === 'models') {
    process.stdout.write('{"models":[]}\\n');
  } else if (agentName === 'omo' && firstArgument === '--list-models') {
    process.stdout.write('Name  Provider  Model  Thinking\\n');
  } else if (agentName === 'cursor-agent' && firstArgument === '--list-models') {
    process.stdout.write('Available models\\n');
  }
  process.exit(0);
}
const logPath = (
  firstArgument && path.isAbsolute(firstArgument) && firstArgument.endsWith('.ndjson')
)
  ? firstArgument
  : path.join(
      process.env.HOME || os.tmpdir(),
      '.chatmux-cua-spawned',
      agentName + '-' + process.pid + '.ndjson',
    );
const transcriptPath = process.argv[3];
const sessionId = process.argv[4];
const cwd = process.argv[5];
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const emit = (event) => fs.appendFileSync(logPath, JSON.stringify(event) + '\\n');
let transcriptFd;
let turn = 0;
let runningTurn;
const appendRecord = (record) => fs.appendFileSync(transcriptFd, JSON.stringify(record) + '\\n');
const isCodex = agentName === 'codex';
const ensureTranscript = () => {
  if (!transcriptPath || !sessionId || !cwd) return false;
  if (transcriptFd === undefined) {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    transcriptFd = fs.openSync(transcriptPath, 'a');
    appendRecord(isCodex
      ? { type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: sessionId, cwd } }
      : { type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd });
  }
  return true;
};
const appendUserMessage = (text) => appendRecord(isCodex
  ? { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'user_message', message: text } }
  : {
      type: 'message',
      id: 'user-' + turn,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
const appendAssistantMessage = (text) => appendRecord(isCodex
  ? {
      type: 'response_item',
      timestamp: new Date().toISOString(),
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    }
  : {
      type: 'message',
      id: 'assistant-' + turn,
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] },
    });
const finishLongRunningTurn = (text) => {
  if (transcriptFd !== undefined) {
    appendAssistantMessage(text);
    fs.fsyncSync(transcriptFd);
    emit({ type: 'transcript', path: transcriptPath, sessionId });
  }
};
const startLongRunningTurn = () => {
  emit({ type: 'turn_started' });
  runningTurn = setTimeout(() => {
    runningTurn = undefined;
    emit({ type: 'turn_completed' });
    finishLongRunningTurn('long-running fake reply');
  }, 10_000);
};
emit({ type: 'ready', pid: process.pid });
process.stdout.write('ChatMux CUA fixture ready: ' + agentName + '\\n');
process.stdin.setRawMode?.(true);
process.stdin.resume();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
const interruptTurn = () => {
  emit({ type: 'interrupt' });
  if (runningTurn !== undefined) {
    clearTimeout(runningTurn);
    runningTurn = undefined;
    emit({ type: 'turn_interrupted' });
    finishLongRunningTurn('interrupted');
  }
};
process.on('SIGINT', interruptTurn);
process.stdin.on('data', (chunk) => {
  if (chunk.includes(0x1b) || chunk.includes(0x03)) interruptTurn();
});
input.on('line', (value) => {
  emit({ type: 'input', value });
  process.stdout.write('User: ' + value + '\\n');
  if (value === '__fake_long_running_turn__') {
    turn += 1;
    if (ensureTranscript()) {
      appendUserMessage(value);
      fs.fsyncSync(transcriptFd);
      emit({ type: 'transcript', path: transcriptPath, sessionId });
    }
    startLongRunningTurn();
    return;
  }
  turn += 1;
  process.stdout.write('Assistant: fake reply ' + turn + '\\n');
  if (!ensureTranscript()) return;
  appendUserMessage(value);
  appendAssistantMessage('fake reply ' + turn);
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
  const fakeAgentDirectory = path.join(home, '.local', 'bin');
  const fakeAgentPaths: Record<ExternalLocalCliKind | 'gjc', string> = {
    claude: path.join(fakeAgentDirectory, 'claude'),
    codex: path.join(fakeAgentDirectory, 'codex'),
    cursor: path.join(fakeAgentDirectory, 'cursor-agent'),
    opencode: path.join(fakeAgentDirectory, 'opencode'),
    omp: path.join(fakeAgentDirectory, 'omp'),
    omo: path.join(fakeAgentDirectory, 'omo'),
    gjc: path.join(fakeAgentDirectory, 'gjc'),
  };
  const fakeCodexPath = fakeAgentPaths.codex;
  const fakeGjcPath = fakeAgentPaths.gjc;
  const npmBinDirectory = path.join(workspace, 'node_modules', '.bin');
  const npmPackageDirectory = path.join(
    workspace,
    'node_modules',
    '@gajae-code',
    'coding-agent',
  );
  const npmGjcPath = path.join(npmPackageDirectory, 'gjc');
  const npmGjcShimPath = path.join(npmBinDirectory, 'gjc');
  const environment = snapshotEnvironment();

  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(socketRoot, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(fakeAgentDirectory, { recursive: true }),
    mkdir(npmBinDirectory, { recursive: true }),
    mkdir(npmPackageDirectory, { recursive: true }),
  ]);
  await Promise.all([
    ...Object.values(fakeAgentPaths).map((agentPath) => writeFakeAgent(agentPath)),
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
    taggedKind?: ExternalLocalCliKind,
    taggedSessionId?: string,
  ): Promise<FakeTmuxAgent> => {
    assertSafeSessionName(sessionName);
    await mkdir(cwd, { recursive: true });
    agentGeneration += 1;
    const logPath = path.join(root, `${sessionName}-${agentGeneration}.ndjson`);
    const command = [...commandPrefix, logPath, ...commandSuffix].map(shellQuote).join(' ');
    await runTmux(splitExistingSession
      ? ['split-window', '-d', '-t', `=${sessionName}:`, '-c', cwd, command]
      : ['new-session', '-d', '-s', sessionName, '-c', cwd, command]);
    if (taggedKind) {
      await runTmux(['set-option', '-t', sessionName, '@chatmux_cli_kind', taggedKind]);
    }
    if (taggedSessionId) {
      await runTmux([
        'set-option', '-p', '-t', `=${sessionName}:`,
        '@chatmux_provider_session_id', taggedSessionId,
      ]);
    }

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
      waitForInterrupt: (count = 1) => waitFor(
        async () => (await events()).filter((event) => event.type === 'interrupt').length >= count,
        `${sessionName} SIGINT x${count}`,
      ),
      waitForTurnStarted: () => waitFor(
        async () => (await events()).some((event) => event.type === 'turn_started'),
        `${sessionName} long-running turn start`,
      ),
      waitForTurnInterrupted: () => waitFor(
        async () => (await events()).some((event) => event.type === 'turn_interrupted'),
        `${sessionName} long-running turn interruption`,
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

  const startFakeCodexWithTranscript = async (
    sessionName: string,
    sessionId: string,
    cwd = workspace,
  ): Promise<FakeTranscriptTmuxAgent> => {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new Error(`Invalid fake transcript session id: ${sessionId}`);
    }
    const transcriptPath = path.join(
      home,
      '.codex',
      'sessions',
      '2026',
      '08',
      '21',
      `rollout-2026-08-21T00-00-00-${sessionId}.jsonl`,
    );
    const agent = await startFakeAgentCommand(
      sessionName,
      [process.execPath, fakeCodexPath],
      cwd,
      [transcriptPath, sessionId, cwd],
      false,
      'codex',
      sessionId,
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
    capturePane: (paneId) => runTmux(['capture-pane', '-p', '-t', paneId]),
    hasSession,
    getSessionId,
    killSession,
    startFakeExternal: (kind, sessionName, cwd) => (
      startFakeAgentCommand(
        sessionName,
        [process.execPath, fakeAgentPaths[kind]],
        cwd,
        [],
        false,
        kind,
      )
    ),
    respawnFakeCodexPane: async (sessionName, paneId, cwd = workspace) => {
      assertSafeSessionName(sessionName);
      await mkdir(cwd, { recursive: true });
      agentGeneration += 1;
      const logPath = path.join(root, `${sessionName}-${agentGeneration}.ndjson`);
      const command = [process.execPath, fakeCodexPath, logPath].map(shellQuote).join(' ');
      await runTmux(['respawn-pane', '-k', '-t', paneId, '-c', cwd, command]);
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
        waitForInterrupt: (count = 1) => waitFor(
          async () => (await events()).filter((event) => event.type === 'interrupt').length >= count,
          `${sessionName} SIGINT x${count}`,
        ),
        waitForTurnStarted: () => waitFor(
          async () => (await events()).some((event) => event.type === 'turn_started'),
          `${sessionName} long-running turn start`,
        ),
        waitForTurnInterrupted: () => waitFor(
          async () => (await events()).some((event) => event.type === 'turn_interrupted'),
          `${sessionName} long-running turn interruption`,
        ),
      };
    },
    startFakeCodex: (sessionName, cwd) => (
      startFakeAgentCommand(sessionName, [process.execPath, fakeCodexPath], cwd)
    ),
    startFakeCodexWithTranscript,
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
