import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';
import { WebSocket } from 'ws';

import { startFleetServers, stopFleetProcesses, type FleetProcess } from '../../../../../scripts/cua/fleet-process-lifecycle.js';
import {
  createTmuxFleetE2EHarness,
  runTmux,
  shellQuote,
  type FakeTranscriptTmuxAgent,
  type TmuxFleetE2EHarness,
  type TmuxFleetNode,
} from '../../../../../scripts/cua/task-23-tmux.js';
import type { FleetPeerDescriptor } from '../../../../../shared/fleet.js';

import { applyBrowserCatalogFrame, isStateFrame, type FleetBrowserCatalog } from './task-23-catalog-frames.js';

export type { FleetBrowserCatalog } from './task-23-catalog-frames.js';

const REPO_ROOT = path.resolve('.');
const FRAME_BOUND_MS = 20_000;

type Frame = Readonly<Record<string, unknown>>;
type Role = 'hub' | 'peer-a' | 'peer-b';

export type Task23Fleet = Readonly<{
  harness: TmuxFleetE2EHarness;
  servers: { hub: FleetProcess; peerA: FleetProcess; peerB: FleetProcess };
  hostIds: { hub: string; a: string; b: string };
  agents: { a: FakeTranscriptTmuxAgent; b: FakeTranscriptTmuxAgent };
  request: (server: FleetProcess, method: string, route: string, body?: unknown) => Promise<Readonly<{ status: number; body: unknown }>>;
  hostRequest: (method: string, route: string, body?: unknown) => Promise<Readonly<{ status: number; body: unknown }>>;
  frames: () => readonly Frame[];
  waitForFrame: (predicate: (frame: Frame) => boolean, label: string) => Promise<Frame>;
  awaitPeerState: (hostId: string, state: FleetPeerDescriptor['state']) => Promise<Frame>;
  awaitCatalog: (hostId: string, predicate: (snapshot: FleetBrowserCatalog) => boolean, label: string) => Promise<FleetBrowserCatalog>;
  catalogNow: (hostId: string) => FleetBrowserCatalog | undefined;
  agentLogText: (agent: FakeTranscriptTmuxAgent) => Promise<string>;
  tmuxSessions: (node: TmuxFleetNode) => Promise<readonly string[]>;
  hubOutboxPayloads: () => readonly Readonly<Record<string, unknown>>[];
  tmux: (node: TmuxFleetNode, args: readonly string[]) => Promise<string>;
  waitForProcessExit: (pid: number) => Promise<void>;
  agentCommand: (node: TmuxFleetNode, executable: string, args: readonly string[]) => string;
  spawnedDir: (node: TmuxFleetNode) => string;
  stopServer: (role: Role) => Promise<void>;
  restartServer: (role: Role) => Promise<FleetProcess>;
  record: (name: string, value: unknown) => Promise<void>;
  operatorSessions: () => string;
  dispose: () => Promise<void>;
}>;

