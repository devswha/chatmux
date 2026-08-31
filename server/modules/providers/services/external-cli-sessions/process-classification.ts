import { spawn } from 'node:child_process';

import { isCursorCliProcess } from '@/modules/providers/list/cursor/cursor-cli-command.js';

import { recordHostCommand } from '../host-command-metrics.service.js';
import { isGjcProcessArgs } from '../live-sessions/process-contracts.js';

import type { ExternalCliKind, ExternalCliSession, ExternalLocalCliKind, ExternalPane, ProcessTreeEntry } from './contracts-and-resume.js';
import { CLAUDE_SESSION_ID_RE, CODEX_THREAD_ID_RE, extractExternalResumeSessionId } from './contracts-and-resume.js';


export function parseClaudeRuntimeSession(
  value: unknown,
  expectedPid: number,
): { sessionId: string; cwd: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as { pid?: unknown; sessionId?: unknown; cwd?: unknown };
  if (
    receipt.pid !== expectedPid
    || typeof receipt.sessionId !== 'string'
    || !CLAUDE_SESSION_ID_RE.test(receipt.sessionId)
    || typeof receipt.cwd !== 'string'
    || !receipt.cwd.trim()
  ) {
    return null;
  }
  return { sessionId: receipt.sessionId, cwd: receipt.cwd };
}

export function processCliKind(proc: Pick<ProcessTreeEntry, 'comm' | 'args'>): ExternalLocalCliKind | 'gjc' | 'ssh' | null {
  const comm = proc.comm.toLowerCase();
  const argv = proc.args ?? '';
  const executable = (name: string): boolean => (
    comm === name
    || new RegExp(`(?:^|\\s)(?:\\S*/)?${name.replace('-', '\\-')}(?=\\s|$)`, 'i').test(argv)
  );
  if (executable('gjc') && isGjcProcessArgs(argv.trim() || proc.comm)) return 'gjc';
  if (executable('claude')) return 'claude';
  if (executable('codex')) return 'codex';
  if (isCursorCliProcess(proc)) return 'cursor';
  if (executable('opencode')) return 'opencode';
  if (executable('omp')) return 'omp';
  // omo is a node script reached through a PATH shim, so argv carries
  // `<node> /…/bin/omo` (no extension) and `executable` matches that token.
  if (executable('omo')) return 'omo';
  if (executable('ssh')) return 'ssh';
  return null;
}

export function isInteractiveShellProcess(proc: ProcessTreeEntry | undefined): boolean {
  return Boolean(proc && /^(?:ba|da|z|k)?sh$|^(?:fish|nu)$/.test(proc.comm.toLowerCase()));
}

export function isCodexRuntimeProcess(
  proc: Pick<ProcessTreeEntry, 'comm' | 'args'>,
): boolean {
  return processCliKind(proc) === 'codex'
    && !proc.args?.includes(' app-server')
    && !proc.args?.includes('code-mode');
}

export function isClaudeRuntimeProcess(
  proc: Pick<ProcessTreeEntry, 'comm' | 'args'>,
): boolean {
  return processCliKind(proc) === 'claude';
}

/**
 * Foreground-aware process classification. A GJC descendant excludes the tmux
 * session from this lane. Other agents must own the pane foreground (or carry
 * a ChatMux spawn tag); Codex additionally supports its observed node-wrapper
 * shape. This keeps background/batch agents inside app panes out of the UI.
 */
