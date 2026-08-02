import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';

import type { ProcessGeneration, PublicTerminalRef, PublicTerminalTarget, RuntimeCapabilities, RuntimeCapability, SourceDescriptor } from '../../../shared/terminal-runtime.js';
import { readPublicTerminalRef } from '../../../shared/terminal-runtime.js';

import { HerdrClient, HERDR_LIMITS } from './herdr-client.service.js';
import type { HerdrConfiguredSource, HerdrRuntimeConfig } from './herdr-config.service.js';
import type { HerdrResolvedSource, HerdrResolvedTerminal, HerdrSourceId, HerdrTargetId } from './herdr-internal.types.js';
import { HERDR_SEMANTIC_FINGERPRINT, probeHerdrCompatibility, probeHerdrStaticCompatibility, type HerdrCompatibility } from './herdr-probe.service.js';
import { HerdrTargetRegistry } from './herdr-target-registry.service.js';
import { RuntimeOperationPolicyService } from './runtime-operation-policy.service.js';
import type { RuntimeDiscoveryOutcome, RuntimeTargetProfile } from './runtime-registry.service.js';
import { ProtectedTerminalTargetService, type ProtectedTerminalTargetEvidence } from './protected-terminal-target.service.js';

const MAX_TARGETS_PER_SOURCE = 256;
const MAX_CONTROLLERS_PER_SOURCE = 4;
const MAX_CONTROLLERS_GLOBAL = 32;
export const HERDR_SOCKET_OWNER_LIMITS = { deadlineMs: 1_000, processes: 8_192, descriptors: 4_096 } as const;
type Admission = (sourceId: HerdrSourceId, paneId: string) => string | null;
type ProcessResolver = (pid: number) => Promise<ProcessGeneration | null>;
type SocketOwnerResolver = (socketPath: string, binaryPath: string) => Promise<ProcessGeneration | null>;
type Fs = { lstat(path: string): Promise<Stats>; realpath(path: string): Promise<string> };
type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
type AgentInfo = { agent: string | null; displayAgent: string | null; agentStatus: AgentStatus };
type Pane = { paneId: string; terminalId: string; terminalIncarnation: string; workspaceId: string; tabId: string; revision: number; agent: AgentInfo | null };
type Endpoint = { source: HerdrResolvedSource; generation: number; compatibilityKey: string };
type Controller = { command: string; args: string[]; release: () => void };
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function id(value: unknown): string | null { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null; }
function parsed(result: { code: number | null; stdout: string; timedOut: boolean; oversized: boolean; stderrOverflow?: boolean; spawnError: boolean }): unknown | null { if (result.code !== 0 || result.timedOut || result.oversized || result.stderrOverflow || result.spawnError || Buffer.byteLength(result.stdout, 'utf8') > HERDR_LIMITS.snapshot.stdoutBytes) return null; try { return JSON.parse(result.stdout); } catch { return null; } }
function result(value: unknown, type: string): Record<string, unknown> | null { const outer = record(value); const inner = record(outer?.result); return inner?.type === type ? inner : null; }
function agentInfo(value: unknown): AgentInfo | null {
  const valueRecord = record(value);
  const rawAgent = valueRecord?.agent;
  const rawDisplayAgent = valueRecord?.display_agent;
  const agent = rawAgent === undefined ? null : rawAgent;
  const displayAgent = rawDisplayAgent === undefined ? null : rawDisplayAgent;
  const agentStatus = valueRecord?.agent_status;
  return (typeof agent === 'string' || agent === null)
    && (typeof displayAgent === 'string' || displayAgent === null)
    && (agentStatus === 'idle' || agentStatus === 'working' || agentStatus === 'blocked' || agentStatus === 'done' || agentStatus === 'unknown')
    ? { agent, displayAgent, agentStatus }
    : null;
}
function pane(value: unknown, agents: Map<string, AgentInfo>): Pane | null {
  const valueRecord = record(value); if (!valueRecord) return null;
  const paneId = id(valueRecord.pane_id); const terminalId = id(valueRecord.terminal_id); const terminalIncarnation = id(valueRecord.terminal_incarnation) ?? terminalId; const workspaceId = id(valueRecord.workspace_id); const tabId = id(valueRecord.tab_id);
  if (!paneId || !terminalId || !terminalIncarnation || !workspaceId || !tabId || !Number.isSafeInteger(valueRecord.revision) || !agentInfo(valueRecord)) return null;
  return { paneId, terminalId, terminalIncarnation, workspaceId, tabId, revision: valueRecord.revision as number, agent: agents.get(paneId) ?? agentInfo(valueRecord) };
}
async function linuxProcessGeneration(pid: number): Promise<ProcessGeneration | null> {
  if (!Number.isSafeInteger(pid) || pid < 1 || process.platform !== 'linux') return null;
  try {
    const [processStat, kernelStat] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/stat', 'utf8')]);
    const close = processStat.lastIndexOf(')');
    const fields = processStat.slice(close + 2).trim().split(/\s+/);
    const startTicks = Number(fields[19]);
    const bootSeconds = Number(kernelStat.match(/^btime\s+(\d+)$/m)?.[1]);
    const startedAtMs = bootSeconds * 1000 + startTicks * 10;
    return Number.isSafeInteger(startTicks) && startTicks > 0 && Number.isSafeInteger(bootSeconds) && bootSeconds > 0 && Number.isSafeInteger(startedAtMs)
      ? { pid, startedAtMs }
      : null;
  } catch {
    return null;
  }
}

