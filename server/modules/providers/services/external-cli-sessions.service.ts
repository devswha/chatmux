import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';

/**
 * Discovers local coding-agent TUIs running inside tmux. GJC keeps its
 * dedicated live lane; Claude, Codex, Cursor, OpenCode, and Oh My Pi are
 * surfaced here with native transcript ids when they can be proven. SSH stays
 * terminal-only because the far-side process is not locally observable.
 */

const TMUX_FIELD_SEP = '\t';
const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_RESUME_THREAD_RE = /(?:^|\s)resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i;
const CLAUDE_RESUME_SESSION_RE = /(?:^|\s)--resume(?:=|\s+)([0-9a-f]{8}-[0-9a-f-]{27,})(?=\s|$)/i;
const CURSOR_RESUME_SESSION_RE = /(?:^|\s)(?:--resume|resume)(?:=|\s+)([A-Za-z0-9_-]{8,128})(?=\s|$)/;
const OPENCODE_SESSION_RE = /(?:^|\s)--session(?:=|\s+)([A-Za-z0-9_-]{8,128})(?=\s|$)/;
const OMP_RESUME_SESSION_RE = /(?:^|\s)(?:--resume|-r)(?:=|\s+)([A-Za-z0-9_-]{8,128})(?=\s|$)/;

export type ExternalLocalCliKind = 'claude' | 'codex' | 'cursor' | 'opencode' | 'omp';
export type ExternalCliKind = ExternalLocalCliKind | 'ssh';
export type ExternalCliSession = {
  tmuxName: string;
  kind: ExternalCliKind;
  providerSessionId?: string;
  cwd?: string;
  startedAtMs?: number;
};

export type ExternalPane = {
  name: string;
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

type FreshCodexProcess = { tmuxName: string; cwd: string; startedAtMs: number };
type FreshCodexThread = { id: string; cwd: string; createdAtMs: number };
type FreshIndexedProviderSession = {
  id: string;
  kind: ExternalLocalCliKind;
  cwd: string;
  createdAtMs: number;
  diskDiscovered: boolean;
};

/** Matches the tower/live-send tmux-name discipline; also safe to embed in a shell command. */
export const EXTERNAL_TMUX_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

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
      !assigned.has(process.tmuxName)
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
      assigned.set(owner.tmuxName, thread.id);
    }
  }
  return assigned;
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
    assigned.set(process.tmuxName, candidate.id);
    claimed.add(`${candidate.kind}:${candidate.id}`);
  }
  return assigned;
}

