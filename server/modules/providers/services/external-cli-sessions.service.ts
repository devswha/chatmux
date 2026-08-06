import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import {
  CURSOR_CLI_COMMAND_CANDIDATES,
  isCursorCliProcess,
} from '@/modules/providers/list/cursor/cursor-cli-command.js';

import {
  tmuxPaneIdentityKey,
  type TmuxPaneIdentity,
} from '../../../../shared/tmux.js';
import type { ProviderConnectionIssue } from '../../../../shared/provider-connection.js';

import { recordHostCommand } from './host-command-metrics.service.js';
import {
  hostDiscoverySnapshotSource,
  parseHostDiscoveryPanes,
  parseHostDiscoveryProcesses,
  type HostDiscoverySnapshot,
} from './host-discovery-snapshot.service.js';
import { validateLocalAgentContext } from './local-agent-context.service.js';

/**
 * Discovers every tmux pane. GJC keeps its dedicated live lane; Claude,
 * Codex, Cursor, OpenCode, and Oh My Pi are surfaced with native transcript
 * ids when they can be proven. SSH and unclassified shell panes stay
 * terminal-only because no local agent generation can be established.
 */

const TMUX_FIELD_SEP = '\t';
const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_RESUME_THREAD_RE = /(?:^|\s)resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i;
const CLAUDE_RESUME_SESSION_RE = /(?:^|\s)--resume(?:=|\s+)([0-9a-f]{8}-[0-9a-f-]{27,})(?=\s|$)/i;
const CURSOR_RESUME_SESSION_RE = /(?:^|\s)(?:--resume|resume)(?:=|\s+)([A-Za-z0-9_-]{8,128})(?=\s|$)/;
const OPENCODE_SESSION_RE = /(?:^|\s)--session(?:=|\s+)([A-Za-z0-9_-]{8,128})(?=\s|$)/;
const OMP_RESUME_SESSION_RE = /(?:^|\s)(?:--resume|-r)(?:=|\s+)([A-Za-z0-9_-]{8,128})(?=\s|$)/;
const TRANSCRIPT_FILE_SESSION_ID_RE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const CODEX_ROLLOUT_FILE_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const MAX_RUNTIME_DESCRIPTORS = 2_048;

export type ExternalLocalCliKind = 'claude' | 'codex' | 'cursor' | 'opencode' | 'omp';
export type ExternalCliKind = ExternalLocalCliKind | 'ssh' | 'shell';
export type ExternalCliSession = {
  tmuxName: string;
  tmux: TmuxPaneIdentity;
  kind: ExternalCliKind;
  providerSessionId?: string;
  cwd?: string;
  agentPid?: number;
  startedAtMs?: number;
  connectionIssue?: ProviderConnectionIssue;
};
export type ExternalCliSessionsDetailedResult = {
  ok: boolean;
  sessions: ExternalCliSession[];
};

export type ExternalCliSessionInferenceRetryBackoff = {
  attemptableSessions(sessions: ExternalCliSession[]): ExternalCliSession[];
  recordResults(
    sessions: ExternalCliSession[],
    attemptedSessions: Iterable<ExternalCliSession>,
  ): void;
};

export type ExternalCliSessionInferenceRetryBackoffOptions = {
  now?: () => number;
  retryBackoffMs?: number;
};

function isUnresolvedExternalLocalCliSession(
  session: ExternalCliSession,
): session is ExternalCliSession & { kind: ExternalLocalCliKind } {
  return session.kind !== 'ssh'
    && session.kind !== 'shell'
    && !session.providerSessionId
    && !session.connectionIssue;
}

function externalSessionInferenceKey(session: ExternalCliSession): string {
  return [
    tmuxPaneIdentityKey(session.tmux),
    session.kind,
    session.agentPid ?? '',
    session.startedAtMs ?? '',
  ].join('\0');
}

/**
 * Backs off failed native-id inference per fixed pane/process generation.
 * Resolved, removed, and restarted sessions discard their prior retry state.
 */
export function createExternalCliSessionInferenceRetryBackoff(
  options: ExternalCliSessionInferenceRetryBackoffOptions = {},
): ExternalCliSessionInferenceRetryBackoff {
  const now = options.now ?? Date.now;
  const requestedRetryBackoffMs = options.retryBackoffMs;
  const retryBackoffMs = typeof requestedRetryBackoffMs === 'number'
    && Number.isFinite(requestedRetryBackoffMs)
    && requestedRetryBackoffMs >= 0
    ? requestedRetryBackoffMs
    : 30_000;
  const retryAtMsByKey = new Map<string, number>();

  const reconcile = (sessions: ExternalCliSession[]): void => {
    const activeUnresolvedKeys = new Set<string>();
    for (const session of sessions) {
      if (session.kind === 'ssh' || session.kind === 'shell') continue;
      const key = externalSessionInferenceKey(session);
      if (session.providerSessionId) {
        retryAtMsByKey.delete(key);
      } else {
        activeUnresolvedKeys.add(key);
      }
    }
    for (const key of retryAtMsByKey.keys()) {
      if (!activeUnresolvedKeys.has(key)) retryAtMsByKey.delete(key);
    }
  };

  return {
    attemptableSessions(sessions) {
      reconcile(sessions);
      const currentMs = now();
      return sessions.filter((session) => {
        if (!isUnresolvedExternalLocalCliSession(session)) return false;
        return (retryAtMsByKey.get(externalSessionInferenceKey(session)) ?? 0) <= currentMs;
      });
    },
    recordResults(sessions, attemptedSessions) {
      reconcile(sessions);
      const attemptedKeys = new Set(
        [...attemptedSessions].map((session) => externalSessionInferenceKey(session)),
      );
      const retryAtMs = now() + retryBackoffMs;
      for (const session of sessions) {
        if (!isUnresolvedExternalLocalCliSession(session)) continue;
        const key = externalSessionInferenceKey(session);
        if (attemptedKeys.has(key)) retryAtMsByKey.set(key, retryAtMs);
      }
    },
  };
}

export type ExternalPane = {
  name: string;
  tmux: TmuxPaneIdentity;
  pid: number;
  command: string;
  codexThreadId?: string;
  cwd?: string;
  taggedKind?: ExternalLocalCliKind;
  taggedSessionId?: string;
};

export type ProcessTreeEntry = {
  pid: number;
  ppid: number;
  comm: string;
  args?: string;
};

