import { spawn } from 'node:child_process';

import type { TmuxPaneIdentity } from '../../../../shared/tmux.js';

import { recordHostCommand } from './host-command-metrics.service.js';

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

export type HostDiscoverySnapshot = Readonly<{
  ok: boolean;
  capturedAtMs: number;
  panes: readonly HostDiscoveryPane[];
  processes: readonly HostDiscoveryProcess[];
}>;

export type HostDiscoveryPaneSnapshot = Readonly<{
  ok: boolean;
  capturedAtMs: number;
  panes: readonly HostDiscoveryPane[];
}>;

export type HostDiscoveryCommandRunner = (
  command: string,
  args: string[],
  timeoutMs?: number,
) => Promise<string>;

export type HostDiscoverySnapshotSource = {
  get(): Promise<HostDiscoverySnapshot>;
  getFresh(): Promise<HostDiscoverySnapshot>;
};

function runCommand(command: string, args: string[], timeoutMs = 4000): Promise<string> {
  recordHostCommand(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });
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
      socketPath: rawSocketPath.trim(),
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

/**
 * Lightweight presence probe used by the active sidebar cadence. A stable
 * pane roster does not need another process-tree/provider inference pass.
 */
export async function captureHostDiscoveryPanes(
  commandRunner: HostDiscoveryCommandRunner = runCommand,
  now: () => number = Date.now,
): Promise<HostDiscoveryPaneSnapshot> {
  const invoke = (command: string, args: string[]): Promise<string> => {
    if (commandRunner !== runCommand) recordHostCommand(command, args);
    return commandRunner(command, args);
  };
  try {
    const tmuxOutput = await invoke('tmux', [
      'list-panes',
      '-a',
      '-F',
      HOST_DISCOVERY_TMUX_FORMAT,
    ]);
    return Object.freeze({
      ok: true,
      capturedAtMs: now(),
      panes: Object.freeze(parseHostDiscoveryPanes(tmuxOutput)),
    });
  } catch {
    return Object.freeze({
      ok: false,
      capturedAtMs: now(),
      panes: Object.freeze([]),
    });
  }
}

export async function captureHostDiscoverySnapshot(
  commandRunner: HostDiscoveryCommandRunner = runCommand,
  now: () => number = Date.now,
): Promise<HostDiscoverySnapshot> {
  const invoke = (command: string, args: string[]): Promise<string> => {
    if (commandRunner !== runCommand) recordHostCommand(command, args);
    return commandRunner(command, args);
  };
  try {
    const [tmuxOutput, psOutput] = await Promise.all([
      invoke('tmux', ['list-panes', '-a', '-F', HOST_DISCOVERY_TMUX_FORMAT]),
      invoke('ps', ['-eo', 'pid,ppid,comm,args']),
    ]);
    return Object.freeze({
      ok: true,
      capturedAtMs: now(),
      panes: Object.freeze(parseHostDiscoveryPanes(tmuxOutput)),
      processes: Object.freeze(parseHostDiscoveryProcesses(psOutput)),
    });
  } catch {
    return Object.freeze({
      ok: false,
      capturedAtMs: now(),
      panes: Object.freeze([]),
      processes: Object.freeze([]),
    });
  }
}

export function createHostDiscoverySnapshotSource(options: {
  commandRunner?: HostDiscoveryCommandRunner;
  now?: () => number;
  cacheTtlMs?: number;
} = {}): HostDiscoverySnapshotSource {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const commandRunner = options.commandRunner ?? runCommand;
  let cached: { snapshot: HostDiscoverySnapshot; expiresAtMs: number } | null = null;
  let inFlight: Promise<HostDiscoverySnapshot> | null = null;

  const captureShared = (fresh: boolean): Promise<HostDiscoverySnapshot> => {
    if (!fresh && cached && now() < cached.expiresAtMs) {
      return Promise.resolve(cached.snapshot);
    }
    if (inFlight) return inFlight;
    const current = captureHostDiscoverySnapshot(commandRunner, now)
      .then((snapshot) => {
        cached = { snapshot, expiresAtMs: now() + cacheTtlMs };
        return snapshot;
      })
      .finally(() => {
        if (inFlight === current) inFlight = null;
      });
    inFlight = current;
    return current;
  };

  return {
    get: () => captureShared(false),
    getFresh: () => captureShared(true),
  };
}

export const hostDiscoverySnapshotSource = createHostDiscoverySnapshotSource();