export async function linuxSocketOwnerGeneration(socketPath: string, binaryPath: string): Promise<ProcessGeneration | null> {
  if (process.platform !== 'linux') return null;
  const deadline = Date.now() + HERDR_SOCKET_OWNER_LIMITS.deadlineMs;
  let descriptorsSeen = 0;
  try {
    const inodes = new Set(
      (await readFile('/proc/net/unix', 'utf8'))
        .split('\n')
        .filter((line) => line.trimEnd().endsWith(` ${socketPath}`))
        .map((line) => line.trim().split(/\s+/)[6])
        .filter((inode): inode is string => typeof inode === 'string' && /^\d+$/.test(inode)),
    );
    if (!inodes.size || Date.now() >= deadline) return null;
    const processIds = (await readdir('/proc', { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name))
      .slice(0, HERDR_SOCKET_OWNER_LIMITS.processes)
      .map((entry) => entry.name);
    for (let offset = 0; offset < processIds.length; offset += 128) {
      if (Date.now() >= deadline) return null;
      const matching = (await Promise.all(processIds.slice(offset, offset + 128).map(async (pid) => {
        try {
          return await readlink(`/proc/${pid}/exe`) === binaryPath ? pid : null;
        } catch {
          return null;
        }
      }))).filter((pid): pid is string => pid !== null);
      for (const pid of matching) {
        let descriptors: string[];
        try {
          descriptors = await readdir(`/proc/${pid}/fd`);
        } catch {
          continue;
        }
        for (const descriptor of descriptors) {
          if (Date.now() >= deadline || descriptorsSeen >= HERDR_SOCKET_OWNER_LIMITS.descriptors) return null;
          descriptorsSeen += 1;
          try {
            const link = await readlink(`/proc/${pid}/fd/${descriptor}`);
            const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
            if (inode && inodes.has(inode)) return linuxProcessGeneration(Number(pid));
          } catch {
            // Processes and descriptors can disappear while /proc is scanned.
          }
        }
      }
    }
  } catch {
    // Missing or unreadable procfs means the source identity cannot be trusted.
  }
  return null;
}

/** External Herdr adapter: it never creates, starts, takes over, or controls a provider. */
export class HerdrRuntimeAdapter {
  readonly runtime = 'herdr' as const;
  private readonly sources = new Map<HerdrSourceId, HerdrConfiguredSource>();
  private readonly generations = new Map<HerdrSourceId, { identity: string; generation: number }>();
  private readonly leases = new Map<string, { sourceId: HerdrSourceId; released: boolean; controller: Controller }>();
  private readonly compatibility = new Map<HerdrSourceId, { key: string; checked: Promise<HerdrCompatibility> }>();
  private readonly socketOwners = new Map<HerdrSourceId, { socketIdentity: string; process: ProcessGeneration }>();
  private readonly socketOwnerProbes = new Map<string, Promise<ProcessGeneration | null>>();
  private readonly protection = new Map<string, ProtectedTerminalTargetEvidence>();
  constructor(private readonly config: HerdrRuntimeConfig, private readonly policy: RuntimeOperationPolicyService, private readonly targets = new HerdrTargetRegistry(), private readonly client = new HerdrClient(), private readonly admission: Admission = () => null, private readonly fs: Fs = { lstat, realpath }, private readonly resolveProcess: ProcessResolver = linuxProcessGeneration, private readonly resolveSocketOwner: SocketOwnerResolver = linuxSocketOwnerGeneration, private readonly protectedTargets = new ProtectedTerminalTargetService()) { for (const source of config.sources) this.sources.set(source.sourceId, source); this.policy.onReduction(() => { this.targets.clear(); this.leases.clear(); this.protection.clear(); }); }
  capabilities(sourceId: HerdrSourceId): RuntimeCapabilities { return this.policy.capabilities(sourceId); }
  private async endpoint(configured: HerdrConfiguredSource): Promise<Endpoint | null> {
    try {
      const [binaryPath, binaryStat, list] = await Promise.all([this.fs.realpath(configured.binary), this.fs.lstat(configured.binary), this.client.sessionList(configured)]);
      if (binaryPath !== configured.binary || !binaryStat.isFile() || binaryStat.isSymbolicLink() || binaryStat.uid !== process.getuid?.() || (binaryStat.mode & 0o022) !== 0) return null;
      const listValue = parsed(list); const listRoot = record(listValue); const listResult = record(listRoot?.result); const sessions = Array.isArray(listResult?.sessions) ? listResult.sessions : Array.isArray(listRoot?.sessions) ? listRoot.sessions : null; if (!sessions) return null;
      const session = sessions.map(record).find((item) => item?.name === configured.selector);
      const listedServerPid = typeof session?.server_pid === 'number' && Number.isSafeInteger(session.server_pid) && session.server_pid > 0 ? session.server_pid : null;
      if (!session || session.running !== true || typeof session.socket_path !== 'string' || !session.socket_path.startsWith('/')) return null;
      const socketPath = await this.fs.realpath(session.socket_path); const socket = await this.fs.lstat(socketPath);
      if (socketPath !== session.socket_path || !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== process.getuid?.() || (socket.mode & 0o022) !== 0) return null;
      const socketIdentity = `${socket.dev}:${socket.ino}`;
      const cachedOwner = this.socketOwners.get(configured.sourceId);
      let server = listedServerPid ? await this.resolveProcess(listedServerPid) : null;
      if (!server && listedServerPid === null && cachedOwner?.socketIdentity === socketIdentity) {
        const current = await this.resolveProcess(cachedOwner.process.pid);
        if (current?.startedAtMs === cachedOwner.process.startedAtMs) server = current;
      }
      if (!server && listedServerPid === null) {
        const probe = this.socketOwnerProbes.get(socketIdentity) ?? this.resolveSocketOwner(socketPath, binaryPath).finally(() => this.socketOwnerProbes.delete(socketIdentity));
        this.socketOwnerProbes.set(socketIdentity, probe);
        server = await probe;
      }
      if (!server || (listedServerPid !== null && server.pid !== listedServerPid) || !Number.isSafeInteger(server.startedAtMs) || server.startedAtMs < 1) return null;
      this.socketOwners.set(configured.sourceId, { socketIdentity, process: server });
      const identity = `${socket.dev}:${socket.ino}:${server.pid}:${server.startedAtMs}`; const prior = this.generations.get(configured.sourceId); const generation = prior?.identity === identity ? prior.generation : (prior?.generation ?? 0) + 1;
      if (prior && prior.identity !== identity) { this.targets.invalidateSource(configured.sourceId); for (const key of this.protection.keys()) if (key.startsWith(`${configured.sourceId}\0`)) this.protection.delete(key); } this.generations.set(configured.sourceId, { identity, generation });
      return { generation, compatibilityKey: `${binaryStat.dev}:${binaryStat.ino}:${binaryStat.size}:${binaryStat.mtimeMs}:${binaryStat.ctimeMs}`, source: { sourceId: configured.sourceId, alias: configured.alias, binary: configured.binary, selector: configured.selector, canonicalSocketPath: socketPath, socketStat: { uid: socket.uid, mode: socket.mode, device: socket.dev, inode: socket.ino }, serverIncarnation: identity, probeFingerprint: HERDR_SEMANTIC_FINGERPRINT, internalGeneration: generation, transport: 'herdr terminal session control' } };
    } catch { return null; }
  }
  private async ready(sourceId: HerdrSourceId, operation: RuntimeCapability): Promise<Endpoint | null> { const configured = this.sources.get(sourceId); if (!configured || !this.config.enabled || !this.policy.allows(sourceId, operation)) return null; const endpoint = await this.endpoint(configured); if (!endpoint) return null; const cached = this.compatibility.get(sourceId); const checked = cached?.key === endpoint.compatibilityKey ? cached.checked : probeHerdrStaticCompatibility(configured, this.config.startupCapabilities, this.client); if (!cached || cached.key !== endpoint.compatibilityKey) this.compatibility.set(sourceId, { key: endpoint.compatibilityKey, checked }); const compatibility = await checked; if ((compatibility.readiness !== 'ready' && compatibility.readiness !== 'degraded') || !compatibility.capabilities[operation] || !this.policy.allows(sourceId, operation)) return null; return endpoint; }
  async sourceDescriptors(): Promise<SourceDescriptor[]> {
    return Promise.all([...this.sources.values()].map(async (source) => {
      const endpoint = await this.endpoint(source);
      if (!endpoint) return { runtime: 'herdr' as const, sourceId: source.sourceId, readiness: 'offline' as const };
      const cached = this.compatibility.get(source.sourceId);
      const checked = cached?.key === endpoint.compatibilityKey ? cached.checked : probeHerdrStaticCompatibility(source, this.config.startupCapabilities, this.client);
      if (!cached || cached.key !== endpoint.compatibilityKey) this.compatibility.set(source.sourceId, { key: endpoint.compatibilityKey, checked });
      const probe = await probeHerdrCompatibility(source, this.config.startupCapabilities, this.client, process.platform, process.arch, await checked);
      return { runtime: 'herdr' as const, sourceId: source.sourceId, readiness: probe.readiness === 'ready' ? 'ready' as const : probe.readiness };
    }));
  }
  private async snapshot(source: HerdrResolvedSource): Promise<{ panes: Pane[]; agents: Map<string, AgentInfo> } | null> {
    const root = result(parsed(await this.client.snapshot(source)), 'session_snapshot'); const snapshot = record(root?.snapshot); const values = Array.isArray(snapshot?.panes) ? snapshot.panes : null; const rawAgents = Array.isArray(snapshot?.agents) ? snapshot.agents : null; if (!values || !rawAgents || values.length > MAX_TARGETS_PER_SOURCE) return null;
    const agents = new Map<string, AgentInfo>(); for (const raw of rawAgents) { const agent = record(raw); const paneId = id(agent?.pane_id); const info = agentInfo(agent); if (!paneId || !info || agents.has(paneId)) return null; agents.set(paneId, info); }
    const panes = values.map((value) => pane(value, agents)); return panes.every((value): value is Pane => value !== null) ? { panes, agents } : null;
  }
  private terminalFromPane(source: HerdrResolvedSource, listed: Pane): HerdrResolvedTerminal {
    const agent = listed.agent?.agent ? { agentId: listed.agent.agent, agentKind: listed.agent.agent } : null;
    return { source, hierarchy: { workspaceId: listed.workspaceId, tabId: listed.tabId, paneId: listed.paneId }, terminalId: listed.terminalId, terminalIncarnation: listed.terminalIncarnation, terminalRevision: listed.revision, agent, process: null, targetClass: 'attach-only' };
  }
  private async discoverSource(configured: HerdrConfiguredSource): Promise<RuntimeDiscoveryOutcome> {
    const failed = (): RuntimeDiscoveryOutcome => ({ runtime: 'herdr', sourceId: configured.sourceId, ok: false, terminals: [] });
    const endpoint = await this.ready(configured.sourceId, 'discovery');
    if (!endpoint) return failed();
    const discovered = await this.snapshot(endpoint.source);
    if (!discovered) return failed();
    const terminals: PublicTerminalTarget[] = [];
    for (const listed of discovered.panes) {
      const terminal = this.terminalFromPane(endpoint.source, listed);
      const evidence = this.protectedTargets.evidence(terminal);
      if (!evidence || evidence.protected) return failed();
      const admission = this.admission(configured.sourceId, listed.paneId);
      const target = this.targets.mint(terminal, endpoint.generation, admission);
      if (!target || target.runtime !== 'herdr') return failed();
      this.protection.set(`${configured.sourceId}\0${target.targetId}`, evidence);
      terminals.push(target);
    }
    return { runtime: 'herdr', sourceId: configured.sourceId, ok: true, terminals };
  }
  discoverOutcomes(): Promise<RuntimeDiscoveryOutcome[]> {
    return Promise.all([...this.sources.values()].map((source) => this.discoverSource(source)));
  }
  async discover(): Promise<PublicTerminalTarget[]> {
    return (await this.discoverOutcomes()).flatMap((outcome) => outcome.ok ? [...outcome.terminals] : []);
  }
  async scanDiscovery(): Promise<{ sources: SourceDescriptor[]; outcomes: RuntimeDiscoveryOutcome[] }> {
    const outcomes = await this.discoverOutcomes();
    return {
      sources: outcomes.map(({ sourceId, ok }) => ({
        runtime: 'herdr' as const,
        sourceId,
        readiness: ok ? 'ready' as const : 'offline' as const,
      })),
      outcomes,
    };
  }
  private async resolveFresh(ref: Extract<PublicTerminalRef, { runtime: 'herdr' }>, operation: 'output' | 'actions' | 'attach'): Promise<{ source: HerdrResolvedSource; terminal: HerdrResolvedTerminal } | null> { const publicRef = readPublicTerminalRef(ref); if (!publicRef || publicRef.runtime !== 'herdr') return null; const sourceId = publicRef.sourceId as HerdrSourceId; const targetId = publicRef.targetId as HerdrTargetId; const expectedProtection = this.protection.get(`${sourceId}\0${targetId}`); if (!expectedProtection) return null; const endpoint = await this.ready(sourceId, operation); if (!endpoint) return null; const locator = this.targets.locate(sourceId, targetId, endpoint.generation); if (!locator) return null; const gotRoot = result(parsed(await this.client.paneGet(endpoint.source, locator.paneId)), 'pane_info'); const listed = pane(record(gotRoot?.pane), new Map()); if (!listed || listed.paneId !== locator.paneId) return null; const terminal = this.terminalFromPane(endpoint.source, listed); if (!this.protectedTargets.allows(terminal, expectedProtection) || !this.targets.resolve(sourceId, targetId, terminal, endpoint.generation)) return null; if (operation === 'actions' && terminal.targetClass !== 'local-agent') return null; return { source: endpoint.source, terminal }; }
  async verify(ref: Extract<PublicTerminalRef, { runtime: 'herdr' }>, operation: 'output' | 'actions' | 'attach'): Promise<boolean> { return !!await this.resolveFresh(ref, operation); }
  async targetProfile(ref: Extract<PublicTerminalRef, { runtime: 'herdr' }>): Promise<RuntimeTargetProfile | null> { const publicRef = readPublicTerminalRef(ref); if (!publicRef || publicRef.runtime !== 'herdr' || !this.protection.has(`${publicRef.sourceId}\0${publicRef.targetId}`)) return null; return this.targets.profile(publicRef.sourceId as HerdrSourceId, publicRef.targetId as HerdrTargetId); }
  async read(ref: Extract<PublicTerminalRef, { runtime: 'herdr' }>): Promise<{ ansi: string; truncated: boolean } | null> { const verified = await this.resolveFresh(ref, 'output'); if (!verified) return null; const output = await this.client.paneRead(verified.source, verified.terminal.hierarchy.paneId); return output.code === 0 && !output.timedOut && !output.oversized && !output.stderrOverflow && !output.spawnError ? { ansi: output.stdout, truncated: false } : null; }
  async send(ref: Extract<PublicTerminalRef, { runtime: 'herdr' }>, literal: string): Promise<boolean> { const verified = await this.resolveFresh(ref, 'actions'); if (!verified) return false; const output = await this.client.paneSendText(verified.source, verified.terminal.hierarchy.paneId, literal); return output.code === 0 && !output.timedOut && !output.oversized && !output.stderrOverflow && !output.spawnError; }
  async interrupt(ref: Extract<PublicTerminalRef, { runtime: 'herdr' }>): Promise<boolean> { return this.keys(ref, ['ctrl+c']); }
  async escape(ref: Extract<PublicTerminalRef, { runtime: 'herdr' }>): Promise<boolean> { return this.keys(ref, ['esc']); }
  private async keys(ref: Extract<PublicTerminalRef, { runtime: 'herdr' }>, keys: string[]): Promise<boolean> { const verified = await this.resolveFresh(ref, 'actions'); if (!verified) return false; const output = await this.client.paneSendKeys(verified.source, verified.terminal.hierarchy.paneId, keys); return output.code === 0 && !output.timedOut && !output.oversized && !output.stderrOverflow && !output.spawnError; }
  async controllerArgv(ref: Extract<PublicTerminalRef, { runtime: 'herdr' }>, cols: number, rows: number): Promise<Controller | null> { const verified = await this.resolveFresh(ref, 'attach'); if (!verified) return null; const sourceId = ref.sourceId as HerdrSourceId; const key = `${ref.sourceId}\0${ref.targetId}`; const existing = this.leases.get(key); if (existing && !existing.released) return null; const sourceCount = [...this.leases.values()].filter((lease) => !lease.released && lease.sourceId === sourceId).length; const globalCount = [...this.leases.values()].filter((lease) => !lease.released).length; if (sourceCount >= MAX_CONTROLLERS_PER_SOURCE || globalCount >= MAX_CONTROLLERS_GLOBAL) return null; let args: string[]; try { args = this.client.controllerArgv(verified.source, verified.terminal.hierarchy.paneId, cols, rows); } catch { return null; } const lease = { sourceId, released: false, controller: undefined as unknown as Controller }; const controller: Controller = { command: verified.source.binary, args, release: () => { if (!lease.released) { lease.released = true; this.leases.delete(key); } } }; lease.controller = controller; this.leases.set(key, lease); return controller; }
  dispose(): void { this.targets.clear(); this.leases.clear(); this.compatibility.clear(); this.generations.clear(); this.socketOwners.clear(); this.socketOwnerProbes.clear(); this.protection.clear(); }
}