export function classifyExternalSessions(args: {
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
}): ExternalCliSession[] {
  const children = new Map<number, number[]>();
  const procByPid = new Map<number, ProcessTreeEntry>();
  for (const proc of args.procs) {
    procByPid.set(proc.pid, proc);
    const siblings = children.get(proc.ppid) ?? [];
    siblings.push(proc.pid);
    children.set(proc.ppid, siblings);
  }

  const priority: Array<Exclude<ExternalCliKind, 'shell'>> = ['claude', 'codex', 'cursor', 'opencode', 'omp', 'omo', 'ssh'];
  const result: ExternalCliSession[] = [];
  for (const pane of args.panes) {

    const kinds = new Set<ExternalLocalCliKind | 'gjc' | 'ssh'>();
    const taggedKinds = new Set<ExternalLocalCliKind>();
    const sessionIds = new Map<ExternalLocalCliKind, Set<string>>();
    if (pane.taggedKind) {
      taggedKinds.add(pane.taggedKind);
      kinds.add(pane.taggedKind);
      if (pane.taggedSessionId) {
        sessionIds.set(pane.taggedKind, new Set([pane.taggedSessionId]));
      }
    }
    if (pane.codexThreadId && CODEX_THREAD_ID_RE.test(pane.codexThreadId)) {
      kinds.add('codex');
      sessionIds.set('codex', new Set([pane.codexThreadId]));
    }

    const subtreeKinds: Array<{
      kind: ExternalLocalCliKind | 'gjc' | 'ssh';
      proc: ProcessTreeEntry;
    }> = [];
    for (const pid of descendants(pane.pid, children)) {
      const proc = procByPid.get(pid);
      if (!proc) continue;
      const kind = processCliKind(proc);
      if (kind) subtreeKinds.push({ kind, proc });
    }
    if (subtreeKinds.some(({ kind }) => kind === 'gjc')) continue;

    // Bun-launched Oh My Pi and node-launched omo keep the shell as tmux's pane
    // PID and the CLI as its direct child, while pane_current_command reads only
    // `bun` or `node`. Accept that exact shell-owned wrapper shape; a worker
    // nested under an app process must remain an unclassified terminal row.
    const paneIsInteractiveShell = isInteractiveShellProcess(procByPid.get(pane.pid));
    for (const wrappedKind of ['omp', 'omo'] as const) {
      const directShellPi = paneIsInteractiveShell
        && subtreeKinds.some(({ kind, proc }) => kind === wrappedKind && proc.ppid === pane.pid);
      if (directShellPi) {
        kinds.add(wrappedKind);
      }
    }
    // The documented Cursor `agent` launcher execs a Node process, so tmux may
    // report `agent`, `node`, or `MainThread` while the shell-owned child argv
    // carries the Cursor installation path that proves its identity.
    const directShellCursor = isInteractiveShellProcess(procByPid.get(pane.pid))
      && ['agent', 'node', 'mainthread'].includes(pane.command.toLowerCase())
      && subtreeKinds.some(({ kind, proc }) => kind === 'cursor' && proc.ppid === pane.pid);
    if (directShellCursor) {
      kinds.add('cursor');
    }

    const paneRootProcess = procByPid.get(pane.pid);
    const foregroundKind = processCliKind({ comm: pane.command })
      ?? (paneRootProcess ? processCliKind(paneRootProcess) : null);
    if (foregroundKind) {
      kinds.add(foregroundKind);
    } else if (
      pane.command.toLowerCase() === 'node'
      && subtreeKinds.some(({ kind }) => kind === 'codex')
    ) {
      kinds.add('codex');
    }

    const acceptedKinds = new Set<ExternalLocalCliKind>([
      ...taggedKinds,
      ...[...kinds].filter(
        (kind): kind is ExternalLocalCliKind => kind !== 'gjc' && kind !== 'ssh',
      ),
    ]);
    for (const { kind, proc } of subtreeKinds) {
      if (kind === 'gjc' || kind === 'ssh' || !acceptedKinds.has(kind)) continue;
      const providerSessionId = extractExternalResumeSessionId(kind, proc.args);
      if (!providerSessionId) continue;
      const ids = sessionIds.get(kind) ?? new Set<string>();
      ids.add(providerSessionId);
      sessionIds.set(kind, ids);
    }

    const kind = priority.find((candidate) => (
      taggedKinds.has(candidate as ExternalLocalCliKind) || kinds.has(candidate)
    )) ?? 'shell';
    const ids = kind === 'ssh' || kind === 'shell' ? [] : [...(sessionIds.get(kind) ?? [])];
    const agentPid = subtreeKinds.find((entry) => entry.kind === kind)?.proc.pid;
    result.push({
      tmuxName: pane.name,
      tmux: pane.tmux,
      kind,
      ...(ids.length === 1 ? { providerSessionId: ids[0] } : {}),
      ...(pane.cwd ? { cwd: pane.cwd } : {}),
      ...(agentPid !== undefined ? { agentPid } : {}),
    });
  }
  return result.sort((a, b) => (
    a.tmuxName.localeCompare(b.tmuxName)
    || a.tmux.windowId.localeCompare(b.tmux.windowId)
    || a.tmux.paneId.localeCompare(b.tmux.paneId)
  ));
}

export type ExternalCliSessionCommandRunner = (
  command: string,
  cmdArgs: string[],
  timeoutMs?: number,
) => Promise<string>;

export function runCommand(command: string, cmdArgs: string[], timeoutMs = 4000): Promise<string> {
  recordHostCommand(command, cmdArgs);
  return new Promise((resolve, reject) => {
    const child = spawn(command, cmdArgs, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`${command} timed out`));
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', (error) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
        }
      }
    });
  });
}

export function descendants(rootPid: number, children: ReadonlyMap<number, number[]>): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0 && seen.size < 4096) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return result;
}

export function selectPrimaryCodexProcessPid(codexPids: readonly number[]): number | null {
  // `descendants` is breadth-first, so the first match is the CLI process that
  // owns any native Codex child. Current npm installs commonly expose both.
  return codexPids[0] ?? null;
}