/** Parses pane identity and ChatMux's optional provider/session user-options. */
export function parseExternalPanes(output: string): ExternalPane[] {
  const panes: ExternalPane[] = [];
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const fields = raw.split(TMUX_FIELD_SEP);
    if (fields.length < 3) continue;
    const [rawName, rawPid, rawCommand, rawCodexThreadId, rawCwd, rawKind, rawSessionId] = fields;
    const name = rawName.trim();
    const pid = Number.parseInt(rawPid.trim(), 10);
    const command = rawCommand.trim();
    const codexThreadId = rawCodexThreadId?.trim() ?? '';
    const cwd = rawCwd?.trim() ?? '';
    const taggedKind = rawKind?.trim() as ExternalLocalCliKind | undefined;
    const taggedSessionId = rawSessionId?.trim() ?? '';
    if (!name || !Number.isFinite(pid)) continue;
    panes.push({
      name,
      pid,
      command,
      ...(codexThreadId ? { codexThreadId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(taggedKind && ['claude', 'codex', 'cursor', 'opencode', 'omp'].includes(taggedKind)
        ? { taggedKind }
        : {}),
      ...(taggedSessionId ? { taggedSessionId } : {}),
    });
  }
  return panes;
}

/** Parses `ps -eo pid,ppid,comm[,args]` output (header tolerated). */
export function parsePsTree(output: string): ProcessTreeEntry[] {
  const rows: ProcessTreeEntry[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const match = /^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) {
      continue; // header or malformed line
    }
    const processArgs = match[4]?.trim();
    rows.push({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      comm: match[3],
      ...(processArgs ? { args: processArgs } : {}),
    });
  }
  return rows;
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
  if (executable('cursor-agent')) return 'cursor';
  if (executable('opencode')) return 'opencode';
  if (executable('omp')) return 'omp';
  if (executable('ssh')) return 'ssh';
  return null;
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

  const factsBySession = new Map<string, {
    kinds: Set<ExternalLocalCliKind | 'gjc' | 'ssh'>;
    taggedKinds: Set<ExternalLocalCliKind>;
    sessionIds: Map<ExternalLocalCliKind, Set<string>>;
    cwds: Set<string>;
  }>();

  for (const pane of args.panes) {
    const facts = factsBySession.get(pane.name) ?? {
      kinds: new Set(),
      taggedKinds: new Set(),
      sessionIds: new Map(),
      cwds: new Set(),
    };
    factsBySession.set(pane.name, facts);
    if (pane.cwd) facts.cwds.add(pane.cwd);
    if (pane.taggedKind) {
      facts.taggedKinds.add(pane.taggedKind);
      facts.kinds.add(pane.taggedKind);
      if (pane.taggedSessionId) {
        facts.sessionIds.set(pane.taggedKind, new Set([pane.taggedSessionId]));
      }
    }
    if (pane.codexThreadId && CODEX_THREAD_ID_RE.test(pane.codexThreadId)) {
      facts.kinds.add('codex');
      facts.sessionIds.set('codex', new Set([pane.codexThreadId]));
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
    if (subtreeKinds.some(({ kind }) => kind === 'gjc')) {
      facts.kinds.add('gjc');
      continue;
    }

    const foregroundKind = processCliKind({ comm: pane.command });
    if (foregroundKind) {
      facts.kinds.add(foregroundKind);
    } else if (
      pane.command.toLowerCase() === 'node'
      && subtreeKinds.some(({ kind }) => kind === 'codex')
    ) {
      facts.kinds.add('codex');
    }

    const acceptedKinds = new Set<ExternalLocalCliKind>([
      ...facts.taggedKinds,
      ...[...facts.kinds].filter(
        (kind): kind is ExternalLocalCliKind => kind !== 'gjc' && kind !== 'ssh',
      ),
    ]);
    for (const { kind, proc } of subtreeKinds) {
      if (kind === 'gjc' || kind === 'ssh' || !acceptedKinds.has(kind)) continue;
      const providerSessionId = extractExternalResumeSessionId(kind, proc.args);
      if (!providerSessionId) continue;
      const ids = facts.sessionIds.get(kind) ?? new Set<string>();
      ids.add(providerSessionId);
      facts.sessionIds.set(kind, ids);
    }
  }

  const priority: ExternalCliKind[] = ['claude', 'codex', 'cursor', 'opencode', 'omp', 'ssh'];
  const result: ExternalCliSession[] = [];
  for (const [tmuxName, facts] of factsBySession) {
    if (!EXTERNAL_TMUX_NAME_RE.test(tmuxName) || facts.kinds.has('gjc')) continue;
    const kind = priority.find((candidate) => (
      facts.taggedKinds.has(candidate as ExternalLocalCliKind) || facts.kinds.has(candidate)
    ));
    if (!kind) continue;
    const ids = kind === 'ssh'
      ? []
      : [...(facts.sessionIds.get(kind) ?? [])];
    const cwds = [...facts.cwds];
    result.push({
      tmuxName,
      kind,
      ...(ids.length === 1 ? { providerSessionId: ids[0] } : {}),
      ...(cwds.length === 1 ? { cwd: cwds[0] } : {}),
    });
  }
  return result.sort((a, b) => a.tmuxName.localeCompare(b.tmuxName));
}

function runCommand(command: string, cmdArgs: string[], timeoutMs = 4000): Promise<string> {
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

async function processStartMs(pid: number): Promise<number | null> {
  try {
    return (await stat(`/proc/${pid}`)).mtimeMs;
  } catch {
    return null;
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
  const unresolvedNames = new Set(
    args.sessions
      .filter((session) => session.kind === 'codex' && !session.providerSessionId)
      .map((session) => session.tmuxName),
  );
  if (unresolvedNames.size === 0) return new Map();

  const children = new Map<number, number[]>();
  const procByPid = new Map(args.procs.map((proc) => [proc.pid, proc]));
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid) ?? [];
    siblings.push(proc.pid);
    children.set(proc.ppid, siblings);
  }

  const processes: FreshCodexProcess[] = [];
  for (const pane of args.panes) {
    if (!unresolvedNames.has(pane.name) || !pane.cwd) continue;
    const codexPids = descendants(pane.pid, children).filter((pid) => {
      const proc = procByPid.get(pid);
      return proc?.comm === 'codex'
        && !proc.args?.includes(' app-server')
        && !proc.args?.includes('code-mode');
    });
    if (codexPids.length !== 1) continue;
    const startedAtMs = await processStartMs(codexPids[0]);
    if (startedAtMs !== null) {
      processes.push({ tmuxName: pane.name, cwd: pane.cwd, startedAtMs });
    }
  }
  if (processes.length === 0) return new Map();

  const threads = readFreshCodexThreads(Math.min(...processes.map((process) => process.startedAtMs)));
  return assignFreshCodexThreadIds(processes, threads);
}

async function inferClaudeSessionIds(args: {
  sessions: ExternalCliSession[];
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
}): Promise<Map<string, string>> {
  const claudeNames = new Set(
    args.sessions
      .filter((session) => session.kind === 'claude')
      .map((session) => session.tmuxName),
  );
  if (claudeNames.size === 0) return new Map();

  const children = new Map<number, number[]>();
  const procByPid = new Map(args.procs.map((proc) => [proc.pid, proc]));
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid) ?? [];
    siblings.push(proc.pid);
    children.set(proc.ppid, siblings);
  }

  const candidates = new Map<string, Map<number, string>>();
  for (const pane of args.panes) {
    if (!claudeNames.has(pane.name) || !pane.cwd) continue;
    for (const pid of descendants(pane.pid, children)) {
      if (procByPid.get(pid)?.comm !== 'claude') continue;
      const byPid = candidates.get(pane.name) ?? new Map<number, string>();
      byPid.set(pid, pane.cwd);
      candidates.set(pane.name, byPid);
    }
  }

  const resolved = new Map<string, string>();
  await Promise.all([...candidates].map(async ([tmuxName, byPid]) => {
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
        resolved.set(tmuxName, receipt.sessionId);
      }
    } catch {
      // The Claude runtime receipt is best-effort and may disappear on exit.
    }
  }));
  return resolved;
}

