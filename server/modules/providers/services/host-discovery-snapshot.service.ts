import { spawn } from 'node:child_process';

import { tmuxPaneIdentityKey, type TmuxPaneIdentity } from '../../../../shared/tmux.js';

import { recordHostCommand } from './host-command-metrics.service.js';
import {
  LocalTmuxDiscoveryError,
  boundedLocalTmuxInspection,
  inspectLocalTmuxSocket,
  localTmuxInventoryKey,
  parseLocalTmuxSocketInventory,
  rememberLocalTmuxSocket,
  resolveLocalTmuxSocket,
  sameLocalTmuxSocket,
  type LocalTmuxDiscoveryFailure,
  type LocalTmuxSocketInspector,
  type ResolvedLocalTmuxSocket,
} from './local-tmux-discovery.service.js';

const TMUX_FIELD_SEP = '\t';
// A completed host snapshot is not retained by default: external and live
// discovery start together and share the same in-flight capture. This removes
// duplicate commands without publishing a stale pane/process roster.
const DEFAULT_CACHE_TTL_MS = 0;

export const HOST_DISCOVERY_TMUX_FORMAT = [
  '#{socket_path}',
  '#{session_id}',
  '#{window_id}',
  '#{pane_id}',
  '#{session_name}',
  '#{pane_pid}',
  '#{pane_current_command}',
  '#{@chatmux_codex_thread_id}',
  '#{pane_current_path}',
  '#{@chatmux_cli_kind}',
  '#{@chatmux_provider_session_id}',
].join(TMUX_FIELD_SEP);

export type HostDiscoveryPane = {
  name: string;
  tmux: TmuxPaneIdentity;
  pid: number;
  command: string;
  codexThreadId?: string;
  cwd?: string;
  taggedKind?: string;
  taggedSessionId?: string;
};

export type HostDiscoveryProcess = {
  pid: number;
  ppid: number;
  comm: string;
  args?: string;
};

/** Server-private per-socket evidence; unavailable entries never contain panes. */
export type HostDiscoverySocketSnapshot = Readonly<{
  index: number;
  ok: boolean;
  panes: readonly HostDiscoveryPane[];
  reason?: LocalTmuxDiscoveryFailure;
}>;

export type HostDiscoverySnapshot = Readonly<{
  ok: boolean;
  capturedAtMs: number;
  sockets?: readonly HostDiscoverySocketSnapshot[];
  failure?: LocalTmuxDiscoveryFailure;
  panes: readonly HostDiscoveryPane[];
  processes: readonly HostDiscoveryProcess[];
}>;

export type HostDiscoveryPaneSnapshot = Readonly<{
  ok: boolean;
  capturedAtMs: number;
  sockets?: readonly HostDiscoverySocketSnapshot[];
  failure?: LocalTmuxDiscoveryFailure;
  panes: readonly HostDiscoveryPane[];
}>;

export type HostDiscoveryCommandRunner = (
  command: string,
  args: string[],
  timeoutMs?: number,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

export type HostDiscoverySnapshotSource = {
  get(): Promise<HostDiscoverySnapshot>;
  getFresh(): Promise<HostDiscoverySnapshot>;
  dispose(): void;
};

export const MAX_HOST_DISCOVERY_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Bounded observation children only; never kills a tmux server or pane. */
export function runHostDiscoveryCommand(
  command: string,
  args: string[],
  timeoutMs = 4000,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(new LocalTmuxDiscoveryError('cancelled'));
  recordHostCommand(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (failure?: LocalTmuxDiscoveryFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) {
        child.kill('SIGKILL');
        reject(new LocalTmuxDiscoveryError(failure));
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const abort = (): void => finish('cancelled');
    const timer = setTimeout(() => finish('capture_failed'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_HOST_DISCOVERY_OUTPUT_BYTES) finish('capture_failed');
      else chunks.push(chunk);
    });
    child.on('error', () => finish('capture_failed'));
    child.on('close', (code) => finish(code === 0 ? undefined : 'capture_failed'));
    if (signal?.aborted) abort();
  });
}

