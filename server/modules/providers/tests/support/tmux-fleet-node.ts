import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { ExternalLocalCliKind } from '@/modules/providers/services/external-cli-sessions.service.js';

import type { FakeTmuxAgent, FakeTranscriptTmuxAgent, FleetTmuxIdentity, FleetTmuxNodeName, TmuxFleetNode } from './tmux-e2e-types.js';
import type { TmuxEventLog } from './tmux-event-log.js';
import { shellQuote, writeFakeAgent } from './tmux-fake-agent.js';
import { assertSafeSessionName, assertSessionId, createWatchedAgent, discoverFromFreshProcess, TmuxHarnessContractError, withTranscript } from './tmux-harness-utils.js';
import { startOwnedTmuxServer, type OwnedTmuxServer } from './tmux-owned-server.js';

export const FLEET_TMUX_NODE_HOST_IDS = {
  hub: '2e0e6a2c-8ae7-4bd7-93b1-4cfcd26a4eb1', 'peer-a': 'c4a35e5a-17bb-43a2-9b80-ef64c5d091c2',
  'peer-b': '8ef5ed72-4b11-45a3-9eea-e99eef389853',
} as const satisfies Record<FleetTmuxNodeName, string>;
type NodeOptions = Readonly<{ fleetRoot: string; name: FleetTmuxNodeName; port: number; workspace: string }>;

export async function createTmuxFleetNode(options: NodeOptions): Promise<TmuxFleetNode> {
  const { fleetRoot, name, port, workspace } = options;
  const root = path.join(fleetRoot, name); const home = path.join(root, 'home');
  const databasePath = path.join(root, 'data', 'auth.db'); const tmuxTmpDir = path.join(root, 'tmux');
  // Production spawn deliberately prefers ~/.local/bin over inherited PATH.
  // Put fixture shims at that exact boundary so browser-created sessions can
  // never escape to an operator-installed agent executable.
  const fakeAgentPath = path.join(home, '.local', 'bin'); const logRoot = path.join(root, 'fake-agent-logs');
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, DATABASE_PATH: databasePath, TMUX_TMPDIR: tmuxTmpDir, PATH: [fakeAgentPath, process.env.PATH ?? ''].join(path.delimiter) };
  delete environment.TMUX;
  // TMUX_PANE leaks an operator/CI tmux identity into the isolated node: the
  // server's self-pane lookup would resolve against the wrong (or a missing)
  // pane and misclassify its hosted state.
  delete environment.TMUX_PANE;
  await Promise.all([home, path.dirname(databasePath), tmuxTmpDir, workspace, fakeAgentPath, logRoot].map((directory) => mkdir(directory, { recursive: true })));
  await Promise.all(['claude', 'codex', 'cursor-agent', 'opencode', 'omp', 'omo', 'gjc'].map((agent) => writeFakeAgent(path.join(fakeAgentPath, agent))));
  const eventLogs = new Set<TmuxEventLog>(); const agentLogs = new WeakMap<FakeTmuxAgent, TmuxEventLog>();
  let ownedTmux: OwnedTmuxServer | undefined;
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return; disposed = true;
    try { await ownedTmux?.dispose(); } finally {
      for (const eventLog of eventLogs) eventLog.close();
      await rm(root, { recursive: true, force: true });
    }
  };
  try {
    ownedTmux = await startOwnedTmuxServer(path.join(tmuxTmpDir, `tmux-${process.getuid?.() ?? 0}`, 'default'), environment);
    const owned = ownedTmux;
    const tmux = owned.run;
    await tmux(['new-session', '-d', '-s', 'fleet-bootstrap', 'exec tail -f /dev/null']);
    await owned.trackPane('fleet-bootstrap');
    const { socketPath, pid: tmuxServerPid } = owned;
    const start = async (executable: string, sessionName: string, suffix: readonly string[] = [], kind?: ExternalLocalCliKind, taggedId?: string): Promise<FakeTmuxAgent> => {
      assertSafeSessionName(sessionName);
      const logPath = path.join(logRoot, `${sessionName}.ndjson`);
      const [agent, eventLog] = await createWatchedAgent(sessionName, logPath, eventLogs); agentLogs.set(agent, eventLog);
      const command = [process.execPath, path.join(fakeAgentPath, executable), logPath, ...suffix].map(shellQuote).join(' ');
      await tmux(['new-session', '-d', '-s', sessionName, '-c', workspace, command]);
      await owned.trackPane(sessionName);
      if (kind) await tmux(['set-option', '-t', sessionName, '@chatmux_cli_kind', kind]);
      if (taggedId) await tmux(['set-option', '-p', '-t', `=${sessionName}:`, '@chatmux_provider_session_id', taggedId]);
      return agent;
    };
    const transcriptAgent = async (provider: 'codex' | 'gjc', sessionName: string, sessionId: string): Promise<FakeTranscriptTmuxAgent> => {
      assertSessionId(sessionId);
      const transcriptPath = provider === 'codex'
        ? path.join(home, '.codex', 'sessions', '2026', '08', '21', `rollout-2026-08-21T00-00-00-${sessionId}.jsonl`)
        : path.join(home, '.gjc', 'agent', 'sessions', '-workspace', `2026-07-23T00-00-00_${sessionId}.jsonl`);
      const agent = await start(provider, sessionName, [transcriptPath, sessionId, workspace], provider === 'codex' ? 'codex' : undefined, provider === 'codex' ? sessionId : undefined);
      const eventLog = agentLogs.get(agent);
      if (!eventLog) throw new TmuxHarnessContractError(`No event subscription for ${name}:${sessionName}.`);
      return withTranscript(agent, eventLog, sessionId, transcriptPath);
    };
    const tmuxIdentity = async (sessionName: string): Promise<FleetTmuxIdentity> => {
      assertSafeSessionName(sessionName);
      const [sessionId, windowId, paneId] = (await tmux(['display-message', '-p', '-t', `=${sessionName}:`, '#{session_id}\t#{window_id}\t#{pane_id}'])).trim().split('\t');
      if (sessionId !== '$1' || windowId !== '@1' || paneId !== '%1') throw new TmuxHarnessContractError(`Unexpected collision identity: ${sessionId}/${windowId}/${paneId}`);
      return { sessionId, windowId, paneId };
    };
    return {
      name, hostId: FLEET_TMUX_NODE_HOST_IDS[name], tmuxServerPid, root, home, databasePath, tmuxTmpDir, socketPath, workspace,
      port, fakeAgentPath, logRoot, environment, dispose, discoverFromFreshProcess: () => discoverFromFreshProcess(environment),
      startFakeExternal: (kind, sessionName) => start(kind === 'cursor' ? 'cursor-agent' : kind, sessionName, [], kind),
      sendInput: async (sessionName, value) => { assertSafeSessionName(sessionName); await tmux(['send-keys', '-t', `=${sessionName}:`, '-l', value]); await tmux(['send-keys', '-t', `=${sessionName}:`, 'Enter']); },
      sendInterrupt: async (sessionName) => { assertSafeSessionName(sessionName); await tmux(['send-keys', '-t', `=${sessionName}:`, 'C-c']); },
      startFakeCodexWithTranscript: (sessionName, sessionId) => transcriptAgent('codex', sessionName, sessionId),
      startFakeGjcWithTranscript: (sessionName, sessionId) => transcriptAgent('gjc', sessionName, sessionId), tmuxIdentity,
    };
  } catch (error) { await dispose(); throw error; }
}