async function addExternalRuntimeMetadata(args: {
  sessions: ExternalCliSession[];
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
}): Promise<ExternalCliSession[]> {
  const children = new Map<number, number[]>();
  const procByPid = new Map(args.procs.map((proc) => [proc.pid, proc]));
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid) ?? [];
    siblings.push(proc.pid);
    children.set(proc.ppid, siblings);
  }
  const panesByName = new Map<string, ExternalPane[]>();
  for (const pane of args.panes) {
    const panes = panesByName.get(pane.name) ?? [];
    panes.push(pane);
    panesByName.set(pane.name, panes);
  }

  return Promise.all(args.sessions.map(async (session) => {
    if (session.kind === 'ssh') return session;
    const matchingPids = (panesByName.get(session.tmuxName) ?? [])
      .flatMap((pane) => descendants(pane.pid, children))
      .filter((pid) => processCliKind(procByPid.get(pid) ?? { comm: '' }) === session.kind);
    const starts = await Promise.all([...new Set(matchingPids)].map(processStartMs));
    const validStarts = starts.filter((value): value is number => value !== null);
    return validStarts.length > 0
      ? { ...session, startedAtMs: Math.min(...validStarts) }
      : session;
  }));
}

async function inferIndexedProviderSessionIds(
  sessions: ExternalCliSession[],
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

  const providers = [...new Set(unresolved.map((session) => session.kind))];
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
        diskDiscovered: true,
      });
    }
  }
  return assignFreshIndexedProviderSessionIds(unresolved, candidates);
}