export function parseHostDiscoveryPanes(output: string): HostDiscoveryPane[] {
  const panes: HostDiscoveryPane[] = [];
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const fields = raw.split(TMUX_FIELD_SEP);
    if (fields.length < 8) continue;
    const legacyLiveFormat = fields.length < 11;
    const [
      rawSocketPath,
      rawSessionId,
      rawWindowId,
      rawPaneId,
      rawName,
      rawPid,
      rawCommand,
      fieldSeven,
      fieldEight,
      fieldNine,
      fieldTen,
    ] = fields;
    const rawCodexThreadId = legacyLiveFormat ? '' : fieldSeven;
    const rawCwd = legacyLiveFormat ? fieldSeven : fieldEight;
    const rawKind = legacyLiveFormat ? '' : fieldNine;
    const rawProviderSessionId = legacyLiveFormat ? '' : fieldTen;
    const tmux: TmuxPaneIdentity = {
      socketPath: rawSocketPath,
      sessionId: rawSessionId.trim(),
      windowId: rawWindowId.trim(),
      paneId: rawPaneId.trim(),
    };
    const name = rawName.trim();
    const pid = Number.parseInt(rawPid.trim(), 10);
    const command = rawCommand.trim();
    const codexThreadId = rawCodexThreadId?.trim() ?? '';
    const cwd = rawCwd?.trim() ?? '';
    const taggedKind = rawKind?.trim() ?? '';
    const taggedSessionId = rawProviderSessionId?.trim() ?? '';
    if (
      !tmux.socketPath
      || !/^\$\d+$/.test(tmux.sessionId)
      || !/^@\d+$/.test(tmux.windowId)
      || !/^%\d+$/.test(tmux.paneId)
      || !name
      || !Number.isFinite(pid)
    ) {
      continue;
    }
    panes.push({
      name,
      tmux,
      pid,
      command,
      ...(codexThreadId ? { codexThreadId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(taggedKind ? { taggedKind } : {}),
      ...(taggedSessionId ? { taggedSessionId } : {}),
    });
  }
  return panes;
}

export function parseHostDiscoveryProcesses(output: string): HostDiscoveryProcess[] {
  const processes: HostDiscoveryProcess[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const args = match[4]?.trim();
    processes.push({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      comm: match[3],
      ...(args ? { args } : {}),
    });
  }
  return processes;
}

export type HostDiscoveryCaptureOptions = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  socketInspector?: LocalTmuxSocketInspector;
};

type CapturePlan = {
  env: NodeJS.ProcessEnv;
  inventoryKey: string;
  sockets: readonly (ResolvedLocalTmuxSocket | null)[] | null;
};

async function planCapture(options: HostDiscoveryCaptureOptions): Promise<CapturePlan> {
  const env = { ...(options.env ?? process.env) };
  if (options.signal?.aborted) throw new LocalTmuxDiscoveryError('cancelled');
  const inventoryKey = localTmuxInventoryKey(env);
  const inventory = parseLocalTmuxSocketInventory(env.CHATMUX_TMUX_SOCKETS);
  const sockets = inventory && await Promise.all(inventory.map((selector) => (
    resolveLocalTmuxSocket(selector, env, options.signal).catch(() => null)
  )));
  const paths = sockets?.flatMap((socket) => socket ? [socket.socketPath] : []) ?? [];
  if (new Set(paths).size !== paths.length) throw new LocalTmuxDiscoveryError('configuration_invalid');
  return { env, inventoryKey, sockets };
}

function captureFailure(error: unknown): LocalTmuxDiscoveryFailure {
  return error instanceof LocalTmuxDiscoveryError ? error.code : 'capture_failed';
}

function assertCaptureCurrent(plan: CapturePlan, options: HostDiscoveryCaptureOptions): void {
  if (options.signal?.aborted) throw new LocalTmuxDiscoveryError('cancelled');
  if (plan.inventoryKey !== localTmuxInventoryKey(options.env ?? process.env)) {
    throw new LocalTmuxDiscoveryError('configuration_invalid');
  }
}

async function invokeCaptureCommand(
  runner: HostDiscoveryCommandRunner,
  command: string,
  args: string[],
  plan: CapturePlan,
  options: HostDiscoveryCaptureOptions,
): Promise<string> {
  assertCaptureCurrent(plan, options);
  if (runner !== runHostDiscoveryCommand) recordHostCommand(command, args);
  const output = await runner(command, args, 4000, options.signal, plan.env);
  assertCaptureCurrent(plan, options);
  if (Buffer.byteLength(output) > MAX_HOST_DISCOVERY_OUTPUT_BYTES) {
    throw new LocalTmuxDiscoveryError('capture_failed');
  }
  return output;
}

async function captureSocket(
  index: number,
  socket: ResolvedLocalTmuxSocket | null,
  plan: CapturePlan,
  runner: HostDiscoveryCommandRunner,
  options: HostDiscoveryCaptureOptions,
): Promise<HostDiscoverySocketSnapshot> {
  try {
    const inspect = (socketPath: string) => options.socketInspector
      ? boundedLocalTmuxInspection(() => options.socketInspector!(socketPath), options.signal)
      : inspectLocalTmuxSocket(socketPath, process.getuid?.(), options.signal);
    if (plan.sockets && !socket) throw new LocalTmuxDiscoveryError('socket_unavailable');
    const before = socket ? await inspect(socket.socketPath) : null;
    const output = await invokeCaptureCommand(runner, 'tmux', [
      ...(socket?.args ?? []), 'list-panes', '-a', '-F', HOST_DISCOVERY_TMUX_FORMAT,
    ], plan, options);
    const panes = parseHostDiscoveryPanes(output);
    if (socket && before) {
      const after = await inspect(socket.socketPath);
      const keys = new Set(panes.map((pane) => tmuxPaneIdentityKey(pane.tmux)));
      if (!sameLocalTmuxSocket(before, after)
        || panes.some((pane) => pane.tmux.socketPath !== socket.socketPath)
        || panes.length !== output.split(/\r?\n/).filter((line) => line.trim()).length
        || keys.size !== panes.length) {
        throw new LocalTmuxDiscoveryError('socket_identity_changed');
      }
      for (const pane of panes) rememberLocalTmuxSocket(pane.tmux, after);
    }
    return Object.freeze({ index, ok: true, panes: Object.freeze(panes) });
  } catch (error) {
    return Object.freeze({ index, ok: false, panes: Object.freeze([]), reason: captureFailure(error) });
  }
}