type FreshCodexProcess = { targetKey: string; cwd: string; startedAtMs: number };
type FreshCodexThread = { id: string; cwd: string; createdAtMs: number };
export type OpenCodexThread = { id: string; modifiedAtMs: number };
export type CodexThreadObservationState = {
  processKey: string;
  selectedId: string | null;
  modifiedAtById: Map<string, number>;
};
type FreshIndexedProviderSession = {
  id: string;
  kind: ExternalLocalCliKind;
  cwd: string;
  createdAtMs: number;
  updatedAtMs?: number;
  diskDiscovered: boolean;
};


/** Extracts the native Codex thread id from `codex resume <uuid>` argv. */
export function extractCodexResumeThreadId(processArgs: string | undefined): string | null {
  return processArgs?.match(CODEX_RESUME_THREAD_RE)?.[1] ?? null;
}

export function extractExternalResumeSessionId(
  kind: ExternalLocalCliKind,
  processArgs: string | undefined,
): string | null {
  if (!processArgs) return null;
  if (kind === 'claude') return processArgs.match(CLAUDE_RESUME_SESSION_RE)?.[1] ?? null;
  if (kind === 'codex') return extractCodexResumeThreadId(processArgs);
  if (kind === 'cursor') return processArgs.match(CURSOR_RESUME_SESSION_RE)?.[1] ?? null;
  if (kind === 'opencode') return processArgs.match(OPENCODE_SESSION_RE)?.[1] ?? null;
  if (kind === 'omp') return processArgs.match(OMP_RESUME_SESSION_RE)?.[1] ?? null;
  return null;
}

/** Assigns each newly-created native thread to the closest preceding tmux Codex process. */
export function assignFreshCodexThreadIds(
  processes: FreshCodexProcess[],
  threads: FreshCodexThread[],
  windowMs = 10 * 60 * 1000,
): Map<string, string> {
  const assigned = new Map<string, string>();
  for (const thread of [...threads].sort((a, b) => a.createdAtMs - b.createdAtMs)) {
    const eligible = processes.filter((process) => (
      !assigned.has(process.targetKey)
      && process.cwd === thread.cwd
      && thread.createdAtMs >= process.startedAtMs - 5_000
      && thread.createdAtMs <= process.startedAtMs + windowMs
    ));
    const preceding = eligible
      .filter((process) => process.startedAtMs <= thread.createdAtMs)
      .sort((a, b) => b.startedAtMs - a.startedAtMs);
    const owner = preceding[0]
      ?? eligible.sort((a, b) => a.startedAtMs - b.startedAtMs)[0];
    if (owner) {
      assigned.set(owner.targetKey, thread.id);
    }
  }
  return assigned;
}