/** Relays one literal prompt/selection into a verified native external CLI tmux TUI. */
export async function sendToExternalCliSession(tmuxName: string, message: string): Promise<void> {
  const target = `${tmuxName}:`;
  await runCommand('tmux', ['send-keys', '-t', target, '-l', '--', message]);
  // Native TUIs can coalesce a rapid key burst as paste input. Sending Enter in
  // the immediately following tmux command can leave text in the composer.
  await delay(150);
  await runCommand('tmux', ['send-keys', '-t', target, 'Enter']);
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

const EXTERNAL_CLI_COMMAND: Record<ExternalSpawnCli, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  opencode: 'opencode',
  omp: 'omp',
};

/** Boots and tags a native CLI in a fresh detached tmux session. */
export async function spawnExternalCliSession(cli: ExternalSpawnCli, tmuxName: string, cwd: string): Promise<void> {
  await runCommand('tmux', [
    'new-session', '-d', '-s', tmuxName, '-c', cwd, EXTERNAL_CLI_COMMAND[cli],
  ]);
  try {
    await runCommand('tmux', ['set-option', '-t', tmuxName, '@chatmux_cli_kind', cli]);
  } catch (error) {
    await runCommand('tmux', ['kill-session', '-t', `=${tmuxName}`]).catch(() => undefined);
    throw error;
  }
}

export async function killExternalCliSession(tmuxName: string): Promise<void> {
  await runCommand('tmux', ['kill-session', '-t', `=${tmuxName}`]);
}

/** Returns the tmux session hosting this server, so its own session cannot be killed. */
export async function getCurrentTmuxSessionName(): Promise<string | null> {
  const paneId = process.env.TMUX_PANE;
  if (!paneId || !/^%\d+$/.test(paneId)) return null;
  try {
    return (await runCommand('tmux', [
      'display-message',
      '-p',
      '-t',
      paneId,
      '#{session_name}',
    ])).trim() || null;
  } catch {
    return null;
  }
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
 * Returns local coding-agent tmux sessions. Empty on tmux/ps failure. Native
 * ids come from explicit resume argv, Claude runtime receipts, Codex's thread
 * database, or a unique newly indexed transcript for the same cwd/start time.
 */
export async function getExternalCliSessions(): Promise<ExternalCliSession[]> {
  let tmuxOutput: string;
  let psOutput: string;
  try {
    tmuxOutput = await runCommand('tmux', [
      'list-panes', '-a', '-F',
      `#{session_name}${TMUX_FIELD_SEP}#{pane_pid}${TMUX_FIELD_SEP}#{pane_current_command}${TMUX_FIELD_SEP}#{@chatmux_codex_thread_id}${TMUX_FIELD_SEP}#{pane_current_path}${TMUX_FIELD_SEP}#{@chatmux_cli_kind}${TMUX_FIELD_SEP}#{@chatmux_provider_session_id}`,
    ]);
    psOutput = await runCommand('ps', ['-eo', 'pid,ppid,comm,args']);
  } catch {
    return [];
  }
  const panes = parseExternalPanes(tmuxOutput);
  const procs = parsePsTree(psOutput);
  const classified = classifyExternalSessions({ panes, procs });
  const sessions = await addExternalRuntimeMetadata({ sessions: classified, panes, procs });
  const [inferredCodex, inferredClaude] = await Promise.all([
    inferFreshCodexThreadIds({ sessions, panes, procs }),
    inferClaudeSessionIds({ sessions, panes, procs }),
  ]);
  const withDirectIds = sessions.map((session) => ({
    ...session,
    ...(!session.providerSessionId && inferredCodex.has(session.tmuxName)
      ? { providerSessionId: inferredCodex.get(session.tmuxName)! }
      : {}),
    ...(!session.providerSessionId && session.kind === 'claude' && inferredClaude.has(session.tmuxName)
      ? { providerSessionId: inferredClaude.get(session.tmuxName)! }
      : {}),
  }));
  const inferredIndexed = await inferIndexedProviderSessionIds(withDirectIds);
  return withDirectIds.map((session) => ({
    ...session,
    ...(!session.providerSessionId && inferredIndexed.has(session.tmuxName)
      ? { providerSessionId: inferredIndexed.get(session.tmuxName)! }
      : {}),
  }));
}