async function capturePlannedPanes(
  plan: CapturePlan,
  runner: HostDiscoveryCommandRunner,
  now: () => number,
  options: HostDiscoveryCaptureOptions,
): Promise<HostDiscoveryPaneSnapshot> {
  const sockets = await Promise.all((plan.sockets ?? [null]).map((socket, index) => (
    captureSocket(index, socket, plan, runner, options)
  )));
  assertCaptureCurrent(plan, options);
  return Object.freeze({
    ok: sockets.every((socket) => socket.ok),
    capturedAtMs: now(),
    sockets: Object.freeze(sockets),
    panes: Object.freeze(sockets.flatMap((socket) => [...socket.panes])),
  });
}

/** At most K presence commands, without process-tree/provider inference. */
export async function captureHostDiscoveryPanes(
  commandRunner: HostDiscoveryCommandRunner = runHostDiscoveryCommand,
  now: () => number = Date.now,
  options: HostDiscoveryCaptureOptions = {},
): Promise<HostDiscoveryPaneSnapshot> {
  try {
    return await capturePlannedPanes(await planCapture(options), commandRunner, now, options);
  } catch (error) {
    return Object.freeze({ ok: false, capturedAtMs: now(), panes: Object.freeze([]), failure: captureFailure(error) });
  }
}

/** Failed sockets contribute no panes. Lane adapters conservatively retain display rows. */
export async function captureHostDiscoverySnapshot(
  commandRunner: HostDiscoveryCommandRunner = runHostDiscoveryCommand,
  now: () => number = Date.now,
  options: HostDiscoveryCaptureOptions = {},
): Promise<HostDiscoverySnapshot> {
  try {
    const plan = await planCapture(options);
    const [paneResult, processResult] = await Promise.allSettled([
      capturePlannedPanes(plan, commandRunner, now, options),
      invokeCaptureCommand(commandRunner, 'ps', ['-eo', 'pid,ppid,comm,args'], plan, options),
    ]);
    if (paneResult.status === 'rejected') throw paneResult.reason;
    if (processResult.status === 'rejected') throw processResult.reason;
    const panes = paneResult.value;
    const psOutput = processResult.value;
    assertCaptureCurrent(plan, options);
    return Object.freeze({ ...panes, capturedAtMs: now(), processes: Object.freeze(parseHostDiscoveryProcesses(psOutput)) });
  } catch (error) {
    return Object.freeze({
      ok: false, capturedAtMs: now(), panes: Object.freeze([]), processes: Object.freeze([]), failure: captureFailure(error),
    });
  }
}

export function createHostDiscoverySnapshotSource(options: HostDiscoveryCaptureOptions & {
  commandRunner?: HostDiscoveryCommandRunner;
  now?: () => number;
  cacheTtlMs?: number;
} = {}): HostDiscoverySnapshotSource {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const commandRunner = options.commandRunner ?? runHostDiscoveryCommand;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let cached: { snapshot: HostDiscoverySnapshot; expiresAtMs: number; inventoryKey: string } | null = null;
  let inFlight: { capture: Promise<HostDiscoverySnapshot>; inventoryKey: string } | null = null;

  const captureShared = (fresh: boolean): Promise<HostDiscoverySnapshot> => {
    const inventoryKey = localTmuxInventoryKey(options.env ?? process.env);
    if (!signal.aborted && !fresh && cached && cached.inventoryKey === inventoryKey && now() < cached.expiresAtMs) {
      return Promise.resolve(cached.snapshot);
    }
    // Drain a prior inventory generation before another capture can launch.
    // Its current-config check makes superseded results unavailable.
    if (inFlight) return inFlight.capture;
    const current = captureHostDiscoverySnapshot(commandRunner, now, { ...options, signal })
      .then((snapshot) => {
        if (!signal.aborted && inventoryKey === localTmuxInventoryKey(options.env ?? process.env)) {
          cached = { snapshot, expiresAtMs: now() + cacheTtlMs, inventoryKey };
        }
        return snapshot;
      })
      .finally(() => {
        if (inFlight?.capture === current) inFlight = null;
      });
    inFlight = { capture: current, inventoryKey };
    return current;
  };

  return {
    get: () => captureShared(false),
    getFresh: () => captureShared(true),
    dispose: () => { cached = null; controller.abort(); },
  };
}

export const hostDiscoverySnapshotSource = createHostDiscoverySnapshotSource();