export async function startTask23Fleet(options: Readonly<{
  evidenceDir: string;
  liveNotify?: boolean;
  enroll?: boolean;
}>): Promise<Task23Fleet> {
  process.env.CHATMUX_FLEET_TRANSPORT_MODE = 'ssh-loopback';
  await mkdir(options.evidenceDir, { recursive: true });
  const frameLogPath = path.join(options.evidenceDir, 'fleet-frames.ndjson');
  await appendFile(frameLogPath, '');
  let frameWrites = Promise.resolve();
  const harness = await createTmuxFleetE2EHarness();
  const artifacts = new Map<string, unknown>();
  let disposed = false;
  const record = async (name: string, value: unknown): Promise<void> => {
    artifacts.set(name, value);
    await writeFile(path.join(options.evidenceDir, `${name}.json`), `${JSON.stringify(value, null, 1)}\n`);
  };
  try {
    const [agentA, agentB] = await harness.startCollisionPeers();
    const boots = [agentA.waitForTranscript(), agentB.waitForTranscript()];
    await harness.peers.a.sendInput(harness.collision.tmuxSessionName, 'peer-alpha-bootstrap');
    await harness.peers.b.sendInput(harness.collision.tmuxSessionName, 'peer-bravo-bootstrap');
    await Promise.all(boots);
    const env = {
      TOWER_URL: 'http://127.0.0.1:0',
      ...(options.liveNotify === true ? { CHATMUX_LIVE_NOTIFY: '1' } : {}),
    };
    const started = await startFleetServers(REPO_ROOT, [harness.hub, harness.peers.a, harness.peers.b], { env });
    const [hub, peerA, peerB] = started;
    assert.ok(hub !== undefined && peerA !== undefined && peerB !== undefined);
    const servers = { hub, peerA, peerB };
    const running = new Map<Role, FleetProcess>([['hub', hub], ['peer-a', peerA], ['peer-b', peerB]]);
    const stopped = new Set<Role>();
    const byRole = new Map<Role, TmuxFleetNode>([['hub', harness.hub], ['peer-a', harness.peers.a], ['peer-b', harness.peers.b]]);

    const request = async (server: FleetProcess, method: string, route: string, body?: unknown) => {
      const response = await fetch(`${server.url}${route}`, {
        method, headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const settingsOf = async (server: FleetProcess) => (await request(server, 'GET', '/api/fleet/settings')).body as {
      local: { installationId: string };
    };
    const hostIds = {
      hub: (await settingsOf(hub)).local.installationId,
      a: (await settingsOf(peerA)).local.installationId,
      b: (await settingsOf(peerB)).local.installationId,
    };

    // The browser subscription is armed BEFORE enrollment so every transition is captured.
    let ws: WebSocket | undefined;
    const frames: Frame[] = [];
    const catalogs = new Map<string, FleetBrowserCatalog>();
    const states = new Map<string, FleetPeerDescriptor['state']>();
    const waiters: Array<{ predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void; label: string }> = [];
    const connectBrowser = async (): Promise<void> => {
      const socket = new WebSocket(`${servers.hub.url.replace('http', 'ws')}/ws`);
      ws = socket;
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as Frame;
        frames.push(frame);
        frameWrites = frameWrites.then(() => appendFile(frameLogPath, `${JSON.stringify(frame)}\n`));
        if (typeof frame.hostId === 'string') {
          const next = applyBrowserCatalogFrame(catalogs.get(frame.hostId), frame);
          if (next !== undefined) catalogs.set(frame.hostId, next);
        }
        if (isStateFrame(frame)) states.set(frame.host.hostId, frame.host.state);
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          const waiter = waiters[index];
          if (waiter !== undefined && waiter.predicate(frame)) {
            waiters.splice(index, 1);
            waiter.resolve(frame);
          }
        }
      });
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      socket.send(JSON.stringify({ type: 'fleet.subscribe', protocolVersion: 'fleet/1' }));
    };
    await connectBrowser();
    const waitForFrame = (predicate: (frame: Frame) => boolean, label: string): Promise<Frame> => {
      return new Promise<Frame>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`fleet frame wait timed out: ${label}`)), FRAME_BOUND_MS);
        waiters.push({ predicate, label, resolve: (frame) => { clearTimeout(timeout); resolve(frame); } });
      });
    };
    const catalogNow = (hostId: string): FleetBrowserCatalog | undefined => catalogs.get(hostId);

    const enroll = options.enroll === false ? Promise.resolve() : (async () => {
      for (const [peer, label] of [[peerA, 'peer-a'], [peerB, 'peer-b']] as const) {
        const token = (await request(peer, 'POST', '/api/fleet/pairing-tokens', {})).body as { token: string };
        const enrolled = await request(hub, 'POST', '/api/fleet/peers', {
          peerUrl: `ws://127.0.0.1:${peer.port}/fleet-ws`, transportMode: 'ssh-loopback', token: token.token, label,
        });
        assert.equal(enrolled.status, 201, `enrollment of ${label} failed: ${JSON.stringify(enrolled.body)}`);
      }
    })();
    await enroll;

    const stopServer = async (role: Role): Promise<void> => {
      const current = running.get(role);
      assert.ok(current !== undefined && !stopped.has(role), `server ${role} is not running`);
      await stopFleetProcesses([current], null);
      running.delete(role);
      stopped.add(role);
    };
    const restartServer = async (role: Role): Promise<FleetProcess> => {
      const node = byRole.get(role);
      assert.ok(node !== undefined && stopped.has(role), `server ${role} was not stopped`);
      const prior = role === 'hub' ? servers.hub : role === 'peer-a' ? servers.peerA : servers.peerB;
      const [restarted] = await startFleetServers(REPO_ROOT, [{ ...node, port: prior.port }], { env });
      assert.ok(restarted !== undefined);
      if (role === 'hub') servers.hub = restarted;
      else if (role === 'peer-a') servers.peerA = restarted;
      else servers.peerB = restarted;
      running.set(role, restarted);
      stopped.delete(role);
      if (role === 'hub') await connectBrowser();
      return restarted;
    };
    const fleet: Task23Fleet = {
      harness, servers, hostIds,
      agents: { a: agentA, b: agentB },
      request,
      hostRequest: (method, route, body) => request(servers.hub, method, route, body),
      frames: () => [...frames],
      waitForFrame,
      awaitPeerState: (hostId, state) => states.get(hostId) === state
        ? Promise.resolve(frames.findLast((frame) => isStateFrame(frame) && frame.host.hostId === hostId) ?? {})
        : waitForFrame(
          (frame) => isStateFrame(frame) && frame.host.hostId === hostId && frame.host.state === state,
          `${hostId} ${state}`,
        ),
      awaitCatalog: async (hostId, predicate, label) => {
        const existing = catalogNow(hostId);
        if (existing !== undefined && predicate(existing)) return existing;
        await waitForFrame(
          (value) => value.hostId === hostId && predicate(catalogs.get(hostId)!),
          label,
        );
        const current = catalogs.get(hostId);
        assert.ok(current !== undefined, `catalog missing after ${label}`);
        return current;
      },
      catalogNow,
      agentLogText: (agent) => readFile(agent.logPath, 'utf8'),
      tmuxSessions: async (node) => (await runTmux(node.environment, ['list-sessions', '-F', '#{session_name}'])).trim().split('\n').filter(Boolean),
      hubOutboxPayloads: () => {
        const db = new Database(harness.hub.databasePath, { readonly: true });
        try {
          const rows = db.prepare('SELECT payload_json FROM completion_notification_outbox ORDER BY id').all() as Array<{ payload_json: string }>;
          return rows.map((row) => JSON.parse(row.payload_json) as Readonly<Record<string, unknown>>);
        } finally {
          db.close();
        }
      },
      stopServer, restartServer, record,
      tmux: (node, args) => runTmux(node.environment, [...args]),
      waitForProcessExit: (pid) => new Promise<void>((resolve, reject) => {
        const code = [
          'import os,select,sys',
          'try: fd=os.pidfd_open(int(sys.argv[1]))',
          "except ProcessLookupError: sys.exit(0)",
          'select.select([fd],[],[])',
        ].join('\n');
        const waiter = spawn('python3', ['-c', code, String(pid)], { stdio: ['ignore', 'ignore', 'ignore'] });
        const timeout = setTimeout(() => { waiter.kill('SIGKILL'); reject(new Error(`pid ${pid} exit timed out`)); }, 15_000);
        waiter.once('exit', () => { clearTimeout(timeout); resolve(); });
        waiter.once('error', reject);
      }),
      agentCommand: (node, executable, args) => [
        process.execPath, path.join(node.fakeAgentPath, executable), ...args,
      ].map(shellQuote).join(' '),
      spawnedDir: (node) => path.join(node.home, '.chatmux-cua-spawned'),
      operatorSessions: () => spawnSync('tmux', ['list-sessions', '-F', '#{socket_path}\t#{pid}\t#{session_name}'], { encoding: 'utf8' }).stdout,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        ws?.close();
        await frameWrites;
        const ownedProcesses = [...running.values()];
        await stopFleetProcesses(ownedProcesses, null).catch(() => undefined);
        const processLogs = Object.fromEntries(await Promise.all(
          ownedProcesses.map(async (server) => [server.hostId, await readFile(server.logPath, 'utf8').catch(() => '')]),
        ));
        await record('server-process-logs', processLogs);
        await appendFile(path.join(options.evidenceDir, 'server-process-logs.ndjson'), `${JSON.stringify(processLogs)}\n`);
        await harness.dispose();
      },
    };
    const manifest = {
      collision: harness.collision,
      hostIds,
      nodes: [harness.hub, harness.peers.a, harness.peers.b].map((node) => ({
        name: node.name, tmuxServerPid: node.tmuxServerPid, socketPath: node.socketPath, port: node.port,
      })),
      serverPids: started.map((server) => ({ hostId: server.hostId, pid: server.pid, port: server.port })),
    };
    await record('fixture-manifest', manifest);
    await appendFile(path.join(options.evidenceDir, 'fixture-manifests.ndjson'), `${JSON.stringify(manifest)}\n`);
    return fleet;
  } catch (error) {
    await harness.dispose().catch(() => undefined);
    throw error;
  }
}
