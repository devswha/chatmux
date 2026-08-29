import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ExternalLocalCliKind } from '@/modules/providers/services/external-cli-sessions.service.js';

import { shellQuote, writeFakeAgent } from './tmux-fake-agent.js';
import { assertSafeSessionName, assertSessionId, assertTmuxAvailable, createWatchedAgent, discoverFromFreshProcess, TmuxHarnessContractError, withTranscript } from './tmux-harness-utils.js';
import type { TmuxEventLog } from './tmux-event-log.js';
import { startOwnedTmuxServer } from './tmux-owned-server.js';
import type { FakeTmuxAgent, FakeTranscriptTmuxAgent, TmuxE2EHarness } from './tmux-e2e-types.js';

const ENVIRONMENT_KEYS = ['HOME', 'DATABASE_PATH', 'TMUX', 'TMUX_TMPDIR'] as const;
type EnvironmentKey = typeof ENVIRONMENT_KEYS[number];

export async function createTmuxE2EHarness(): Promise<TmuxE2EHarness> {
  await assertTmuxAvailable();
  const root = await mkdtemp(path.join(tmpdir(), 'chatmux-tmux-e2e-'));
  const home = path.join(root, 'home');
  const socketRoot = path.join(root, 'sockets');
  const workspace = path.join(root, 'workspace');
  const fakeAgentDirectory = path.join(home, '.local', 'bin');
  const fakeAgentPaths: Record<ExternalLocalCliKind | 'gjc', string> = {
    claude: path.join(fakeAgentDirectory, 'claude'), codex: path.join(fakeAgentDirectory, 'codex'),
    cursor: path.join(fakeAgentDirectory, 'cursor-agent'), opencode: path.join(fakeAgentDirectory, 'opencode'),
    omp: path.join(fakeAgentDirectory, 'omp'), omo: path.join(fakeAgentDirectory, 'omo'), gjc: path.join(fakeAgentDirectory, 'gjc'),
  };
  const npmBin = path.join(workspace, 'node_modules', '.bin');
  const npmGjc = path.join(workspace, 'node_modules', '@gajae-code', 'coding-agent', 'gjc');
  const environmentBefore = new Map<EnvironmentKey, string | undefined>(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  const eventLogs = new Set<TmuxEventLog>();
  const agentLogs = new WeakMap<FakeTmuxAgent, TmuxEventLog>();
  await Promise.all([home, socketRoot, workspace, fakeAgentDirectory, npmBin, path.dirname(npmGjc)].map((directory) => mkdir(directory, { recursive: true })));
  await Promise.all([...Object.values(fakeAgentPaths), npmGjc].map(writeFakeAgent));
  const npmShim = path.join(npmBin, 'gjc');
  await writeFile(npmShim, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(npmGjc)} "$@"\n`, 'utf8');
  await chmod(npmShim, 0o755);
  await writeFile(path.join(workspace, 'package.json'), '{"private":true}\n', 'utf8');
  process.env.HOME = home;
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  process.env.TMUX_TMPDIR = socketRoot;
  delete process.env.TMUX;
  const ownedTmux = await startOwnedTmuxServer(path.join(socketRoot, `tmux-${process.getuid?.() ?? 0}`, 'default'), process.env);
  const tmux = ownedTmux.run;
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await ownedTmux.dispose()
    for (const eventLog of eventLogs) eventLog.close();
    for (const [key, value] of environmentBefore) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  };
  let generation = 0;
  const start = async (
    sessionName: string, commandPrefix: readonly string[], cwd = workspace, commandSuffix: readonly string[] = [],
    split = false, kind?: ExternalLocalCliKind, taggedSessionId?: string,
  ): Promise<FakeTmuxAgent> => {
    assertSafeSessionName(sessionName);
    await mkdir(cwd, { recursive: true });
    generation += 1;
    const logPath = path.join(root, `${sessionName}-${generation}.ndjson`);
    const [agent, eventLog] = await createWatchedAgent(sessionName, logPath, eventLogs);
    agentLogs.set(agent, eventLog);
    const command = [...commandPrefix, logPath, ...commandSuffix].map(shellQuote).join(' ');
    await tmux(split ? ['split-window', '-d', '-t', `=${sessionName}:`, '-c', cwd, command] : ['new-session', '-d', '-s', sessionName, '-c', cwd, command]);
    await ownedTmux.trackPane(sessionName);
    if (kind) await tmux(['set-option', '-t', sessionName, '@chatmux_cli_kind', kind]);
    if (taggedSessionId) await tmux(['set-option', '-p', '-t', `=${sessionName}:`, '@chatmux_provider_session_id', taggedSessionId]);
    return agent;
  };
  const transcriptAgent = async (provider: 'codex' | 'gjc', sessionName: string, sessionId: string, cwd = workspace): Promise<FakeTranscriptTmuxAgent> => {
    assertSessionId(sessionId);
    const transcriptPath = provider === 'codex'
      ? path.join(home, '.codex', 'sessions', '2026', '08', '21', `rollout-2026-08-21T00-00-00-${sessionId}.jsonl`)
      : path.join(home, '.gjc', 'agent', 'sessions', '-workspace', `2026-07-23T00-00-00_${sessionId}.jsonl`);
    const agent = await start(sessionName, [process.execPath, fakeAgentPaths[provider]], cwd, [transcriptPath, sessionId, cwd], false, provider === 'codex' ? 'codex' : undefined, provider === 'codex' ? sessionId : undefined);
    const eventLog = agentLogs.get(agent);
    if (!eventLog) throw new TmuxHarnessContractError(`No event subscription for ${sessionName}.`);
    return withTranscript(agent, eventLog, sessionId, transcriptPath);
  };
  return {
    root, workspace, dispose,
    discoverFromFreshProcess: () => discoverFromFreshProcess(process.env),
    capturePane: (paneId) => tmux(['capture-pane', '-p', '-t', paneId]),
    hasSession: async (sessionName) => { assertSafeSessionName(sessionName); try { await tmux(['has-session', '-t', `=${sessionName}`]); return true; } catch { return false; } },
    getSessionId: async (sessionName) => { assertSafeSessionName(sessionName); return (await tmux(['display-message', '-p', '-t', `=${sessionName}:`, '#{session_id}'])).trim(); },
    killSession: async (sessionName) => { assertSafeSessionName(sessionName); await tmux(['kill-session', '-t', `=${sessionName}`]); },
    startFakeExternal: (kind, sessionName, cwd) => start(sessionName, [process.execPath, fakeAgentPaths[kind]], cwd, [], false, kind),
    respawnFakeCodexPane: async (sessionName, paneId, cwd = workspace) => {
      generation += 1;
      const logPath = path.join(root, `${sessionName}-${generation}.ndjson`);
      const [agent, eventLog] = await createWatchedAgent(sessionName, logPath, eventLogs);
      agentLogs.set(agent, eventLog);
      await tmux(['respawn-pane', '-k', '-t', paneId, '-c', cwd, [process.execPath, fakeAgentPaths.codex, logPath].map(shellQuote).join(' ')]);
      await ownedTmux.trackPane(sessionName);
      return agent;
    },
    startFakeCodex: (sessionName, cwd) => start(sessionName, [process.execPath, fakeAgentPaths.codex], cwd),
    startFakeCodexWithTranscript: (sessionName, sessionId, cwd) => transcriptAgent('codex', sessionName, sessionId, cwd),
    startFakeCodexPane: (sessionName, cwd) => start(sessionName, [process.execPath, fakeAgentPaths.codex], cwd, [], true),
    startFakeGjc: (sessionName, cwd) => start(sessionName, [process.execPath, fakeAgentPaths.gjc], cwd),
    startFakeGjcWithTranscript: (sessionName, sessionId, cwd) => transcriptAgent('gjc', sessionName, sessionId, cwd),
    startFakeGjcWithBun: (sessionName, cwd) => start(sessionName, ['bun', fakeAgentPaths.gjc], cwd),
    startFakeGjcWithNpmShim: (sessionName, cwd) => start(sessionName, ['npm', 'exec', '--offline', '--', 'gjc'], cwd),
  };
}