export function extractCodexThreadIdFromRolloutPath(
  filePath: string,
  sessionsRoot: string,
): string | null {
  const normalizedPath = filePath.endsWith(' (deleted)')
    ? filePath.slice(0, -' (deleted)'.length)
    : filePath;
  const rel = relative(sessionsRoot, normalizedPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return CODEX_ROLLOUT_FILE_RE.exec(normalizedPath.split(sep).at(-1) ?? '')?.[1] ?? null;
}

export function selectMostRecentCodexThreadId(
  threads: OpenCodexThread[],
): string | null {
  const modifiedAtById = new Map<string, number>();
  for (const thread of threads) {
    modifiedAtById.set(
      thread.id,
      Math.max(
        modifiedAtById.get(thread.id) ?? Number.NEGATIVE_INFINITY,
        thread.modifiedAtMs,
      ),
    );
  }
  const ordered = [...modifiedAtById]
    .map(([id, modifiedAtMs]) => ({ id, modifiedAtMs }))
    .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  if (ordered.length === 0) return null;
  if (ordered.length > 1 && ordered[0].modifiedAtMs === ordered[1].modifiedAtMs) {
    return null;
  }
  return ordered[0].id;
}

/**
 * Follows Codex when an existing TUI opens a new conversation or resumes one
 * of several rollout files that the process still holds open.
 */
export function selectObservedCodexThread(args: {
  processKey: string;
  threads: OpenCodexThread[];
  previous?: CodexThreadObservationState;
  launchThreadId?: string;
}): CodexThreadObservationState {
  const modifiedAtById = new Map<string, number>();
  for (const thread of args.threads) {
    modifiedAtById.set(
      thread.id,
      Math.max(
        modifiedAtById.get(thread.id) ?? Number.NEGATIVE_INFINITY,
        thread.modifiedAtMs,
      ),
    );
  }

  const previous = args.previous?.processKey === args.processKey
    ? args.previous
    : undefined;
  let selectedId: string | null = null;

  if (modifiedAtById.size === 1) {
    selectedId = modifiedAtById.keys().next().value ?? null;
  } else if (previous) {
    const newlyOpened = [...modifiedAtById.keys()].filter(
      (id) => !previous.modifiedAtById.has(id),
    );
    if (newlyOpened.length === 1) {
      selectedId = newlyOpened[0];
    } else {
      const newlyModified = [...modifiedAtById].filter(([id, modifiedAtMs]) => (
        previous.modifiedAtById.has(id)
        && modifiedAtMs > (previous.modifiedAtById.get(id) ?? Number.NEGATIVE_INFINITY)
      ));
      if (newlyModified.length === 1) {
        selectedId = newlyModified[0][0];
      } else if (previous.selectedId && modifiedAtById.has(previous.selectedId)) {
        selectedId = previous.selectedId;
      }
    }
  }

  selectedId ??= selectMostRecentCodexThreadId(
    [...modifiedAtById].map(([id, modifiedAtMs]) => ({ id, modifiedAtMs })),
  );
  if (!selectedId && args.launchThreadId && modifiedAtById.has(args.launchThreadId)) {
    selectedId = args.launchThreadId;
  }
  return { processKey: args.processKey, selectedId, modifiedAtById };
}

export function isCodexMainThreadMetadata(metadata: {
  source?: unknown;
  thread_source?: unknown;
  agent_role?: unknown;
} | undefined): boolean {
  if (!metadata) return true;
  return metadata.thread_source !== 'subagent'
    && metadata.agent_role == null
    && (
      typeof metadata.source !== 'string'
      || !metadata.source.trimStart().startsWith('{"subagent"')
    );
}

/**
 * Binds fresh disk-discovered transcripts only when each process has one
 * unambiguous candidate. Newest processes claim first so two sequential
 * launches in one cwd still pair one-to-one.
 */
export function assignFreshIndexedProviderSessionIds(
  processes: ExternalCliSession[],
  sessions: FreshIndexedProviderSession[],
  windowMs = 10 * 60 * 1000,
  nowMs = Date.now(),
): Map<string, string> {
  const assigned = new Map<string, string>();
  const claimed = new Set<string>();
  const orderedProcesses = [...processes].sort(
    (a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0),
  );

  for (const process of orderedProcesses) {
    if (
      process.kind === 'ssh'
      || typeof process.cwd !== 'string'
      || typeof process.startedAtMs !== 'number'
    ) {
      continue;
    }
    const startedAtMs = process.startedAtMs;
    const candidates = sessions.filter((session) => (
      session.diskDiscovered
      && session.kind === process.kind
      && session.cwd === process.cwd
      && !claimed.has(`${session.kind}:${session.id}`)
      && session.createdAtMs >= startedAtMs - 1_000
      && session.createdAtMs <= startedAtMs + windowMs
      && session.createdAtMs <= nowMs + 5_000
    ));
    if (candidates.length !== 1) {
      continue;
    }
    const candidate = candidates[0];
    assigned.set(tmuxPaneIdentityKey(process.tmux), candidate.id);
    claimed.add(`${candidate.kind}:${candidate.id}`);
  }
  return assigned;
}

/**
 * A long-running TUI can create its first transcript well after the fresh
 * launch window. Bind it only when the full live process set has one process
 * for the exact provider + cwd; direct and fresh peers must still block inference.
 */
export function assignUniqueIndexedProviderSessionIds(
  processes: ExternalCliSession[],
  sessions: FreshIndexedProviderSession[],
  alreadyAssigned: ReadonlyMap<string, string>,
  nowMs = Date.now(),
  allProcesses: readonly ExternalCliSession[] = processes,
): Map<string, string> {
  const assigned = new Map(alreadyAssigned);
  const claimed = new Set(assigned.values());

  for (const process of processes) {
    const targetKey = tmuxPaneIdentityKey(process.tmux);
    if (assigned.has(targetKey)
      || process.kind === 'ssh'
      || typeof process.cwd !== 'string'
      || typeof process.startedAtMs !== 'number') {
      continue;
    }
    const startedAtMs = process.startedAtMs;
    const peers = allProcesses.filter((candidate) => (
      candidate.kind === process.kind
      && candidate.cwd === process.cwd
    ));
    if (peers.length !== 1) {
      continue;
    }
    const candidates = sessions.filter((session) => (
      session.diskDiscovered
      && session.kind === process.kind
      && session.cwd === process.cwd
      && !claimed.has(session.id)
      && session.createdAtMs >= startedAtMs - 1_000
      && session.createdAtMs <= nowMs + 5_000
    ));
    let candidate: FreshIndexedProviderSession | undefined;
    if (candidates.length === 1) {
      [candidate] = candidates;
    } else if (
      process.kind === 'opencode'
      && candidates.length > 1
      && candidates.every((session) => (
        typeof session.updatedAtMs === 'number'
        && Number.isFinite(session.updatedAtMs)
        && session.updatedAtMs >= session.createdAtMs
        && session.updatedAtMs <= nowMs + 5_000
      ))
    ) {
      const latestUpdatedAtMs = Math.max(...candidates.map((session) => session.updatedAtMs ?? Number.NEGATIVE_INFINITY));
      const latestCandidates = candidates.filter((session) => session.updatedAtMs === latestUpdatedAtMs);
      if (latestCandidates.length === 1) {
        [candidate] = latestCandidates;
      }
    }
    if (!candidate) {
      continue;
    }
    assigned.set(targetKey, candidate.id);
    claimed.add(candidate.id);
  }
  return assigned;
}

/** Parses pane identity and ChatMux's optional provider/session user-options. */
export function parseExternalPanes(output: string): ExternalPane[] {
  return parseHostDiscoveryPanes(output).map((pane) => ({
    name: pane.name,
    tmux: pane.tmux,
    pid: pane.pid,
    command: pane.command,
    ...(pane.codexThreadId ? { codexThreadId: pane.codexThreadId } : {}),
    ...(pane.cwd ? { cwd: pane.cwd } : {}),
    ...(pane.taggedKind && ['claude', 'codex', 'cursor', 'opencode', 'omp'].includes(pane.taggedKind)
      ? { taggedKind: pane.taggedKind as ExternalLocalCliKind }
      : {}),
    ...(pane.taggedSessionId ? { taggedSessionId: pane.taggedSessionId } : {}),
  }));
}

/** Parses `ps -eo pid,ppid,comm[,args]` output (header tolerated). */
export function parsePsTree(output: string): ProcessTreeEntry[] {
  return parseHostDiscoveryProcesses(output);
}

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

function processCliKind(proc: Pick<ProcessTreeEntry, 'comm' | 'args'>): ExternalLocalCliKind | 'gjc' | 'ssh' | null {
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
  if (executable('ssh')) return 'ssh';
  return null;
}

function isInteractiveShellProcess(proc: ProcessTreeEntry | undefined): boolean {
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

  const priority: Array<Exclude<ExternalCliKind, 'shell'>> = ['claude', 'codex', 'cursor', 'opencode', 'omp', 'ssh'];
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

    // Bun-launched Oh My Pi keeps the shell as tmux's pane PID and the `omp`
    // executable as its direct child, while pane_current_command is only `bun`.
    // Accept that exact shell-owned wrapper shape; an OMP worker nested under
    // an app process must remain an unclassified terminal row.
    const directShellOmp = isInteractiveShellProcess(procByPid.get(pane.pid))
      && subtreeKinds.some(({ kind, proc }) => kind === 'omp' && proc.ppid === pane.pid);
    if (directShellOmp) {
      kinds.add('omp');
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

function runCommand(command: string, cmdArgs: string[], timeoutMs = 4000): Promise<string> {
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

export function parseProcessStartTime(output: string): number | null {
  const parsed = Date.parse(output.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

async function processStartMs(pid: number): Promise<number | null> {
  try {
    return (await stat(`/proc/${pid}`)).mtimeMs;
  } catch {
    try {
      return parseProcessStartTime(await runCommand('ps', [
        '-p', String(pid), '-o', 'lstart=',
      ]));
    } catch {
      return null;
    }
  }
}

function descendants(rootPid: number, children: ReadonlyMap<number, number[]>): number[] {
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

function readFreshCodexThreads(minCreatedAtMs: number): FreshCodexThread[] {
  let db: Database.Database | null = null;
  try {
    db = new Database(join(homedir(), '.codex', 'state_5.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    return db.prepare(`
      SELECT id, cwd, COALESCE(created_at_ms, created_at * 1000) AS createdAtMs
      FROM threads
      WHERE source = 'cli'
        AND thread_source = 'user'
        AND COALESCE(created_at_ms, created_at * 1000) >= ?
      ORDER BY COALESCE(created_at_ms, created_at * 1000) ASC
    `).all(minCreatedAtMs - 5_000) as FreshCodexThread[];
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

async function inferFreshCodexThreadIds(args: {
  sessions: ExternalCliSession[];
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
}): Promise<Map<string, string>> {
  const unresolvedTargets = new Set(
    args.sessions
      .filter((session) => session.kind === 'codex' && !session.providerSessionId)
      .map((session) => tmuxPaneIdentityKey(session.tmux)),
  );
  if (unresolvedTargets.size === 0) return new Map();

  const children = new Map<number, number[]>();
  const procByPid = new Map(args.procs.map((proc) => [proc.pid, proc]));
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid) ?? [];
    siblings.push(proc.pid);
    children.set(proc.ppid, siblings);
  }

  const processes: FreshCodexProcess[] = [];
  for (const pane of args.panes) {
    const targetKey = tmuxPaneIdentityKey(pane.tmux);
    if (!unresolvedTargets.has(targetKey) || !pane.cwd) continue;
    const codexPids = descendants(pane.pid, children).filter((pid) => {
      const proc = procByPid.get(pid);
      return proc ? isCodexRuntimeProcess(proc) : false;
    });
    const primaryCodexPid = selectPrimaryCodexProcessPid(codexPids);
    if (primaryCodexPid === null) continue;
    const startedAtMs = await processStartMs(primaryCodexPid);
    if (startedAtMs !== null) {
      processes.push({ targetKey, cwd: pane.cwd, startedAtMs });
    }
  }
  if (processes.length === 0) return new Map();

  const threads = readFreshCodexThreads(Math.min(...processes.map((process) => process.startedAtMs)));
  return assignFreshCodexThreadIds(processes, threads);
}

async function readOpenCodexThreads(
  pid: number,
  sessionsRoot: string,
): Promise<OpenCodexThread[]> {
  const threads = new Map<string, OpenCodexThread>();
  const fdRoot = `/proc/${pid}/fd`;
  const descriptors = await readdir(fdRoot).catch(() => []);
  const targets = await Promise.all(
    descriptors.slice(0, MAX_RUNTIME_DESCRIPTORS).map(
      (descriptor) => readlink(join(fdRoot, descriptor)).catch(() => null),
    ),
  );
  for (const target of targets) {
    if (!target) continue;
    const threadId = extractCodexThreadIdFromRolloutPath(target, sessionsRoot);
    if (!threadId) continue;
    const normalizedPath = target.endsWith(' (deleted)')
      ? target.slice(0, -' (deleted)'.length)
      : target;
    const modifiedAtMs = await stat(normalizedPath).then(
      (metadata) => metadata.mtimeMs,
      () => Number.NEGATIVE_INFINITY,
    );
    const existing = threads.get(threadId);
    if (!existing || modifiedAtMs > existing.modifiedAtMs) {
      threads.set(threadId, { id: threadId, modifiedAtMs });
    }
  }
  if (threads.size === 0) return [];

  let db: Database.Database | null = null;
  try {
    db = new Database(join(homedir(), '.codex', 'state_5.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    const readMetadata = db.prepare(`
      SELECT source, thread_source, agent_role
      FROM threads
      WHERE id = ?
      LIMIT 1
    `);
    return [...threads.values()].filter((thread) => (
      isCodexMainThreadMetadata(readMetadata.get(thread.id) as {
        source?: unknown;
        thread_source?: unknown;
        agent_role?: unknown;
      } | undefined)
    ));
  } catch {
    return [...threads.values()];
  } finally {
    db?.close();
  }
}

const observedCodexThreadsByTarget = new Map<string, CodexThreadObservationState>();

/**
 * Reads the rollout files held open by every live Codex process. This is
 * independent of process age and continues to follow in-TUI `/new` and
 * `/resume` transitions.
 */
async function inferOpenCodexThreadIds(args: {
  sessions: ExternalCliSession[];
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
}): Promise<Map<string, string>> {
  const codexSessions = new Map(
    args.sessions
      .filter((session) => session.kind === 'codex')
      .map((session) => [tmuxPaneIdentityKey(session.tmux), session]),
  );
  if (codexSessions.size === 0) {
    observedCodexThreadsByTarget.clear();
    return new Map();
  }

  const sessionsRoot = await realpath(join(homedir(), '.codex', 'sessions')).catch(() => null);
  if (!sessionsRoot) return new Map();

  const children = new Map<number, number[]>();
  const procByPid = new Map(args.procs.map((proc) => [proc.pid, proc]));
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid) ?? [];
    siblings.push(proc.pid);
    children.set(proc.ppid, siblings);
  }

  const observations = new Map<string, {
    pids: Set<number>;
    threads: OpenCodexThread[];
  }>();
  for (const pane of args.panes) {
    const targetKey = tmuxPaneIdentityKey(pane.tmux);
    if (!codexSessions.has(targetKey)) continue;
    const codexPids = descendants(pane.pid, children).filter((pid) => {
      const proc = procByPid.get(pid);
      return proc ? isCodexRuntimeProcess(proc) : false;
    });
    for (const pid of codexPids) {
      const openThreads = await readOpenCodexThreads(pid, sessionsRoot);
      if (openThreads.length === 0) continue;
      const observation = observations.get(targetKey) ?? {
        pids: new Set<number>(),
        threads: [],
      };
      observation.pids.add(pid);
      observation.threads.push(...openThreads);
      observations.set(targetKey, observation);
    }
  }

  const resolved = new Map<string, string>();
  for (const [targetKey, observation] of observations) {
    const session = codexSessions.get(targetKey)!;
    const launchThreadId = session.providerSessionId
      && CODEX_THREAD_ID_RE.test(session.providerSessionId)
      ? session.providerSessionId
      : undefined;
    const nextState = selectObservedCodexThread({
      processKey: [
        externalSessionInferenceKey(session),
        ...[...observation.pids].sort((a, b) => a - b),
      ].join('\0'),
      threads: observation.threads,
      previous: observedCodexThreadsByTarget.get(targetKey),
      launchThreadId,
    });
    observedCodexThreadsByTarget.set(targetKey, nextState);
    if (nextState.selectedId) resolved.set(targetKey, nextState.selectedId);
  }
  for (const targetKey of observedCodexThreadsByTarget.keys()) {
    if (!observations.has(targetKey)) observedCodexThreadsByTarget.delete(targetKey);
  }
  return resolved;
}

async function inferClaudeSessionIds(args: {
  sessions: ExternalCliSession[];
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
}): Promise<Map<string, string>> {
  const claudeTargets = new Set(
    args.sessions
      .filter((session) => session.kind === 'claude')
      .map((session) => tmuxPaneIdentityKey(session.tmux)),
  );
  if (claudeTargets.size === 0) return new Map();

  const children = new Map<number, number[]>();
  const procByPid = new Map(args.procs.map((proc) => [proc.pid, proc]));
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid) ?? [];
    siblings.push(proc.pid);
    children.set(proc.ppid, siblings);
  }

  const candidates = new Map<string, Map<number, string>>();
  for (const pane of args.panes) {
    const targetKey = tmuxPaneIdentityKey(pane.tmux);
    if (!claudeTargets.has(targetKey) || !pane.cwd) continue;
    for (const pid of descendants(pane.pid, children)) {
      const proc = procByPid.get(pid);
      if (!proc || !isClaudeRuntimeProcess(proc)) continue;
      const byPid = candidates.get(targetKey) ?? new Map<number, string>();
      byPid.set(pid, pane.cwd);
      candidates.set(targetKey, byPid);
    }
  }

  const resolved = new Map<string, string>();
  await Promise.all([...candidates].map(async ([targetKey, byPid]) => {
    if (byPid.size !== 1) return;
    const [[pid, paneCwd]] = [...byPid];
    try {
      const receipt = parseClaudeRuntimeSession(
        JSON.parse(await readFile(join(homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8')),
        pid,
      );
      if (!receipt) return;
      const [realPaneCwd, realReceiptCwd] = await Promise.all([
        realpath(paneCwd),
        realpath(receipt.cwd),
      ]);
      if (realPaneCwd === realReceiptCwd) {
        resolved.set(targetKey, receipt.sessionId);
      }
    } catch {
      // The Claude runtime receipt is best-effort and may disappear on exit.
    }
  }));
  return resolved;
}

export function extractContainedTranscriptSessionId(
  sessionsRoot: string,
  transcriptPath: string,
): string | null {
  const rel = relative(sessionsRoot, transcriptPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return TRANSCRIPT_FILE_SESSION_ID_RE.exec(rel)?.[1] ?? null;
}

/**
 * Oh My Pi keeps its active JSONL transcript open for the lifetime of the TUI.
 * Resolve that file through /proc so an already-running, untagged tmux pane can
 * attach to structured history without relying on filesystem creation times.
 */
async function inferOpenOmpSessionIds(
  sessions: ExternalCliSession[],
): Promise<Map<string, string>> {
  const targets = sessions.filter((session) => (
    session.kind === 'omp'
    && session.agentPid !== undefined
  ));
  if (targets.length === 0) return new Map();

  const sessionsRoot = await realpath(join(homedir(), '.omp', 'agent', 'sessions')).catch(() => null);
  if (!sessionsRoot) return new Map();

  const resolved = new Map<string, string>();
  await Promise.all(targets.map(async (session) => {
    const fdRoot = `/proc/${session.agentPid}/fd`;
    const descriptors = await readdir(fdRoot).catch(() => []);
    const transcriptById = new Map<string, string>();
    await Promise.all(descriptors.slice(0, MAX_RUNTIME_DESCRIPTORS).map(async (descriptor) => {
      const transcriptPath = await realpath(join(fdRoot, descriptor)).catch(() => null);
      if (!transcriptPath) return;
      const sessionId = extractContainedTranscriptSessionId(sessionsRoot, transcriptPath);
      if (sessionId) transcriptById.set(sessionId, transcriptPath);
    }));
    if (transcriptById.size !== 1) return;

    const [[sessionId, transcriptPath]] = [...transcriptById];
    if (!sessionsDb.getSessionByProviderSessionId('omp', sessionId)) {
      await providerRegistry.resolveProvider('omp').sessionSynchronizer
        .synchronizeFile(transcriptPath)
        .catch(() => undefined);
    }
    resolved.set(tmuxPaneIdentityKey(session.tmux), sessionId);
  }));
  return resolved;
}

async function addExternalRuntimeMetadata(args: {
  sessions: ExternalCliSession[];
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
}): Promise<ExternalCliSession[]> {
  return Promise.all(args.sessions.map(async (session) => {
    if (session.kind === 'ssh' || session.agentPid === undefined) return session;
    const startedAtMs = await processStartMs(session.agentPid);
    const connectionIssue = await validateLocalAgentContext({
      pid: session.agentPid,
      startedAtMs,
      socketPath: session.tmux.socketPath,
    });
    if (connectionIssue) {
      const { providerSessionId: _providerSessionId, ...unbound } = session;
      return {
        ...unbound,
        ...(startedAtMs === null ? {} : { startedAtMs }),
        connectionIssue,
      };
    }
    return startedAtMs === null ? session : { ...session, startedAtMs };
  }));
}

async function inferIndexedProviderSessionIds(
  sessions: ExternalCliSession[],
  attemptableTargetKeys: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const unresolved = sessions.filter((session): session is ExternalCliSession & {
    kind: 'cursor' | 'opencode' | 'omp';
    cwd: string;
    startedAtMs: number;
  } => (
    (session.kind === 'cursor' || session.kind === 'opencode' || session.kind === 'omp')
    && !session.providerSessionId
    && typeof session.cwd === 'string'
    && typeof session.startedAtMs === 'number'
  ));
  if (unresolved.length === 0) return new Map();

  const providers = [...new Set(
    unresolved
      .filter((session) => attemptableTargetKeys.has(tmuxPaneIdentityKey(session.tmux)))
      .map((session) => session.kind),
  )];
  await Promise.all(providers.map(async (provider) => {
    const starts = unresolved
      .filter((session) => session.kind === provider)
      .map((session) => session.startedAtMs);
    const since = new Date(Math.min(...starts) - 30_000);
    await providerRegistry.resolveProvider(provider).sessionSynchronizer.synchronize(since);
  })).catch(() => undefined);

  const candidates: FreshIndexedProviderSession[] = [];
  const seen = new Set<string>();
  for (const session of unresolved) {
    for (const row of sessionsDb.getSessionsByProjectPath(session.cwd)) {
      const providerSessionId = row.provider_session_id;
      if (
        row.provider !== session.kind
        || !providerSessionId
        || row.session_id !== providerSessionId
      ) {
        continue;
      }
      const key = `${session.kind}:${providerSessionId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({
        id: providerSessionId,
        kind: session.kind,
        cwd: session.cwd,
        createdAtMs: new Date(row.created_at).getTime(),
        updatedAtMs: new Date(row.updated_at).getTime(),
        diskDiscovered: true,
      });
    }
  }
  const fresh = assignFreshIndexedProviderSessionIds(unresolved, candidates);
  return new Map(
    [...assignUniqueIndexedProviderSessionIds(unresolved, candidates, fresh, Date.now(), sessions)]
      .filter(([targetKey]) => attemptableTargetKeys.has(targetKey)),
  );
}

export function applyInferredProviderSessionIds(
  sessions: ExternalCliSession[],
  inferredIds: ReadonlyMap<string, string>,
  authoritativeTargetKeys: ReadonlySet<string> = new Set(),
): ExternalCliSession[] {
  return sessions.map((session) => {
    if (session.connectionIssue) {
      const { providerSessionId: _providerSessionId, ...unbound } = session;
      return unbound;
    }
    const targetKey = tmuxPaneIdentityKey(session.tmux);
    const providerSessionId = inferredIds.get(targetKey);
    return providerSessionId
      && (!session.providerSessionId || authoritativeTargetKeys.has(targetKey))
      ? { ...session, providerSessionId }
      : session;
  });
}

type ExternalProviderSessionInference = {
  ids: Map<string, string>;
  authoritativeTargetKeys: Set<string>;
};

async function inferExternalProviderSessionIds(args: {
  sessions: ExternalCliSession[];
  attemptableSessions: ExternalCliSession[];
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
}): Promise<ExternalProviderSessionInference> {
  const safeSessions = args.sessions.filter((session) => !session.connectionIssue);
  const attemptableTargetKeys = new Set(
    args.attemptableSessions.map((session) => tmuxPaneIdentityKey(session.tmux)),
  );

  const [observedCodex, inferredClaude, inferredOmp, freshCodex] = await Promise.all([
    inferOpenCodexThreadIds({
      sessions: safeSessions,
      panes: args.panes,
      procs: args.procs,
    }),
    inferClaudeSessionIds({
      sessions: safeSessions,
      panes: args.panes,
      procs: args.procs,
    }),
    inferOpenOmpSessionIds(safeSessions),
    args.attemptableSessions.some((session) => session.kind === 'codex')
      ? inferFreshCodexThreadIds({
        sessions: args.attemptableSessions,
        panes: args.panes,
        procs: args.procs,
      })
      : Promise.resolve(new Map<string, string>()),
  ]);
  const inferredFreshCodex = new Map(
    [...freshCodex].filter(([targetKey]) => attemptableTargetKeys.has(targetKey)),
  );
  const authoritativeTargetKeys = new Set([
    ...observedCodex.keys(),
    ...inferredClaude.keys(),
    ...inferredOmp.keys(),
  ]);
  const directIds = new Map([
    ...inferredFreshCodex,
    ...inferredClaude,
    ...inferredOmp,
    ...observedCodex,
  ]);
  const withDirectIds = applyInferredProviderSessionIds(
    safeSessions,
    directIds,
    authoritativeTargetKeys,
  );
  const inferredIndexed = args.attemptableSessions.some((session) => (
    session.kind === 'cursor' || session.kind === 'opencode' || session.kind === 'omp'
  ))
    ? await inferIndexedProviderSessionIds(withDirectIds, attemptableTargetKeys)
    : new Map<string, string>();
  return {
    ids: new Map([...directIds, ...inferredIndexed]),
    authoritativeTargetKeys,
  };
}


export function normalizeExternalPaneOutput(output: string, maxChars = 32_768): string {
  const plain = output
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, '')
    .trimEnd();
  return plain.length > maxChars ? plain.slice(-maxChars) : plain;
}


/** Resolves a web spawn cwd and rejects traversal/symlink escape outside HOME. */
export async function resolveExternalCliCwd(input: string): Promise<string | null> {
  const home = await realpath(homedir()).catch(() => null);
  if (!home || input.includes('\0')) return null;
  const trimmed = input.trim();
  const expanded = trimmed === '~'
    ? homedir()
    : trimmed.startsWith('~/')
      ? join(homedir(), trimmed.slice(2))
      : isAbsolute(trimmed)
        ? trimmed
        : join(homedir(), trimmed);
  try {
    const resolved = await realpath(expanded);
    const rel = relative(home, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return null;
    }
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export type ExternalSpawnCli = ExternalLocalCliKind;

const EXTERNAL_CLI_COMMANDS: Record<ExternalSpawnCli, readonly string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  cursor: CURSOR_CLI_COMMAND_CANDIDATES,
  opencode: ['opencode'],
  omp: ['omp'],
};

type ExternalCliExecutableResolverOptions = {
  path?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
  isExecutable?: (candidate: string) => Promise<boolean>;
};

export function withoutNodeModulesBins(pathValue: string): string {
  return pathValue
    .split(delimiter)
    .filter((entry) => entry && !(dirname(entry).endsWith(`${sep}node_modules`) && entry.endsWith(`${sep}.bin`)))
    .join(delimiter);
}

export function buildExternalCliRuntimePath(
  pathValue = process.env.PATH ?? '',
  home = homedir(),
  nodeExecutable = process.execPath,
  executable?: string,
): string {
  const preferred = [
    executable ? dirname(executable) : null,
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.npm-global', 'bin'),
    dirname(nodeExecutable),
  ].filter((entry): entry is string => Boolean(entry));
  const inherited = withoutNodeModulesBins(pathValue).split(delimiter).filter(Boolean);
  return [...new Set([...preferred, ...inherited])].join(delimiter);
}

/** Resolves user-installed agents without letting ChatMux's npm scripts shadow them. */
export async function resolveExternalCliExecutable(
  cli: ExternalSpawnCli,
  options: ExternalCliExecutableResolverOptions = {},
): Promise<string> {
  const commands = EXTERNAL_CLI_COMMANDS[cli];
  const platform = options.platform ?? process.platform;
  const searchPath = options.path === undefined
    ? buildExternalCliRuntimePath()
    : withoutNodeModulesBins(options.path);
  const extensions = platform === 'win32'
    ? (options.pathExt ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const isExecutable = options.isExecutable ?? (async (candidate: string) => {
    try {
      await access(candidate, fsConstants.X_OK);
      return (await stat(candidate)).isFile();
    } catch {
      return false;
    }
  });

  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    for (const command of commands) {
      for (const extension of extensions) {
        const candidate = join(directory, `${command}${extension}`);
        if (await isExecutable(candidate)) {
          return candidate;
        }
      }
    }
  }
  return commands[0];
}

export function buildExternalCliTmuxSpawnArgs(
  executable: string,
  tmuxName: string,
  cwd: string,
  runtimePath = buildExternalCliRuntimePath(process.env.PATH ?? '', homedir(), process.execPath, executable),
): string[] {
  // Codex and OMP terminate during detached startup without an initial grid.
  // The explicit PATH also preserves user-installed Node/Bun launchers when
  // ChatMux itself runs under systemd's intentionally minimal environment.
  return [
    'new-session', '-d',
    '-x', '120', '-y', '40',
    '-e', `PATH=${runtimePath}`,
    '-s', tmuxName,
    '-c', cwd,
    '/usr/bin/env', `PATH=${runtimePath}`, executable,
  ];
}

export type ExternalCliSpawnOutcome = 'ready' | 'codex_update_required';

export function codexStartupNeedsUpdate(output: string): boolean {
  return /update available!/iu.test(output);
}

async function inspectCodexStartup(tmuxName: string): Promise<ExternalCliSpawnOutcome> {
  const attempts = 5;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const output = await runCommand('tmux', [
      'capture-pane', '-p',
      '-t', `${tmuxName}:0.0`,
      '-S', '-40',
    ]);
    if (codexStartupNeedsUpdate(output)) return 'codex_update_required';
    // Keep the short observation window open: the normal shell frame can be
    // rendered before Codex replaces it with the update prompt.
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return 'ready';
}

/** Boots and tags a native CLI in a fresh detached tmux session. */
export async function spawnExternalCliSession(
  cli: ExternalSpawnCli,
  tmuxName: string,
  cwd: string,
): Promise<ExternalCliSpawnOutcome> {
  const executable = await resolveExternalCliExecutable(cli);
  const runtimePath = buildExternalCliRuntimePath(
    process.env.PATH ?? '',
    homedir(),
    process.execPath,
    executable,
  );

  await runCommand('tmux', buildExternalCliTmuxSpawnArgs(executable, tmuxName, cwd, runtimePath));
  try {
    await runCommand('tmux', ['set-option', '-t', tmuxName, '@chatmux_cli_kind', cli]);
    if (cli === 'codex' && await inspectCodexStartup(tmuxName) === 'codex_update_required') {
      await runCommand('tmux', ['kill-session', '-t', `=${tmuxName}`]).catch(() => undefined);
      return 'codex_update_required';
    }
    return 'ready';
  } catch (error) {
    await runCommand('tmux', ['kill-session', '-t', `=${tmuxName}`]).catch(() => undefined);
    throw error;
  }
}


export type CurrentTmuxPaneIdentity =
  | Readonly<{ state: 'hosted'; tmux: TmuxPaneIdentity }>
  | Readonly<{ state: 'not-hosted' }>
  | Readonly<{ state: 'unavailable' }>;

/** Distinguishes a server outside tmux from a failed self-pane lookup. */
export async function getCurrentTmuxPaneIdentityState(): Promise<CurrentTmuxPaneIdentity> {
  const paneId = process.env.TMUX_PANE;
  if (!paneId) return { state: 'not-hosted' };
  if (!/^%\d+$/.test(paneId)) return { state: 'unavailable' };
  try {
    const fields = (await runCommand('tmux', [
      'display-message',
      '-p',
      '-t',
      paneId,
      `#{socket_path}${TMUX_FIELD_SEP}#{session_id}${TMUX_FIELD_SEP}#{window_id}${TMUX_FIELD_SEP}#{pane_id}`,
    ])).trim().split(TMUX_FIELD_SEP);
    if (
      fields.length !== 4
      || !fields[0]
      || !/^\$\d+$/.test(fields[1])
      || !/^@\d+$/.test(fields[2])
      || !/^%\d+$/.test(fields[3])
    ) {
      return { state: 'unavailable' };
    }
    return {
      state: 'hosted',
      tmux: {
        socketPath: fields[0],
        sessionId: fields[1],
        windowId: fields[2],
        paneId: fields[3],
      },
    };
  } catch {
    return { state: 'unavailable' };
  }
}

/** Returns the tmux session hosting this server, retained for legacy callers. */
export async function getCurrentTmuxPaneIdentity(): Promise<TmuxPaneIdentity | null> {
  const current = await getCurrentTmuxPaneIdentityState();
  return current.state === 'hosted' ? current.tmux : null;
}

/** Finds and validates Codex's JSONL rollout path for immediate transcript indexing. */
export async function resolveCodexRolloutPath(threadId: string): Promise<string | null> {
  if (!CODEX_THREAD_ID_RE.test(threadId)) return null;

  let db: Database.Database | null = null;
  try {
    db = new Database(join(homedir(), '.codex', 'state_5.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ? LIMIT 1')
      .get(threadId) as { rollout_path?: unknown } | undefined;
    if (typeof row?.rollout_path !== 'string' || !row.rollout_path.endsWith('.jsonl')) {
      return null;
    }

    const [sessionsRoot, rolloutPath] = await Promise.all([
      realpath(join(homedir(), '.codex', 'sessions')),
      realpath(row.rollout_path),
    ]);
    const rel = relative(sessionsRoot, rolloutPath);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return rolloutPath;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Scans local coding-agent tmux sessions. Command failures are unavailable so
 * callers can avoid treating a failed scan as a confirmed empty result.
 */
async function runDiscoveryCommand(
  commandRunner: ExternalCliSessionCommandRunner,
  command: string,
  cmdArgs: string[],
): Promise<string> {
  if (commandRunner !== runCommand) recordHostCommand(command, cmdArgs);
  return commandRunner(command, cmdArgs);
}

async function discoverExternalCliSessions(
  retryBackoff: ExternalCliSessionInferenceRetryBackoff,
  commandRunner: ExternalCliSessionCommandRunner = runCommand,
  hostSnapshot?: HostDiscoverySnapshot,
): Promise<ExternalCliSessionsDetailedResult> {
  let panes: ExternalPane[];
  let procs: ProcessTreeEntry[];
  if (hostSnapshot) {
    if (!hostSnapshot.ok) return { ok: false, sessions: [] };
    panes = hostSnapshot.panes.map((pane) => ({
      name: pane.name,
      tmux: pane.tmux,
      pid: pane.pid,
      command: pane.command,
      ...(pane.codexThreadId ? { codexThreadId: pane.codexThreadId } : {}),
      ...(pane.cwd ? { cwd: pane.cwd } : {}),
      ...(pane.taggedKind && ['claude', 'codex', 'cursor', 'opencode', 'omp'].includes(pane.taggedKind)
        ? { taggedKind: pane.taggedKind as ExternalLocalCliKind }
        : {}),
      ...(pane.taggedSessionId ? { taggedSessionId: pane.taggedSessionId } : {}),
    }));
    procs = [...hostSnapshot.processes];
  } else {
    let tmuxOutput: string;
    let psOutput: string;
    try {
      tmuxOutput = await runDiscoveryCommand(commandRunner, 'tmux', [
        'list-panes', '-a', '-F',
        `#{socket_path}${TMUX_FIELD_SEP}#{session_id}${TMUX_FIELD_SEP}#{window_id}${TMUX_FIELD_SEP}#{pane_id}${TMUX_FIELD_SEP}#{session_name}${TMUX_FIELD_SEP}#{pane_pid}${TMUX_FIELD_SEP}#{pane_current_command}${TMUX_FIELD_SEP}#{@chatmux_codex_thread_id}${TMUX_FIELD_SEP}#{pane_current_path}${TMUX_FIELD_SEP}#{@chatmux_cli_kind}${TMUX_FIELD_SEP}#{@chatmux_provider_session_id}`,
      ]);
      psOutput = await runDiscoveryCommand(commandRunner, 'ps', ['-eo', 'pid,ppid,comm,args']);
    } catch {
      return { ok: false, sessions: [] };
    }
    panes = parseExternalPanes(tmuxOutput);
    procs = parsePsTree(psOutput);
  }
  const classified = classifyExternalSessions({ panes, procs });
  const sessions = await addExternalRuntimeMetadata({ sessions: classified, panes, procs });
  const attemptableSessions = retryBackoff.attemptableSessions(sessions);
  const inference = await inferExternalProviderSessionIds({
    sessions,
    attemptableSessions,
    panes,
    procs,
  });
  const resolvedSessions = applyInferredProviderSessionIds(
    sessions,
    inference.ids,
    inference.authoritativeTargetKeys,
  );
  retryBackoff.recordResults(resolvedSessions, attemptableSessions);
  return { ok: true, sessions: resolvedSessions };
}

export type ExternalCliSessionDiscovery = {
  getExternalCliSessionsDetailed(): Promise<ExternalCliSessionsDetailedResult>;
  getExternalCliSessionsDetailedFresh(): Promise<ExternalCliSessionsDetailedResult>;
  getExternalCliSessions(): Promise<ExternalCliSession[]>;
  getExternalCliSessionsFresh(): Promise<ExternalCliSession[]>;
};

export type ExternalCliSessionDiscoveryOptions = {
  commandRunner?: ExternalCliSessionCommandRunner;
  now?: () => number;
  cacheTtlMs?: number;
  hostSnapshot?: () => Promise<HostDiscoverySnapshot>;
  freshHostSnapshot?: () => Promise<HostDiscoverySnapshot>;
  discover?: (
    retryBackoff: ExternalCliSessionInferenceRetryBackoff,
  ) => Promise<ExternalCliSessionsDetailedResult>;
  discoverFresh?: (
    retryBackoff: ExternalCliSessionInferenceRetryBackoff,
  ) => Promise<ExternalCliSessionsDetailedResult>;
};

/**
 * Creates an isolated discovery cache for tests; production uses the default
 * instance below. A clock seam avoids timer sleeps when verifying cache expiry.
 */
export function createExternalCliSessionDiscovery(
  options: ExternalCliSessionDiscoveryOptions = {},
): ExternalCliSessionDiscovery {
  const now = options.now ?? Date.now;
  const requestedCacheTtlMs = options.cacheTtlMs;
  const cacheTtlMs = typeof requestedCacheTtlMs === 'number'
    && Number.isFinite(requestedCacheTtlMs)
    && requestedCacheTtlMs >= 0
    ? requestedCacheTtlMs
    : 1_000;
  const retryBackoff = createExternalCliSessionInferenceRetryBackoff({ now });
  const discover = options.discover
    ?? (options.hostSnapshot
      ? async (backoff) => discoverExternalCliSessions(
        backoff,
        options.commandRunner,
        await options.hostSnapshot!(),
      )
      : (backoff) => discoverExternalCliSessions(backoff, options.commandRunner));
  const discoverFresh = options.discoverFresh
    ?? (options.freshHostSnapshot
      ? async (backoff) => discoverExternalCliSessions(
        backoff,
        options.commandRunner,
        await options.freshHostSnapshot!(),
      )
      : discover);
  let cached: { result: ExternalCliSessionsDetailedResult; expiresAtMs: number } | null = null;
  let inFlight: Promise<ExternalCliSessionsDetailedResult> | null = null;

  const getExternalCliSessionsDetailed = (): Promise<ExternalCliSessionsDetailedResult> => {
    if (cached && now() < cached.expiresAtMs) return Promise.resolve(cached.result);
    if (inFlight) return inFlight;

    const scan: Promise<ExternalCliSessionsDetailedResult> = Promise.resolve()
      .then(() => discover(retryBackoff))
      .catch(() => ({ ok: false, sessions: [] }))
      .then((result) => {
        cached = { result, expiresAtMs: now() + cacheTtlMs };
        return result;
      })
      .finally(() => {
        if (inFlight === scan) inFlight = null;
      });
    inFlight = scan;
    return scan;
  };

  return {
    getExternalCliSessionsDetailed,
    async getExternalCliSessionsDetailedFresh() {
      return discoverFresh(retryBackoff).catch(() => ({ ok: false, sessions: [] }));
    },
    async getExternalCliSessions() {
      return (await getExternalCliSessionsDetailed()).sessions;
    },
    async getExternalCliSessionsFresh() {
      return (await discoverFresh(retryBackoff)).sessions;
    },
  };
}

const defaultExternalCliSessionDiscovery = createExternalCliSessionDiscovery({
  hostSnapshot: hostDiscoverySnapshotSource.get,
  freshHostSnapshot: hostDiscoverySnapshotSource.getFresh,
});

/** Distinguishes a confirmed empty discovery from unavailable tmux/ps evidence. */
export function getExternalCliSessionsDetailed(): Promise<ExternalCliSessionsDetailedResult> {
  return defaultExternalCliSessionDiscovery.getExternalCliSessionsDetailed();
}

/** Bypasses completed-result caching after an authoritative host-roster change. */
export function getExternalCliSessionsDetailedFresh(): Promise<ExternalCliSessionsDetailedResult> {
  return defaultExternalCliSessionDiscovery.getExternalCliSessionsDetailedFresh();
}

/** Compatible session-only wrapper for existing callers. */
export function getExternalCliSessions(): Promise<ExternalCliSession[]> {
  return defaultExternalCliSessionDiscovery.getExternalCliSessions();
}

/** Bypasses the display cache for request-time control authorization. */
export function getExternalCliSessionsFresh(): Promise<ExternalCliSession[]> {
  return defaultExternalCliSessionDiscovery.getExternalCliSessionsFresh();
}
