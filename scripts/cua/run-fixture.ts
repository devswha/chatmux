import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

import { createTmuxFleetE2EHarness, type FakeTmuxAgent, type TmuxFleetE2EHarness } from '../../server/modules/providers/tests/support/tmux-e2e-harness.js';
import { enrollFleetPeers, type FleetEnrollment } from './fleet-enrollment.js';
import { startFleetFixtureControl, type FleetFixtureControl } from './fleet-fixture-control.js';
import { startFleetServers, stopFleetProcesses, type FleetProcess } from './fleet-process-lifecycle.js';
import { startVite } from './vite-process.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const serverPort = Number.parseInt(process.env.CUA_SERVER_PORT ?? '0', 10);
const vitePort = Number.parseInt(process.env.CUA_VITE_PORT ?? '4310', 10);
const peerAPort = Number.parseInt(process.env.CUA_PEER_A_PORT ?? '0', 10);
const peerBPort = Number.parseInt(process.env.CUA_PEER_B_PORT ?? '0', 10);
const runId = process.env.CUA_RUN_ID ?? new Date().toISOString().replaceAll(/[:.]/g, '-');
const evidenceRoot = path.resolve(
  process.env.CUA_EVIDENCE_DIR ?? path.join(repositoryRoot, '.omo', 'cua', 'runs', runId),
);
const currentPath = path.join(repositoryRoot, '.omo', 'cua', 'current.json');
const baseUrl = `http://127.0.0.1:${vitePort}`;

type FixtureAgent = Readonly<{
  kind: 'omo' | 'claude' | 'codex' | 'cursor' | 'opencode' | 'gjc' | 'omp';
  displayName: string;
  tmuxName: string;
  agent: FakeTmuxAgent;
}>;

await mkdir(evidenceRoot, { recursive: true });
let fleet: TmuxFleetE2EHarness | null = null;
let servers: readonly FleetProcess[] = [];
let enrollment: FleetEnrollment | null = null;
let control: FleetFixtureControl | null = null;
let viteProcess: import('node:child_process').ChildProcess | null = null;
let stopping = false;

const stop = async (reason: string, exitCode = 0): Promise<never> => {
  if (stopping) return new Promise<never>(() => undefined);
  stopping = true;
  const roots = fleet === null ? [] : [fleet.root, fleet.hub.root, fleet.peers.a.root, fleet.peers.b.root];
  const tmuxServerPids = fleet === null ? [] : [fleet.hub.tmuxServerPid, fleet.peers.a.tmuxServerPid, fleet.peers.b.tmuxServerPid];
  let cleanupFailure: unknown;
  try { await control?.close(); } catch (error) { cleanupFailure = error; }
  try { await enrollment?.close(); } catch (error) { cleanupFailure ??= error; }
  try { await stopFleetProcesses(servers, viteProcess); } catch (error) { cleanupFailure ??= error; }
  try { await fleet?.dispose(); } catch (error) { cleanupFailure ??= error; }
  await rm(currentPath, { force: true });
  await writeFile(path.join(evidenceRoot, 'stopped.json'), `${JSON.stringify({
    runId, reason, stoppedAt: new Date().toISOString(), processGroups: servers.map(({ processGroupPid }) => processGroupPid),
    listenerPids: servers.map(({ listenerPid }) => listenerPid), tmuxServerPids, roots,
    cleanupError: cleanupFailure instanceof Error ? cleanupFailure.message : null,
  }, null, 2)}\n`, 'utf8');
  process.exit(cleanupFailure === undefined ? exitCode : 1);
};

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

