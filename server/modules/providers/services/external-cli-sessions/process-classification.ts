import { spawn } from 'node:child_process';

import { isCursorCliProcess } from '@/modules/providers/list/cursor/cursor-cli-command.js';

import { recordHostCommand } from '../host-command-metrics.service.js';
import { tmuxPaneIdentityKey } from '../../../../../shared/tmux.js';

import type { ExternalCliKind, ExternalCliSession, ExternalLocalCliKind, ExternalPane, ProcessTreeEntry, ExternalSessionBinding } from './contracts-and-resume.js';
import { CLAUDE_SESSION_ID_RE, CODEX_THREAD_ID_RE, extractExternalResumeSessionId } from './contracts-and-resume.js';
import type { CustomProcessEvidence, CustomTerminalAgentDetectionOptions } from './custom-terminal-agents.js';
import { couldMatchCustomCommand, isCustomTerminalShellInvocation, matchesCustomTerminalAgent, readCustomProcessEvidence, readCustomTerminalAgents } from './custom-terminal-agents.js';


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
  if (executable('gjc')) return 'gjc';
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
    // A single id came either from the ChatMux spawn tag on the pane or from
    // the agent's own argv; both are process-bound, but only the former was
    // written by us.
    const binding: ExternalSessionBinding = (pane.taggedKind === kind && pane.taggedSessionId === ids[0])
      || (kind === 'codex' && pane.codexThreadId === ids[0])
      ? 'tagged'
      : 'observed';
    result.push({
      tmuxName: pane.name,
      tmux: pane.tmux,
      kind,
      ...(ids.length === 1 ? { providerSessionId: ids[0], binding } : {}),
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

/** Optional exact-argv evidence enriches only existing shell rows, never providers. */
export async function classifyCustomTerminalSessions(
  args: { sessions: ExternalCliSession[]; panes: ExternalPane[]; procs: ProcessTreeEntry[] },
  options: CustomTerminalAgentDetectionOptions = {},
): Promise<ExternalCliSession[]> {
  const rules = readCustomTerminalAgents(options.env);
  if (!rules.length || (options.platform ?? process.platform) !== 'linux') return args.sessions;
  const procByPid = new Map(args.procs.map((proc) => [proc.pid, proc]));
  // A duplicate PID makes the snapshot ambiguous; never pick whichever entry won.
  if (procByPid.size !== args.procs.length) return args.sessions;
  const children = new Map<number, ProcessTreeEntry[]>();
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid) ?? [];
    siblings.push(proc);
    children.set(proc.ppid, siblings);
  }
  const candidates = new Map<ExternalCliSession, { root: ProcessTreeEntry; procs: ProcessTreeEntry[]; pane: ExternalPane }>();
  const panesByIdentity = new Map<string, ExternalPane[]>();
  for (const pane of args.panes) {
    const key = tmuxPaneIdentityKey(pane.tmux);
    panesByIdentity.set(key, [...(panesByIdentity.get(key) ?? []), pane]);
  }
  const readPids = new Set<number>();
  for (const session of args.sessions) {
    if (session.kind !== 'shell') continue;
    const panes = panesByIdentity.get(tmuxPaneIdentityKey(session.tmux)) ?? [];
    if (panes.length !== 1) continue;
    const pane = panes[0];
    const root = procByPid.get(pane.pid);
    if (!root) continue;
    const owned = isInteractiveShellProcess(root) ? children.get(root.pid) ?? [] : [root];
    // Pipelines and multiple shell jobs have no unique process owner in this
    // snapshot. Even an unreadable/unconfigured sibling must not be ignored.
    if (owned.length !== 1) continue;
    const possible = owned
      .filter((proc) => !processCliKind(proc) && couldMatchCustomCommand(proc.comm, rules));
    if (!possible.length) continue;
    candidates.set(session, { root, procs: possible, pane });
    readPids.add(root.pid);
    for (const proc of possible) readPids.add(proc.pid);
    if (readPids.size > 128) return args.sessions;
  }
  const evidence = new Map<number, CustomProcessEvidence | null>();
  const pending = [...readPids];
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
    for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
      evidence.set(pid, await readCustomProcessEvidence(pid, options.readProcessRecord));
    }
  }));
  return args.sessions.map((session) => {
    const candidate = candidates.get(session);
    if (!candidate) return session;
    const root = evidence.get(candidate.root.pid);
    if (!root || root.ppid !== candidate.root.ppid) return session;
    const matches = candidate.procs.filter((proc) => {
      const observed = evidence.get(proc.pid);
      return observed && observed.ppid === proc.ppid
        && observed.pgid === observed.foregroundPgid
        && observed.tty === root.tty && observed.sid === root.sid
        && observed.foregroundPgid === root.foregroundPgid
        && (proc.pid === root.pid || observed.ppid === root.pid)
        && (proc.pid === root.pid || isCustomTerminalShellInvocation(candidate.root.comm, root.argv))
        && (proc.pid === root.pid || (root.ppid !== proc.pid && root.startTicks <= observed.startTicks))
        && [proc.comm, observed.argv[0].split('/').at(-1)].includes(candidate.pane.command)
        && couldMatchCustomCommand(proc.comm, [{ command: observed.argv[0], argv: [] }])
        && matchesCustomTerminalAgent(observed.argv, rules);
    });
    if (matches.length !== 1) return session;
    return { ...session, agentPid: matches[0].pid };
  });
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