try {
  process.env.CHATMUX_FLEET_TRANSPORT_MODE = 'ssh-loopback';
  // Project registration deliberately forbids /tmp. A disposable directory in
  // the user's home exercises the real workspace policy without relaxing it.
  const fixtureFleet = await createTmuxFleetE2EHarness({ hub: serverPort, peerA: peerAPort, peerB: peerBPort, tempRoot: homedir() });
  fleet = fixtureFleet;
  const harness = fixtureFleet.hub;
  const definitions = [
    ['omo', 'Oh My OpenAgent', 'cua-01-omo'], ['claude', 'Claude Code', 'cua-02-claude'],
    ['codex', 'Codex', 'cua-03-codex'], ['cursor', 'Cursor', 'cua-04-cursor'],
    ['opencode', 'OpenCode', 'cua-05-opencode'], ['gjc', 'Gajae Code', 'cua-06-gjc'],
    ['omp', 'Oh My Pi', 'cua-07-omp'],
  ] as const;
  const fixtures: FixtureAgent[] = [];
  let gjcTranscriptPath: string | null = null;
  let codexTranscriptPath: string | null = null;
  for (const [kind, displayName, tmuxName] of definitions) {
    const agent = kind === 'codex'
      ? await harness.startFakeCodexWithTranscript(tmuxName, '019f0000-0000-7000-8000-000000000103')
      : kind === 'gjc'
        ? await harness.startFakeGjcWithTranscript(tmuxName, '019f0000-0000-7000-8000-000000000106')
        : await harness.startFakeExternal(kind, tmuxName);
    if (kind === 'codex' && 'transcriptPath' in agent) codexTranscriptPath = agent.transcriptPath;
    if (kind === 'gjc' && 'transcriptPath' in agent) gjcTranscriptPath = agent.transcriptPath;
    fixtures.push({ kind, displayName, tmuxName, agent });
  }
  await Promise.all(fixtures.map(({ agent }) => agent.waitUntilReady()));
  const [peerAAgent, peerBAgent] = await fixtureFleet.startCollisionPeers();
  const peerBLogBefore = await readFile(peerBAgent.logPath);
  const peerAEvent = 'cua-peer-a-only-event';
  const peerAInterruptObserved = peerAAgent.waitForInterrupt();
  await fixtureFleet.peers.a.sendInterrupt(fixtureFleet.collision.tmuxSessionName);
  await peerAInterruptObserved;
  const peerAInputObserved = peerAAgent.waitForInput(peerAEvent);
  await fixtureFleet.peers.a.sendInput(fixtureFleet.collision.tmuxSessionName, peerAEvent);
  await peerAInputObserved;
  const peerAEvents = await peerAAgent.events();
  const peerAInputs = peerAEvents.filter((event) => event.type === 'input');
  const peerAInterrupts = peerAEvents.filter((event) => event.type === 'interrupt').length;
  const peerAInputExact = peerAInputs.at(-1)?.value === peerAEvent;
  if (!peerAInputExact || peerAInterrupts !== 1) throw new Error('Peer A Ctrl-C contaminated its next input event.');
  const peerBLogAfter = await readFile(peerBAgent.logPath);
  if (!peerBLogBefore.equals(peerBLogAfter)) throw new Error('Peer A fixture events changed peer B NDJSON.');
  const codex = fixtures.find(({ kind }) => kind === 'codex');
  const gjc = fixtures.find(({ kind }) => kind === 'gjc');
  const openingPrompt = 'Give a concise status update for the ChatMux validation run.';
  const gjcOpeningPrompt = 'Prepare the deterministic interaction surface.';
  if (codex) {
    const inputObserved = codex.agent.waitForInput(openingPrompt);
    await harness.sendInput(codex.tmuxName, openingPrompt);
    await inputObserved;
  }
  if (gjc) {
    const inputObserved = gjc.agent.waitForInput(gjcOpeningPrompt);
    await harness.sendInput(gjc.tmuxName, gjcOpeningPrompt);
    await inputObserved;
  }
  const externalSessions = await harness.discoverFromFreshProcess();
  servers = await startFleetServers(repositoryRoot, [fixtureFleet.hub, fixtureFleet.peers.a, fixtureFleet.peers.b]);
  const [hubServer, peerAServer, peerBServer] = servers;
  if (hubServer === undefined || peerAServer === undefined || peerBServer === undefined) {
    throw new Error('The CUA fleet did not start all three installations.');
  }
  enrollment = await enrollFleetPeers(hubServer, [peerAServer, peerBServer]);
  control = await startFleetFixtureControl({
    repositoryRoot,
    peers: { 'peer-a': fixtureFleet.peers.a, 'peer-b': fixtureFleet.peers.b },
    initial: { 'peer-a': peerAServer, 'peer-b': peerBServer },
    onProcessesChanged: (peers) => {
      servers = [hubServer, peers['peer-a'], peers['peer-b']].filter((process): process is FleetProcess => process !== null);
    },
  });
  viteProcess = await startVite(repositoryRoot, vitePort, hubServer.port, path.join(evidenceRoot, 'vite.log'));
  const apiResponses = await Promise.all([
    fetch(`${servers[0]?.url}/api/providers/sessions/external`, { signal: AbortSignal.timeout(5_000) }),
    fetch(`${servers[0]?.url}/api/providers/sessions/live`, { signal: AbortSignal.timeout(5_000) }),
  ]);
  const processByHost = new Map(servers.map((server) => [server.hostId, server]));
  const nodeManifest = (node: typeof fixtureFleet.hub): object => {
    const server = processByHost.get(node.hostId);
    if (!server) throw new Error(`Missing server process for ${node.name}.`);
    return {
      role: server.role, name: node.name, hostId: node.hostId, tmuxServerPid: node.tmuxServerPid, home: node.home,
      databasePath: node.databasePath, tmuxTmpDir: node.tmuxTmpDir, socketPath: node.socketPath,
      port: server.port, path: node.environment.PATH, fakeAgentPath: node.fakeAgentPath,
      logRoot: node.logRoot, workspace: node.workspace, root: node.root, pid: server.pid, processGroupPid: server.processGroupPid,
      listener: { pid: server.listenerPid, address: `127.0.0.1:${server.port}` },
      health: { url: `${server.url}/health`, ...server.health }, serverLogPath: server.logPath,
    };
  };
  const manifest = {
    runId, startedAt: new Date().toISOString(), baseUrl, evidenceRoot, fleetRoot: fixtureFleet.root, harnessRoot: harness.root,
    workspace: harness.workspace, gjcTranscriptPath, codexTranscriptPath,
    ui: { pid: viteProcess.pid, port: vitePort, url: baseUrl, logPath: path.join(evidenceRoot, 'vite.log') },
    control: { url: control.url, owned: true },
    fleet: {
      toolTranscripts: [peerAAgent.transcriptPath, peerBAgent.transcriptPath],
      collision: fixtureFleet.collision,
      enrollment: { peers: enrollment.peers, observedFrameCount: enrollment.frames().length },
      eventIsolation: { peerAEvent, peerAInterrupts, peerAInputExact, peerBLogByteLengthBefore: peerBLogBefore.byteLength,
        peerBLogByteLengthAfter: peerBLogAfter.byteLength, peerBLogUnchanged: peerBLogBefore.equals(peerBLogAfter) },
      hub: nodeManifest(fixtureFleet.hub),
      peers: [nodeManifest(fixtureFleet.peers.a), nodeManifest(fixtureFleet.peers.b)],
    },
    agents: fixtures.map(({ kind, displayName, tmuxName, agent }) => ({ kind, displayName, tmuxName, logPath: agent.logPath })),
    discoveryProbe: externalSessions,
    api: { external: await apiResponses[0]?.json(), live: await apiResponses[1]?.json() },
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(evidenceRoot, 'fixture.json'), manifestJson, 'utf8'),
    mkdir(path.dirname(currentPath), { recursive: true }).then(() => writeFile(currentPath, manifestJson, 'utf8')),
  ]);
  process.stdout.write(`\nCUA_FIXTURE_READY=${JSON.stringify({ runId, baseUrl, apiUrl: servers[0]?.url, evidenceRoot })}\n`);
  await new Promise<void>(() => undefined);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await stop('startup failure', 1);
}
