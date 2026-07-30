import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  tmuxPaneIdentityKey,
  type TmuxPaneIdentity,
  type TmuxProcessGeneration,
} from '../../../../shared/tmux.js';

import { recordHostCommand } from './host-command-metrics.service.js';

/**
 * Live gjc session detection + tmux-session naming.
 *
 * A gjc session is "live" when a running gjc process has its transcript file open.
 * For the "작동 중" fleet view we also map each live session id → the tmux session
 * NAME it runs in (omg / stock / flask / …), by PROCESS LINEAGE:
 *   - lsof over the gjc session roots → {session-id uuid, holder pid} for open
 *     transcript files (holder argv confirmed gjc; comm is unreliable under bun/node)
 *   - /proc/<pid>/stat    → the holder's ancestor pid chain
 *   - tmux list-panes     → {session_name, pane_pid, pane cwd (realpath)}
 *   - a pane_pid found in the holder's ancestor chain → that pane's tmux name (0 ambiguity)
 *   - cwd equality is a FALLBACK only (many-to-many when panes share a cwd)
 *
 * Matching is PATH-AGNOSTIC (uuid + realpath'd cwds), so the production app's
 * decoy HOME (whose `.gjc` is a symlink) does not break it. tmux/lsof/proc access
 * is ISOLATED here and fails closed to [] (or tmuxName:null on a miss — the UI
 * falls back to the conversation title).
 *
 * gjc creates the transcript only at the FIRST user message, so a freshly booted
 * (or long-idle-restarted) gjc TUI is invisible to the lsof pipeline until the
 * user talks once (하코 관찰: 재시작 직후 tmux 세션이 전부 안 보임). Those panes
 * are detected separately by PROCESS SUBTREE (same evidence grade as a lineage
 * claim) and surfaced as synthetic `idle-gjc:<tmux name>` rows.
 */

const SESSIONS_SEGMENT = '.gjc/agent/sessions';
const SESSION_FILE_RE = /\.gjc\/agent\/sessions\/[^/]+\/[^/]*_([0-9a-fA-F][0-9a-fA-F-]{7,})\.jsonl\b/;
const SESSION_SIDECAR_FILE_RE = /^(.*\/\.gjc\/agent\/sessions\/[^/]+\/[^/]*_([0-9a-fA-F][0-9a-fA-F-]{7,}))\/[^/]+\.jsonl$/;
const TMUX_FIELD_SEP = '\t';

export type LiveGjcSession = {
  id: string;
  tmuxName: string | null;
  /** Exact tmux pane backing this row; null when only transcript history is known. */
  tmux: TmuxPaneIdentity | null;
  /** Agent PID plus start time; changes whenever a pane starts a new agent process. */
  process: TmuxProcessGeneration | null;
  /**
   * How the tmux name was resolved: 'lineage' = the gjc process runs INSIDE
   * that tmux session (safe to kill/relay); 'cwd' = label-only directory match
   * (the pane belongs to something else — tmux actions are forbidden).
   */
  claim: 'lineage' | 'cwd' | null;
  /**
   * Foreground-command classification of the pane this row runs in:
   * 'interactive' = the pane's foreground command IS gjc (a live gjc TUI);
   * 'batch' = gjc is present (lineage/subtree) but is NOT the foreground
   * command (a background/batch gjc under a shell); null = undeterminable
   * (cwd-only label, no pane, or missing pane_current_command — the UI then
   * behaves exactly as before). Purely presentational: kill/relay safety keys
   * off `claim`, never `kind`.
   */
  kind: 'interactive' | 'batch' | null;
  model: string | null;
  effort: string | null;
  /**
   * Whether the transcript shows a turn in progress (assistant answering or
   * tool loop running). null = undeterminable (no transcript yet, no complete
   * turn-relevant record, or a read failure) — the UI then shows the plain LIVE
   * badge. Purely presentational.
   */
  running: boolean | null;
  /** Whether the last turn-relevant record is an assistant/provider error. */
  error?: boolean | null;
};

/** Synthetic id prefix for gjc panes that opened no transcript yet (first message pending). */
export const IDLE_GJC_ID_PREFIX = 'idle-gjc:';


/**
 * True when a process's argv belongs to gjc — whether it runs as a native `gjc`
 * binary or under an interpreter (`bun /path/to/gjc`, `node …/coding-agent/…`).
 * The command NAME (comm) is unreliable for interpreter launches (it reads
 * 'bun'/'node'), so argv is authoritative. `cmdline` may be raw NUL-separated
 * /proc/<pid>/cmdline or the whitespace-separated `ps args` representation.
 */
export function isGjcCommandLine(cmdline: string): boolean {
  if (!cmdline) {
    return false;
  }
  const argv = cmdline.includes('\0')
    ? cmdline.split('\0').filter(Boolean)
    : cmdline.trim().split(/\s+/).filter(Boolean);
  return argv.some((token) => basename(token) === 'gjc') || cmdline.includes('@chatmux-code/coding-agent');
}

/** Roots gjc writes transcripts under; a live transcript sits in one of them. */
export function gjcSessionRoots(): string[] {
  return [
    join(homedir(), '.gjc', 'agent', 'sessions'),
    process.env.GJC_LIVE_SESSION_DIR || join(tmpdir(), 'gjc-live-sessions'),
  ];
}

/**
 * True when a `ps -eo args` command line belongs to a gjc process — native
 * `gjc`, or bun/node running the gjc entry. Deliberately TIGHTER than
 * isGjcCommandLine: an idle-row match grants kill/relay affordances without
 * the transcript-holder anchor, so a stray "gjc" token deeper in argv
 * (e.g. `man gjc`, an editor on a file named gjc) must not qualify — only
 * argv[0], or argv[1] behind a bun/node interpreter, counts.
 */
export function isGjcProcessArgs(args: string): boolean {
  const tokens = args.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }
  const head = basename(tokens[0]);
  if (head === 'gjc') {
    return true;
  }
  if ((head === 'bun' || head === 'node') && tokens.length > 1) {
    return basename(tokens[1]) === 'gjc' || tokens[1].includes('@chatmux-code/coding-agent');
  }
  return false;
}

/** Parses `ps -eo pid,ppid,args` rows (args may contain spaces); tolerates the header. */
export function parsePsArgsTree(output: string): Array<{ pid: number; ppid: number; args: string }> {
  const rows: Array<{ pid: number; ppid: number; args: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match) {
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] });
    }
  }
  return rows;
}

/** Foreground comms that can BE gjc when the pane subtree proves gjc is inside. */
const GJC_INTERPRETER_COMMS = new Set(['bun', 'node']);

/**
 * Classifies a pane's foreground command for a pane KNOWN to contain a gjc
 * process (lineage/subtree). 'interactive' when the foreground command is gjc
 * itself OR a bun/node interpreter (an interpreter-launched gjc TUI reports
 * comm 'bun'/'node' — #1); 'batch' when gjc is only a descendant of a shell;
 * null when the command is unknown (fallback — the UI treats the row exactly
 * as before). Trade-off: a pane whose foreground is an unrelated bun/node
 * process with a background gjc is mislabelled 'interactive' — presentational
 * only, and rarer than the interpreter-TUI case. Never affects kill/relay
 * eligibility.
 */
function paneKind(cmd: string | null | undefined): 'interactive' | 'batch' | null {
  if (!cmd) {
    return null;
  }
  return cmd === 'gjc' || GJC_INTERPRETER_COMMS.has(cmd) ? 'interactive' : 'batch';
}

/**
 * Pure detection: tmux sessions whose pane process subtree contains a gjc
 * process but that NO transcript-holding live session claimed. Subtree
 * membership (pane pid → descendants via the ps snapshot) is the same evidence
 * a lineage claim rests on, so tmux actions (kill/relay) remain safe for these
 * rows. Exclusion is LINEAGE names only: a cwd label is weaker evidence than
 * the subtree proof, so it must not hide a real idle gjc pane. Both rows may
 * coexist when they share a name because they represent different evidence.
 * Sorted by name for stable rendering; dedupe keeps the first pane's sid.
 */
export function findIdleGjcTmuxSessions(args: {
  panes: Array<{ name: string; tmux: TmuxPaneIdentity; pid: number; cmd?: string }>;
  /** From `ps -eo pid,ppid,args` — argv, not comm: an interpreter-launched gjc reports comm 'bun'/'node' (#1). */
  procs: Array<{ pid: number; ppid: number; args: string }>;
  excludedPaneIds: ReadonlySet<string>;
}): Array<{
  name: string;
  tmux: TmuxPaneIdentity;
  agentPid: number;
  kind: 'interactive' | 'batch' | null;
}> {
  const children = new Map<number, number[]>();
  const argsByPid = new Map<number, string>();
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid);
    if (siblings) {
      siblings.push(proc.pid);
    } else {
      children.set(proc.ppid, [proc.pid]);
    }
    argsByPid.set(proc.pid, proc.args);
  }

  const subtreeGjcPid = (rootPid: number): number | null => {
    const seen = new Set<number>();
    const queue: number[] = [rootPid];
    while (queue.length > 0 && seen.size < 4096) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (isGjcProcessArgs(argsByPid.get(pid) ?? '')) return pid;
      queue.push(...(children.get(pid) ?? []));
    }
    return null;
  };

  const idle = [];
  for (const pane of args.panes) {
    if (args.excludedPaneIds.has(pane.tmux.paneId)) {
      continue;
    }
    const agentPid = subtreeGjcPid(pane.pid);
    if (agentPid !== null) {
      idle.push({
        name: pane.name,
        tmux: pane.tmux,
        agentPid,
        kind: paneKind(pane.cmd),
      });
    }
  }
  return idle.sort((a, b) => (
    a.name.localeCompare(b.name) || a.tmux.paneId.localeCompare(b.tmux.paneId)
  ));
}

/** True when `tmux list-panes` reported at least one pane (a tmux server is up). */
export function tmuxHasPanes(output: string): boolean {
  return output.split(/\r?\n/).some((line) => line.trim().length > 0);
}

/** Parses one exact tmux pane identity plus its process metadata. */
export function parseTmuxPanes(output: string): Array<{
  name: string;
  tmux: TmuxPaneIdentity;
  pid: number;
  cmd: string;
  cwd: string;
}> {
  const panes: Array<{
    name: string;
    tmux: TmuxPaneIdentity;
    pid: number;
    cmd: string;
    cwd: string;
  }> = [];
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const fields = raw.split(TMUX_FIELD_SEP);
    if (fields.length < 8) continue;
    const [socketPath, sessionId, windowId, paneId, rawName, rawPid, rawCmd, ...cwdFields] = fields;
    const tmux = {
      socketPath: socketPath.trim(),
      sessionId: sessionId.trim(),
      windowId: windowId.trim(),
      paneId: paneId.trim(),
    };
    const name = rawName.trim();
    const pid = Number.parseInt(rawPid.trim(), 10);
    const cmd = rawCmd.trim();
    const cwd = cwdFields.join(TMUX_FIELD_SEP).trim();
    if (
      tmux.socketPath
      && /^\$\d+$/.test(tmux.sessionId)
      && /^@\d+$/.test(tmux.windowId)
      && /^%\d+$/.test(tmux.paneId)
      && name
      && Number.isFinite(pid)
      && cwd
    ) {
      panes.push({ name, tmux, pid, cmd, cwd });
    }
  }
  return panes;
}

/** Parses `lsof -F pn` output into {session-id, holder pid} pairs (path-agnostic). */
export function parseLsofPidSessions(output: string): Array<{ id: string; pid: number }> {
  const out: Array<{ id: string; pid: number }> = [];
  const seen = new Set<string>();
  let pid: number | null = null;
  for (const raw of output.split(/\r?\n/)) {
    if (raw.startsWith('p')) {
      const parsed = Number.parseInt(raw.slice(1), 10);
      pid = Number.isFinite(parsed) ? parsed : null;
      continue;
    }
    if (raw.startsWith('n') && raw.includes(SESSIONS_SEGMENT) && pid != null) {
      const match = SESSION_FILE_RE.exec(raw);
      if (match) {
        const key = `${pid}:${match[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ id: match[1], pid });
        }
      }
    }
  }
  return out;
}

/**
 * Pure match: live gjc sessions → tmux session name by PROCESS LINEAGE, so that
 * every pane maps to at most ONE session (ambiguity 0). A gjc process belongs to
 * exactly one pane's process tree, so a pane_pid in the holder's ancestor chain is
 * authoritative and CLAIMS that pane. cwd equality is a fallback used only for
 * sessions with no lineage hit, and only against panes not already claimed, and
 * only when exactly one such pane matches — otherwise null (the UI shows the
 * conversation title). Holder rows are merged by session id first (main + worker
 * processes), so either process reaching the pane resolves the name. Empty when
 * tmux is absent.
 *
 * NOTE (리뷰 판단 기록): 여러 transcript가 같은 pane lineage로 잡히는 경우
 * (main+worker, 서브에이전트 세션)는 실재하는 정상 구성이라 모두 lineage를
 * 부여한다 — 그 pane을 죽이면 실제로 전부 죽는 것이 사실이므로.
 */
export function computeLiveSessions(args: {
  tmuxPresent: boolean;
  panes: Array<{ name: string; tmux: TmuxPaneIdentity; pid: number; cwd: string; cmd?: string }>;
  sessions: Array<{
    id: string;
    pidChain: number[];
    cwd: string | null;
    process: TmuxProcessGeneration | null;
  }>;
}): Array<Pick<LiveGjcSession, 'id' | 'tmuxName' | 'tmux' | 'process' | 'claim' | 'kind'>> {
  if (!args.tmuxPresent) return [];

  const panePidToIndex = new Map<number, number>();
  args.panes.forEach((pane, index) => {
    if (!panePidToIndex.has(pane.pid)) panePidToIndex.set(pane.pid, index);
  });

  const merged = new Map<string, {
    pidChain: number[];
    cwd: string | null;
    process: TmuxProcessGeneration | null;
  }>();
  for (const session of args.sessions) {
    const existing = merged.get(session.id);
    if (!existing) {
      merged.set(session.id, {
        pidChain: [...session.pidChain],
        cwd: session.cwd,
        process: session.process,
      });
    } else {
      existing.pidChain.push(...session.pidChain);
      if (!existing.cwd) existing.cwd = session.cwd;
    }
  }

  const claimed = new Set<number>();
  const claimedSessionIds = new Set<string>();
  const result = new Map<string, {
    tmuxName: string | null;
    tmux: TmuxPaneIdentity | null;
    process: TmuxProcessGeneration | null;
    claim: 'lineage' | 'cwd' | null;
    kind: 'interactive' | 'batch' | null;
  }>();

  for (const [id, session] of merged) {
    let paneIndex: number | null = null;
    for (const pid of session.pidChain) {
      const index = panePidToIndex.get(pid);
      if (index !== undefined) {
        paneIndex = index;
        break;
      }
    }
    const pane = paneIndex === null ? null : args.panes[paneIndex];
    if (pane && paneIndex !== null) {
      claimed.add(paneIndex);
      claimedSessionIds.add(pane.tmux.sessionId);
    }
    result.set(id, {
      tmuxName: pane?.name ?? null,
      tmux: pane?.tmux ?? null,
      process: pane ? session.process : null,
      claim: pane ? 'lineage' : null,
      kind: pane ? paneKind(pane.cmd) : null,
    });
  }

  for (const [id, session] of merged) {
    if (result.get(id)?.tmuxName !== null || !session.cwd) continue;
    const candidates = args.panes
      .map((pane, index) => ({ pane, index }))
      .filter(({ pane, index }) => (
        !claimed.has(index)
        && pane.cwd === session.cwd
        && !claimedSessionIds.has(pane.tmux.sessionId)
      ));
    if (candidates.length === 1) {
      result.set(id, {
        tmuxName: candidates[0].pane.name,
        tmux: candidates[0].pane.tmux,
        process: null,
        claim: 'cwd',
        kind: null,
      });
      claimed.add(candidates[0].index);
    }
  }

  return [...result].map(([id, entry]) => ({ id, ...entry }));
}

/**
 * A tmux session proven by lineage must not ALSO surface as a cwd label-only
 * row. Cwd claims are guesses (the gjc runs elsewhere); when a lineage row from
 * any lane already covers that exact tmux pane, the cwd row is a spurious duplicate
 * of the lsof cwd row and the receipt/idle lineage row.
 * Lineage rows are never dropped — including several sharing one pane
 * (main+worker), which is a real configuration.
 */
export function dedupeLiveSessionsByLineage<T extends {
  claim: 'lineage' | 'cwd' | null;
  tmux: TmuxPaneIdentity | null;
}>(sessions: T[]): T[] {
  const lineagePaneKeys = new Set(
    sessions.flatMap((session) => (
      session.claim === 'lineage' && session.tmux
        ? [tmuxPaneIdentityKey(session.tmux)]
        : []
    )),
  );
  return sessions.filter((session) => !(
    session.claim === 'cwd'
    && session.tmux !== null
    && lineagePaneKeys.has(tmuxPaneIdentityKey(session.tmux))
  ));
}

// Detection subprocess output is small (pane lists / lsof field lines); a multi-
// megabyte stream is pathological, so terminate it instead of retaining its
// listeners and buffer after a timeout.
const RUN_COMMAND_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type LiveGjcSessionCommandRunner = (
  command: string,
  cmdArgs: string[],
  timeoutMs?: number,
) => Promise<string>;

function runCommand(command: string, cmdArgs: string[], timeoutMs = 4000): Promise<string> {
  recordHostCommand(command, cmdArgs);
  return new Promise((resolve, reject) => {
    const child = spawn(command, cmdArgs, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.stdout.removeAllListeners('data');
        child.stdout.resume(); // keep draining so the child can exit
        child.kill('SIGKILL');
        reject(error);
      }
    };
    const timer = setTimeout(() => fail(new Error(`${command} timed out`)), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > RUN_COMMAND_MAX_OUTPUT_BYTES) {
        fail(new Error(`${command} output exceeded ${RUN_COMMAND_MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      stdout += chunk.toString();
    });
    child.on('error', (error) => fail(error));
    child.on('close', () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(stdout); }
    });
  });
}

async function safeRealpath(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/** Reads the parent pid from /proc/<pid>/stat (comm may contain spaces/parens). */
async function readParentPid(pid: number): Promise<number | null> {
  try {
    recordHostCommand('read', ['proc']);
    const content = await readFile(`/proc/${pid}/stat`, 'utf8');
    const rparen = content.lastIndexOf(')');
    if (rparen < 0) {
      return null;
    }
    // After "pid (comm)" the fields are: state ppid pgrp … → index 1 is ppid.
    const fields = content.slice(rparen + 2).trim().split(/\s+/);
    const ppid = Number.parseInt(fields[1] ?? '', 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

// ── Runtime-receipt lane ─────────────────────────────────────────────────────
// gjc 0.10.2 keeps no open fd on its transcript while idle (open-append-close), so
// the lsof lane misses quiet TUI sessions. This was observed on 2026-07-14 when a
// transcript existed on disk but `lsof -c gjc` was silent, leaving only a read-only
// banner with no relay composer. gjc leaves an authoritative per-session receipt
// under the pane's cwd, rewritten on every turn event:
//   <cwd>/.gjc/_session-<id>/runtime/runtime-state.json
//     { session_id, cwd, session_file, ... }
// For a pane already PROVEN to run gjc in its subtree (the same evidence grade the
// synthetic idle rows use to permit kill/relay), an exact terminal or active-resume
// receipt can bind pane↔session. The bounded cwd/newest-receipt compatibility fallback
// additionally requires exactly one subtree-proven idle pane for that cwd, an existing
// transcript, and a receipt no older than the current gjc generation. Bare or ambiguous
// cwd equality alone never grants lineage.

export type RuntimeReceipt = {
  sessionId: string;
  cwd: string | null;
  sessionFile: string | null;
  mtimeMs: number;
};

function resolveInteractiveSessionTranscript(
  receiptFile: string,
): Pick<RuntimeReceipt, 'sessionId' | 'sessionFile'> | null {
  const directMatch = SESSION_FILE_RE.exec(receiptFile);
  if (directMatch) {
    return { sessionId: directMatch[1], sessionFile: receiptFile };
  }
  const sidecarMatch = SESSION_SIDECAR_FILE_RE.exec(receiptFile);
  if (!sidecarMatch) {
    return null;
  }
  return {
    sessionId: sidecarMatch[2],
    sessionFile: `${sidecarMatch[1]}.jsonl`,
  };
}

/**
 * Parses the pane receipt written by gjc 0.11+.
 *
 * Subagents rewrite the receipt to their sidecar transcript. ChatMux presents
 * the owning interactive session, so a sidecar path is resolved back to its
 * sibling top-level transcript instead of exposing the subagent as the pane.
 */
export function parseTerminalSessionReceipt(content: string, mtimeMs: number): RuntimeReceipt | null {
  const [cwd, receiptFile] = content.split(/\r?\n/);
  if (!cwd || !receiptFile) {
    return null;
  }
  const transcript = resolveInteractiveSessionTranscript(receiptFile);
  return transcript ? { ...transcript, cwd, mtimeMs } : null;
}

/** Pure pick: newest receipt for this pane, guarded by cwd + current agent start. */
export function pickPaneReceipt(args: {
  paneCwd: string;
  agentStartMs: number | null;
  receipts: RuntimeReceipt[];
}): RuntimeReceipt | null {
  let best: RuntimeReceipt | null = null;
  for (const receipt of args.receipts) {
    if (!receipt.sessionId || !receipt.sessionFile) {
      continue;
    }
    if (receipt.cwd !== null && receipt.cwd !== args.paneCwd) {
      continue;
    }
    // A receipt written before the current gjc agent existed belongs to an
    // earlier run in this long-lived tmux pane — never bind it after restart.
    if (args.agentStartMs !== null && receipt.mtimeMs < args.agentStartMs) {
      continue;
    }
    if (!best || receipt.mtimeMs > best.mtimeMs) {
      best = receipt;
    }
  }
  return best;
}

export function selectAuthoritativePaneReceipt(
  terminal: RuntimeReceipt | null,
  exactResume: RuntimeReceipt | null,
  heuristicFallback: RuntimeReceipt | null,
): RuntimeReceipt | null {
  return terminal ?? exactResume ?? heuristicFallback;
}

// A workspace .gjc dir accumulates one _session-* dir per session; cap the scan so
// a pathological directory cannot stall the live poll.
export const RECEIPT_ATTEMPT_LIMIT = 512;
export const RUNTIME_RECEIPT_FALLBACK_LIMIT = 511;
export const GJC_CMDLINE_MAX_BYTES = 64 * 1024;
const RUNTIME_RECEIPT_DIR_LIMIT = RECEIPT_ATTEMPT_LIMIT;
const RUNTIME_RECEIPT_DIR_RE = /^_session-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_RECEIPT_READ_CONCURRENCY = 1;

/**
 * Canonical UUIDv7 session directory names sort chronologically after case
 * normalization. Validate before spending the bounded scan budget; slicing raw
 * readdir order retained old sessions and excluded the current one.
 */
export function selectRuntimeReceiptDirectories(
  entries: readonly string[],
  limit = RUNTIME_RECEIPT_DIR_LIMIT,
  excludedEntries: ReadonlySet<string> = new Set(),
): string[] {
  const excluded = new Set([...excludedEntries].map((entry) => entry.toLowerCase()));
  return entries
    .filter((entry) => RUNTIME_RECEIPT_DIR_RE.test(entry) && !excluded.has(entry.toLowerCase()))
    .sort((left, right) => {
      const normalizedLeft = left.toLowerCase();
      const normalizedRight = right.toLowerCase();
      return normalizedLeft < normalizedRight ? 1 : normalizedLeft > normalizedRight ? -1 : 0;
    })
    .slice(0, limit);
}
export function resumeSessionIdFromCmdline(cmdline: Buffer): string | null {
  const argv = cmdline.toString('utf8').split('\0');
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const candidate = value === '--resume' ? argv[index + 1] : value.startsWith('--resume=') ? value.slice(9) : null;
    if (candidate && RUNTIME_RECEIPT_DIR_RE.test(`_session-${candidate}`)) return candidate.toLowerCase();
  }
  return null;
}

type RuntimeReceiptAttempt = {
  receipt: RuntimeReceipt | null;
  attempts: 0 | 1;
  attemptedEntry: string | null;
};

export function runtimeReceiptFallbackBudget(consumedAttempts: number): number {
  return Math.min(
    RUNTIME_RECEIPT_FALLBACK_LIMIT,
    Math.max(0, RECEIPT_ATTEMPT_LIMIT - Math.max(0, consumedAttempts)),
  );
}

async function readExactResumeReceipt(
  paneCwd: string,
  agentPid: number,
  agentStartMs: number,
): Promise<RuntimeReceiptAttempt> {
  let attemptedEntry: string | null = null;
  try {
    recordHostCommand('read', ['proc']);
    const cmdlineHandle = await open(`/proc/${agentPid}/cmdline`, 'r');
    let sessionId: string | null = null;
    try {
      const argv = Buffer.allocUnsafe(GJC_CMDLINE_MAX_BYTES);
      const bytesRead = await readAt(cmdlineHandle, argv, 0);
      sessionId = resumeSessionIdFromCmdline(argv.subarray(0, bytesRead));
    } finally {
      await cmdlineHandle.close();
    }
    if (!sessionId) return { receipt: null, attempts: 0, attemptedEntry: null };
    attemptedEntry = `_session-${sessionId}`;
    const receiptPath = join(paneCwd, '.gjc', attemptedEntry, 'runtime', 'runtime-state.json');
    recordHostCommand('read', ['runtime-receipt']);
    const [content, meta] = await Promise.all([readFile(receiptPath, 'utf8'), stat(receiptPath)]);
    const parsed = JSON.parse(content) as { session_id?: unknown; cwd?: unknown; session_file?: unknown };
    if (parsed.session_id !== sessionId || typeof parsed.session_file !== 'string' || meta.mtimeMs < agentStartMs) {
      return { receipt: null, attempts: 1, attemptedEntry };
    }
    const transcript = resolveInteractiveSessionTranscript(parsed.session_file);
    if (!transcript?.sessionFile || transcript.sessionId.toLowerCase() !== sessionId) {
      return { receipt: null, attempts: 1, attemptedEntry };
    }
    await stat(transcript.sessionFile);
    const receiptCwd = typeof parsed.cwd === 'string' ? ((await safeRealpath(parsed.cwd)) ?? parsed.cwd) : null;
    if (
      (receiptCwd !== null && receiptCwd !== paneCwd)
      || (await processStartMs(agentPid)) !== agentStartMs
    ) {
      return { receipt: null, attempts: 1, attemptedEntry };
    }
    return {
      receipt: {
        sessionId: transcript.sessionId,
        sessionFile: transcript.sessionFile,
        cwd: receiptCwd,
        mtimeMs: meta.mtimeMs,
      },
      attempts: 1,
      attemptedEntry,
    };
  } catch {
    return {
      receipt: null,
      attempts: attemptedEntry === null ? 0 : 1,
      attemptedEntry,
    };
  }
}

/** Reads all parseable session receipts under `<paneCwd>/.gjc` (missing dir → []). */
async function readPaneRuntimeReceipts(
  paneCwd: string,
  limit: number,
  excludedEntries: ReadonlySet<string>,
): Promise<RuntimeReceipt[]> {
  let entries: string[];
  try {
    entries = await readdir(`${paneCwd}/.gjc`);
  } catch {
    return [];
  }
  const candidates = selectRuntimeReceiptDirectories(entries, limit, excludedEntries);
  const receipts: RuntimeReceipt[] = [];
  for (let offset = 0; offset < candidates.length; offset += RUNTIME_RECEIPT_READ_CONCURRENCY) {
    const batch = await Promise.all(
      candidates
        .slice(offset, offset + RUNTIME_RECEIPT_READ_CONCURRENCY)
        .map(async (entry): Promise<RuntimeReceipt | null> => {
          const statePath = `${paneCwd}/.gjc/${entry}/runtime/runtime-state.json`;
          try {
            recordHostCommand('read', ['runtime-receipt']);
            const [content, meta] = await Promise.all([readFile(statePath, 'utf8'), stat(statePath)]);
            const parsed = JSON.parse(content) as { session_id?: unknown; cwd?: unknown; session_file?: unknown };
            const receiptFile = typeof parsed.session_file === 'string' ? parsed.session_file : null;
            const transcript = receiptFile ? resolveInteractiveSessionTranscript(receiptFile) : null;
            const sessionFile = transcript?.sessionFile ?? receiptFile;
            if (sessionFile !== null) {
              await stat(sessionFile); // the transcript must exist — throws (→ skip) otherwise
            }
            return {
              sessionId: transcript?.sessionId ?? (
                typeof parsed.session_id === 'string' ? parsed.session_id : ''
              ),
              cwd: typeof parsed.cwd === 'string' ? ((await safeRealpath(parsed.cwd)) ?? parsed.cwd) : null,
              sessionFile,
              mtimeMs: meta.mtimeMs,
            };
          } catch {
            return null;
          }
        }),
    );
    receipts.push(...batch.filter((receipt): receipt is RuntimeReceipt => receipt !== null));
  }
  return receipts;
}

/** Reads gjc 0.11+'s pane-specific `terminal-sessions/tmux-%N` receipt. */
async function readPaneTerminalReceipt(panePid: number): Promise<RuntimeReceiptAttempt> {
  let attempted = false;
  try {
    recordHostCommand('read', ['proc']);
    const environment = await readFile(`/proc/${panePid}/environ`, 'utf8');
    const paneValue = environment
      .split('\0')
      .find((entry) => entry.startsWith('TMUX_PANE='))
      ?.slice('TMUX_PANE='.length);
    if (!paneValue || !/^%\d+$/.test(paneValue)) {
      return { receipt: null, attempts: 0, attemptedEntry: null };
    }
    const receiptPath = join(homedir(), '.gjc', 'agent', 'terminal-sessions', `tmux-${paneValue}`);
    attempted = true;
    recordHostCommand('read', ['runtime-receipt']);
    const [content, meta] = await Promise.all([readFile(receiptPath, 'utf8'), stat(receiptPath)]);
    const receipt = parseTerminalSessionReceipt(content, meta.mtimeMs);
    if (!receipt?.sessionFile) {
      return { receipt: null, attempts: 1, attemptedEntry: null };
    }
    await stat(receipt.sessionFile);
    return {
      receipt: {
        ...receipt,
        cwd: receipt.cwd ? ((await safeRealpath(receipt.cwd)) ?? receipt.cwd) : null,
      },
      attempts: 1,
      attemptedEntry: null,
    };
  } catch {
    return { receipt: null, attempts: attempted ? 1 : 0, attemptedEntry: null };
  }
}

/** /proc/<pid> dir mtime ≈ process start — the cheap stale-receipt floor. */
async function processStartMs(pid: number): Promise<number | null> {
  try {
    return (await stat(`/proc/${pid}`)).mtimeMs;
  } catch {
    return null;
  }
}

/** Walks the ancestor pid chain [pid, ppid, …] toward init (depth/cycle guarded). */
async function buildPidChain(pid: number): Promise<number[]> {
  const chain: number[] = [];
  const seen = new Set<number>();
  let cur = pid;
  for (let i = 0; i < 64 && cur > 1 && !seen.has(cur); i += 1) {
    chain.push(cur);
    seen.add(cur);
    const parent = await readParentPid(cur);
    if (parent == null) {
      break;
    }
    cur = parent;
  }
  return chain;
}

/** Maps session id → transcript path from lsof `n` lines (first path wins). */
export function extractSessionPathsFromLsof(output: string): Map<string, string> {
  const paths = new Map<string, string>();
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.startsWith('n') || !raw.includes(SESSIONS_SEGMENT)) {
      continue;
    }
    const match = SESSION_FILE_RE.exec(raw);
    if (match && !paths.has(match[1])) {
      paths.set(match[1], raw.slice(1));
    }
  }
  return paths;
}

export type GjcSessionPreferences = {
  model: string | null;
  effort: string | null;
};

/** Latest model and reasoning-effort changes in transcript text. */
export function parseLastSessionPreferences(tailText: string): GjcSessionPreferences {
  const lines = tailText.split(/\r?\n/);
  let model: string | null = null;
  let effort: string | null = null;
  for (let i = lines.length - 1; i >= 0 && (!model || !effort); i -= 1) {
    if (!lines[i].includes('"model_change"')
      && !lines[i].includes('"thinking_level_change"')
      && !lines[i].includes('"configured_model_chain"')
      && !lines[i].includes('"thinkingLevel"')) {
      continue;
    }
    try {
      const entry = JSON.parse(lines[i]) as {
        type?: unknown;
        model?: unknown;
        thinkingLevel?: unknown;
        entries?: unknown;
      };
      if (!model && entry.type === 'model_change' && typeof entry.model === 'string' && entry.model) {
        model = entry.model;
      }
      if (!effort
        && (entry.type === 'thinking_level_change' || entry.type === 'session')
        && typeof entry.thinkingLevel === 'string'
        && entry.thinkingLevel
        && entry.thinkingLevel !== 'inherit') {
        effort = entry.thinkingLevel;
      }
      if (!effort && entry.type === 'configured_model_chain' && Array.isArray(entry.entries)) {
        const configured = entry.entries.find((value): value is string => typeof value === 'string');
        const separator = configured?.lastIndexOf(':') ?? -1;
        if (configured && separator >= 0 && separator < configured.length - 1) {
          effort = configured.slice(separator + 1);
        }
      }
    } catch {
      // Partial boundary line or malformed entry — keep scanning.
    }
  }
  return { model, effort };
}

/** Last `model_change` model in transcript text. */
export function parseLastModelChange(tailText: string): string | null {
  return parseLastSessionPreferences(tailText).model;
}

/**
 * Latest transcript activity (measured GJC schema), scanned backwards so the
 * last turn-relevant record decides:
 * - assistant stopReason 'stop' → ready
 * - assistant stopReason 'error' or a raw provider error record → error
 * - assistant toolUse, user, or toolResult → running
 * Returns null when the input has no relevant complete record.
 */
export type TurnActivityState = 'running' | 'ready' | 'error' | null;

function parseTurnActivityRecord(line: string): TurnActivityState {
  try {
    const record = JSON.parse(line) as {
      type?: unknown;
      message?: { role?: unknown; stopReason?: unknown };
    };
    if (record.type === 'error') {
      return 'error';
    }
    if (record.type !== 'message' || !record.message || typeof record.message !== 'object') {
      return null;
    }
    const { role, stopReason } = record.message;
    if (role === 'assistant') {
      if (stopReason === 'error') return 'error';
      return stopReason === 'stop' ? 'ready' : 'running';
    }
    if (role === 'user' || role === 'toolResult') {
      return 'running';
    }
  } catch {
    // Partial or malformed records are not turn-relevant.
  }
  return null;
}

export function parseTurnActivityState(tailText: string): TurnActivityState {
  const lines = tailText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const activity = parseTurnActivityRecord(lines[i]);
    if (activity !== null) return activity;
  }
  return null;
}

export function parseTurnActivity(tailText: string): boolean | null {
  const activity = parseTurnActivityState(tailText);
  return activity === null ? null : activity === 'running';
}

export const ACTIVITY_SCAN_CHUNK_BYTES = 64 * 1024;
export const ACTIVITY_MAX_SCAN_BYTES = 2 * 1024 * 1024;
export const ACTIVITY_MAX_RECORD_BYTES = 256 * 1024;
export const ACTIVITY_BOUNDARY_DIGEST_BYTES = 4 * 1024;
export const ACTIVITY_MAX_READ_BYTES_PER_ATTEMPT = 2_363_392;
export const ACTIVITY_MAX_RETAINED_INPUT_BYTES = 331_776;
export const TRANSCRIPT_ENRICHMENT_CONCURRENCY = 4;
export const ACTIVITY_CACHE_MAX_ENTRIES = 256;
export type ActivityReadDiagnostics = {
  bytesRead: number;
};
let activeTranscriptEnrichments = 0;
const queuedTranscriptEnrichments: Array<() => void> = [];

export async function mapTranscriptEnrichments<T, R>(
  values: readonly T[],
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  return Promise.all(values.map(async (value) => {
    if (activeTranscriptEnrichments >= TRANSCRIPT_ENRICHMENT_CONCURRENCY) {
      await new Promise<void>((resolve) => queuedTranscriptEnrichments.push(resolve));
    }
    activeTranscriptEnrichments += 1;
    try {
      return await map(value);
    } finally {
      activeTranscriptEnrichments -= 1;
      queuedTranscriptEnrichments.shift()?.();
    }
  }));
}

export type ActivityScanResult = {
  activity: TurnActivityState;
  completeEnd: number;
  decisiveStart: number | null;
  decisiveEnd: number | null;
  decisiveDigest: string | null;
  boundaryStart: number;
  boundaryEnd: number;
  boundaryDigest: string;
  /** Contiguous suffix of the requested range successfully read by this scan. */
  coveredStart: number;
  coveredEnd: number;
  bytesRead: number;
  retainedInputBytes: number;
  oversizeRecords: number;
};

type ActivityCacheEntry = {
  dev: number;
  ino: number;
  size: number;
  scannedTo: number;
  activity: TurnActivityState;
  decisiveStart: number | null;
  decisiveEnd: number | null;
  decisiveDigest: string | null;
  boundaryStart: number;
  boundaryEnd: number;
  boundaryDigest: string;
};

const activityCache = new Map<string, ActivityCacheEntry>();

function digest(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
const EMPTY_ACTIVITY_DIGEST = createHash('sha256').digest('hex');

async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  position: number,
  diagnostics?: ActivityReadDiagnostics,
): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    if (diagnostics) diagnostics.bytesRead += bytesRead;
  }
  return offset;
}

async function digestRange(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  end: number,
  buffer: Buffer,
  diagnostics?: ActivityReadDiagnostics,
): Promise<string | null> {
  if (start < 0 || end < start || buffer.length === 0) return null;
  const hash = createHash('sha256');
  let cursor = start;
  while (cursor < end) {
    const length = Math.min(buffer.length, end - cursor);
    const bytesRead = await readAt(handle, buffer.subarray(0, length), cursor, diagnostics);
    if (bytesRead !== length) return null;
    hash.update(buffer.subarray(0, length));
    cursor += length;
  }
  return hash.digest('hex');
}

/**
 * Scans one bounded range with a single handle and three fixed buffers. Records
 * larger than the scratch space are ignored through their terminating newline.
 */
export async function scanTurnActivityBackwards(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  end: number,
  diagnostics?: ActivityReadDiagnostics,
): Promise<ActivityScanResult> {
  const chunk = Buffer.allocUnsafe(ACTIVITY_SCAN_CHUNK_BYTES);
  const scratch = Buffer.allocUnsafe(ACTIVITY_MAX_RECORD_BYTES);
  let cursor = end;
  let completeEnd = start;
  let boundaryStart = start;
  let boundaryEnd = start;
  let boundaryDigest = EMPTY_ACTIVITY_DIGEST;
  let recordLength = 0;
  let discardRecord = false;
  let bytesRead = 0;
  let oversizeRecords = 0;
  let foundEnd = false;
  let coveredStart = end;

  const resetRecord = () => {
    recordLength = 0;
    discardRecord = false;
  };
  const appendSegment = (segment: Buffer) => {
    if (discardRecord || segment.length === 0) return;
    if (recordLength + segment.length > scratch.length) {
      discardRecord = true;
      oversizeRecords += 1;
      return;
    }
    segment.copy(scratch, scratch.length - recordLength - segment.length);
    recordLength += segment.length;
  };

  while (cursor > start && bytesRead < ACTIVITY_MAX_SCAN_BYTES) {
    const chunkStart = Math.max(start, cursor - Math.min(chunk.length, ACTIVITY_MAX_SCAN_BYTES - bytesRead));
    const length = cursor - chunkStart;
    const received = await readAt(handle, chunk.subarray(0, length), chunkStart, diagnostics);
    bytesRead += received;
    if (received !== length) break;
    coveredStart = chunkStart;

    let segmentEnd = length;
    for (let index = length - 1; index >= 0; index -= 1) {
      if (chunk[index] !== 0x0a) continue;
      const newlineEnd = chunkStart + index + 1;
      if (!foundEnd) {
        foundEnd = true;
        completeEnd = newlineEnd;
        boundaryStart = Math.max(start, newlineEnd - ACTIVITY_BOUNDARY_DIGEST_BYTES);
        boundaryEnd = newlineEnd;
        boundaryDigest = digest(chunk.subarray(boundaryStart - chunkStart, index + 1));
        segmentEnd = index;
        resetRecord();
        continue;
      }
      appendSegment(chunk.subarray(index + 1, segmentEnd));
      const recordStart = newlineEnd;
      const recordEnd = recordStart + recordLength;
      if (!discardRecord && recordLength > 0) {
        const record = scratch.subarray(scratch.length - recordLength);
        const activity = parseTurnActivityRecord(record.toString('utf8').replace(/\r$/, ''));
        if (activity !== null) {
          return {
            activity,
            completeEnd,
            decisiveStart: recordStart,
            decisiveEnd: recordEnd,
            decisiveDigest: digest(record),
            boundaryStart,
            boundaryEnd,
            boundaryDigest,
            coveredStart,
            coveredEnd: end,
            bytesRead,
            retainedInputBytes: chunk.length + scratch.length + ACTIVITY_BOUNDARY_DIGEST_BYTES,
            oversizeRecords,
          };
        }
      }
      resetRecord();
      segmentEnd = index;
    }
    if (foundEnd) appendSegment(chunk.subarray(0, segmentEnd));
    cursor = chunkStart;
  }

  if (foundEnd && cursor === start) {
    const recordStart = start;
    const recordEnd = recordStart + recordLength;
    if (!discardRecord && recordLength > 0) {
      const record = scratch.subarray(scratch.length - recordLength);
      const activity = parseTurnActivityRecord(record.toString('utf8').replace(/\r$/, ''));
      if (activity !== null) {
        return {
          activity,
          completeEnd,
          decisiveStart: recordStart,
          decisiveEnd: recordEnd,
          decisiveDigest: digest(record),
          boundaryStart,
          boundaryEnd,
          boundaryDigest,
          coveredStart,
          coveredEnd: end,
          bytesRead,
          retainedInputBytes: chunk.length + scratch.length + ACTIVITY_BOUNDARY_DIGEST_BYTES,
          oversizeRecords,
        };
      }
    }
  }
  return {
    activity: null,
    completeEnd,
    decisiveStart: null,
    decisiveEnd: null,
    decisiveDigest: null,
    boundaryStart,
    boundaryEnd,
    boundaryDigest,
    coveredStart,
    coveredEnd: end,
    bytesRead,
    retainedInputBytes: chunk.length + scratch.length + ACTIVITY_BOUNDARY_DIGEST_BYTES,
    oversizeRecords,
  };
}

function setActivityCache(path: string, entry: ActivityCacheEntry): void {
  activityCache.delete(path);
  activityCache.set(path, entry);
  if (activityCache.size > ACTIVITY_CACHE_MAX_ENTRIES) {
    activityCache.delete(activityCache.keys().next().value!);
  }
}

export function getActivityCacheDiagnostics(path?: string): {
  entries: number;
  containsPath?: boolean;
} {
  return {
    entries: activityCache.size,
    ...(path === undefined ? {} : { containsPath: activityCache.has(path) }),
  };
}

/** Latest turn activity from the transcript. null on any read/parse failure. */
export async function readTurnActivityFromFile(
  path: string,
  diagnostics?: ActivityReadDiagnostics,
): Promise<TurnActivityState> {
  if (diagnostics) diagnostics.bytesRead = 0;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    const identity = await handle.stat();
    const cached = activityCache.get(path);
    const boundaryBuffer = Buffer.allocUnsafe(ACTIVITY_BOUNDARY_DIGEST_BYTES);
    const identityMatches = cached !== undefined && cached.dev === identity.dev && cached.ino === identity.ino;
    const canValidate = identityMatches
      && identity.size >= cached.size
      && cached.boundaryEnd <= cached.size
      && cached.boundaryStart >= 0
      && cached.decisiveStart !== null
      && cached.decisiveEnd !== null;
    if (canValidate) {
      const decisiveDigest = await digestRange(
        handle,
        cached.decisiveStart!,
        cached.decisiveEnd!,
        boundaryBuffer,
        diagnostics,
      );
      const boundaryDigest = await digestRange(
        handle,
        cached.boundaryStart,
        cached.boundaryEnd,
        boundaryBuffer,
        diagnostics,
      );
      if (decisiveDigest === cached.decisiveDigest && boundaryDigest === cached.boundaryDigest) {
        if (identity.size === cached.size) {
          setActivityCache(path, cached);
          return cached.activity;
        }
        const scanStart = cached.scannedTo;
        const scanned = await scanTurnActivityBackwards(handle, scanStart, identity.size, diagnostics);
        // A bounded suffix scan cannot prove the previous verdict remained current
        // when an unscanned portion of this append sits before it.
        if (
          scanned.activity === null
          && (scanned.coveredStart !== scanStart || scanned.coveredEnd !== identity.size)
        ) {
          activityCache.delete(path);
          return null;
        }
        const activity = scanned.activity ?? cached.activity;
        setActivityCache(path, {
          dev: identity.dev, ino: identity.ino, size: identity.size,
          scannedTo: scanned.boundaryEnd, activity,
          decisiveStart: scanned.decisiveStart ?? cached.decisiveStart,
          decisiveEnd: scanned.decisiveEnd ?? cached.decisiveEnd,
          decisiveDigest: scanned.decisiveDigest ?? cached.decisiveDigest,
          boundaryStart: scanned.boundaryStart,
          boundaryEnd: scanned.boundaryEnd,
          boundaryDigest: scanned.boundaryDigest,
        });
        return activity;
      }
    }
    activityCache.delete(path);

    const scanStart = Math.max(0, identity.size - ACTIVITY_MAX_SCAN_BYTES);
    const scanned = await scanTurnActivityBackwards(handle, scanStart, identity.size, diagnostics);
    setActivityCache(path, {
      dev: identity.dev, ino: identity.ino, size: identity.size,
      scannedTo: scanned.boundaryEnd,
      activity: scanned.activity,
      decisiveStart: scanned.decisiveStart,
      decisiveEnd: scanned.decisiveEnd,
      decisiveDigest: scanned.decisiveDigest,
      boundaryStart: scanned.boundaryStart,
      boundaryEnd: scanned.boundaryEnd,
      boundaryDigest: scanned.boundaryDigest,
    });
    return scanned.activity;
  } catch {
    activityCache.delete(path);
    return null;
  } finally {
    await handle?.close();
  }
}

const MODEL_SCAN_WINDOW_BYTES = 512 * 1024;
const MODEL_SCAN_OVERLAP_BYTES = 2 * 1024;

/**
 * Per-transcript incremental preference cache. Model and reasoning effort
 * changes can sit near the start of a huge append-only transcript, so cold
 * reads scan backwards and later polls inspect only the appended delta.
 */
const modelCache = new Map<string, {
  scannedTo: number;
  model: string | null;
  effort: string | null;
}>();

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Reads the session's current model from the transcript. null on any failure. */
async function readLastSessionPreferencesFromFile(
  path: string,
): Promise<GjcSessionPreferences> {
  try {
    const { size } = await stat(path);
    const cached = modelCache.get(path);
    if (cached && size >= cached.scannedTo) {
      if (size === cached.scannedTo) {
        return { model: cached.model, effort: cached.effort };
      }
      // Only the appended delta. Parse up to the last COMPLETE line so a
      // mid-write entry is re-read next poll instead of being lost.
      const delta = await readRange(path, cached.scannedTo, size);
      const lastNewline = delta.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        return { model: cached.model, effort: cached.effort };
      }
      const found = parseLastSessionPreferences(
        delta.subarray(0, lastNewline + 1).toString('utf8'),
      );
      const next = {
        scannedTo: cached.scannedTo + lastNewline + 1,
        model: found.model ?? cached.model,
        effort: found.effort ?? cached.effort,
      };
      modelCache.set(path, next);
      return { model: next.model, effort: next.effort };
    }

    // Cold scan: parse only up to the last COMPLETE line, and remember that
    // boundary so a preference entry being written mid-scan is retried.
    let parseEnd = size;
    if (size > 0) {
      const tail = await readRange(path, Math.max(0, size - MODEL_SCAN_WINDOW_BYTES), size);
      const lastNewline = tail.lastIndexOf(0x0a);
      parseEnd = lastNewline < 0 ? 0 : Math.max(0, size - tail.length) + lastNewline + 1;
    }
    let model: string | null = null;
    let effort: string | null = null;
    let end = parseEnd;
    while (end > 0 && (!model || !effort)) {
      const start = Math.max(0, end - MODEL_SCAN_WINDOW_BYTES);
      const found = parseLastSessionPreferences(
        (await readRange(path, start, end)).toString('utf8'),
      );
      model ??= found.model;
      effort ??= found.effort;
      end = start === 0 ? 0 : start + MODEL_SCAN_OVERLAP_BYTES;
    }
    modelCache.set(path, { scannedTo: parseEnd, model, effort });
    return { model, effort };
  } catch {
    return { model: null, effort: null };
  }
}

/**
 * Returns live gjc sessions with their tmux session name + generation id.
 * Empty when tmux is absent. An lsof failure no longer empties the list because
 * the ps-subtree idle lane is independent; transcript-backed rows are simply
 * absent for that poll.
 *
 * Concurrent callers share one in-flight scan (single-flight): several browser
 * clients poll every 5s, and overlapping tmux/lsof/ps storms were themselves
 * causing the transient misses this lane exists to avoid.
 */
export type LiveGjcSessionsDetailedResult = {
  /** False only when tmux could not provide a pane roster. */
  ok: boolean;
  sessions: LiveGjcSession[];
  /** session id → open transcript path (server-internal; NOT for API responses). */
  transcriptPaths: Map<string, string>;
};

export type LiveGjcSessionDiscovery = {
  getLiveGjcSessions(): Promise<LiveGjcSession[]>;
  getLiveGjcSessionsDetailed(): Promise<LiveGjcSessionsDetailedResult>;
};

export type LiveGjcSessionDiscoveryOptions = {
  commandRunner?: LiveGjcSessionCommandRunner;
};

async function runDiscoveryCommand(
  commandRunner: LiveGjcSessionCommandRunner,
  command: string,
  cmdArgs: string[],
): Promise<string> {
  if (commandRunner !== runCommand) recordHostCommand(command, cmdArgs);
  return commandRunner(command, cmdArgs);
}

export function createLiveGjcSessionDiscovery(
  options: LiveGjcSessionDiscoveryOptions = {},
): LiveGjcSessionDiscovery {
  const commandRunner = options.commandRunner ?? runCommand;
  let inFlight: Promise<LiveGjcSessionsDetailedResult> | null = null;
  const scanShared = (): Promise<LiveGjcSessionsDetailedResult> => {
    if (!inFlight) {
      inFlight = scanLiveGjcSessions(commandRunner).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
  return {
    async getLiveGjcSessions() {
      return (await scanShared()).sessions;
    },
    getLiveGjcSessionsDetailed: scanShared,
  };
}

const defaultLiveGjcSessionDiscovery = createLiveGjcSessionDiscovery();

/** Compatible session-only wrapper for existing callers. */
export async function getLiveGjcSessions(): Promise<LiveGjcSession[]> {
  return defaultLiveGjcSessionDiscovery.getLiveGjcSessions();
}

/** Distinguishes a confirmed empty roster from unavailable tmux evidence. */
export async function getLiveGjcSessionsDetailed(): Promise<LiveGjcSessionsDetailedResult> {
  return defaultLiveGjcSessionDiscovery.getLiveGjcSessionsDetailed();
}

/** True when the pid holding a transcript is itself a gjc process (not e.g. this server). */
async function isGjcHolderPid(pid: number): Promise<boolean> {
  try {
    recordHostCommand('read', ['proc']);
    return isGjcCommandLine(await readFile(`/proc/${pid}/cmdline`, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Lists open files under the gjc session roots in `lsof -F pn` format. `+D`
 * aborts entirely if ANY path argument is missing, so absent roots are dropped
 * first; with no root present we fall back to the legacy comm selector.
 */
async function runLsofOverSessionRoots(
  commandRunner: LiveGjcSessionCommandRunner = runCommand,
): Promise<string> {
  const roots: string[] = [];
  for (const root of gjcSessionRoots()) {
    try {
      if ((await stat(root)).isDirectory()) {
        roots.push(root);
      }
    } catch {
      // absent root — skip so lsof +D does not abort
    }
  }
  const args = roots.length > 0
    ? ['-F', 'pn', ...roots.flatMap((root) => ['+D', root])]
    : ['-c', 'gjc', '-F', 'pn'];
  return runDiscoveryCommand(commandRunner, 'lsof', args);
}

async function scanLiveGjcSessions(
  commandRunner: LiveGjcSessionCommandRunner = runCommand,
): Promise<LiveGjcSessionsDetailedResult> {
  let tmuxOutput: string;
  try {
    tmuxOutput = await runDiscoveryCommand(commandRunner, 'tmux', ['list-panes', '-a', '-F', `#{socket_path}${TMUX_FIELD_SEP}#{session_id}${TMUX_FIELD_SEP}#{window_id}${TMUX_FIELD_SEP}#{pane_id}${TMUX_FIELD_SEP}#{session_name}${TMUX_FIELD_SEP}#{pane_pid}${TMUX_FIELD_SEP}#{pane_current_command}${TMUX_FIELD_SEP}#{pane_current_path}`]);
  } catch {
    return { ok: false, sessions: [], transcriptPaths: new Map() };
  }
  if (!tmuxHasPanes(tmuxOutput)) {
    return { ok: false, sessions: [], transcriptPaths: new Map() };
  }
  const panes: Array<{ name: string; tmux: TmuxPaneIdentity; pid: number; cwd: string; cmd: string }> = [];
  for (const pane of parseTmuxPanes(tmuxOutput)) {
    panes.push({ name: pane.name, tmux: pane.tmux, pid: pane.pid, cmd: pane.cmd, cwd: (await safeRealpath(pane.cwd)) ?? pane.cwd });
  }

  // Transcript lane (lsof). Selection is interpreter-agnostic: a gjc session is a
  // running process holding its transcript open, whether it runs as a native
  // `gjc` binary or under bun/node (comm = 'bun'/'node'). We list open files under
  // the gjc session roots, then keep only gjc-argv holders. A transient lsof
  // failure must not blank the whole fleet — the idle lane still reports panes.
  let lsofOutput = '';
  try {
    lsofOutput = await runLsofOverSessionRoots(commandRunner);
  } catch {
    lsofOutput = '';
  }
  const sessions: Array<{
    id: string;
    pidChain: number[];
    cwd: string | null;
    process: TmuxProcessGeneration | null;
  }> = [];
  for (const { id, pid } of parseLsofPidSessions(lsofOutput)) {
    // lsof over the session roots also lists non-gjc holders (e.g. this server
    // process tailing transcripts). Keep only holders whose argv is gjc itself.
    if (pid === process.pid || !(await isGjcHolderPid(pid))) {
      continue;
    }
    sessions.push({
      id,
      pidChain: await buildPidChain(pid),
      cwd: await safeRealpath(`/proc/${pid}/cwd`),
      process: await processStartMs(pid).then((startedAtMs) => (
        startedAtMs === null ? null : { pid, startedAtMs }
      )),
    });
  }

  const sessionPaths = extractSessionPathsFromLsof(lsofOutput);
  const named = computeLiveSessions({ tmuxPresent: true, panes, sessions });

  // gjc panes with no open transcript (first message pending). Best-effort:
  // a ps failure only hides idle rows, never the lsof-backed ones. Exclusion
  // is LINEAGE names only — a cwd label must not hide a subtree-proven pane.
  let idlePanes: Array<{
    name: string;
    tmux: TmuxPaneIdentity;
    agentPid: number;
    process: TmuxProcessGeneration | null;
    kind: 'interactive' | 'batch' | null;
  }> = [];
  try {
    const psOutput = await runDiscoveryCommand(commandRunner, 'ps', ['-eo', 'pid,ppid,args']);
    const discovered = findIdleGjcTmuxSessions({
      panes,
      procs: parsePsArgsTree(psOutput),
      excludedPaneIds: new Set(
        named.flatMap((session) => (
          session.claim === 'lineage' && session.tmux ? [session.tmux.paneId] : []
        )),
      ),
    });
    idlePanes = await Promise.all(discovered.map(async (idle) => {
      const startedAtMs = await processStartMs(idle.agentPid);
      return {
        ...idle,
        process: startedAtMs === null ? null : { pid: idle.agentPid, startedAtMs },
      };
    }));
  } catch {
    // ignore — the idle lane is additive
  }
  // A cwd-only receipt is not pane-specific. It is therefore usable only when
  // exactly one current subtree-proven pane can claim that cwd; a pane with an
  // unavailable process generation still makes the mapping ambiguous.
  const idlePaneCwdCounts = new Map<string, number>();
  for (const idle of idlePanes) {
    for (const pane of panes) {
      if (pane.tmux.paneId !== idle.tmux.paneId) continue;
      idlePaneCwdCounts.set(pane.cwd, (idlePaneCwdCounts.get(pane.cwd) ?? 0) + 1);
    }
  }


  // Runtime-receipt lane (gjc 0.10.2: idle gjc holds no transcript fd — see the
  // lane comment above pickPaneReceipt). Upgrade subtree-proven gjc panes, which
  // would otherwise stay synthetic idle rows, to transcript-backed lineage rows
  // via gjc's own session receipt in the pane cwd. lsof lineage always wins —
  // this lane only binds ids no lsof claim reached.
  const claimedIds = new Set(
    named.flatMap((session) => (session.tmuxName !== null ? [session.id] : [])),
  );
  const upgradedRows: typeof named = [];
  const remainingIdlePanes: typeof idlePanes = [];
  for (const idle of idlePanes) {
    if (idle.process === null) {
      // Without the active gjc generation, a receipt from an earlier run in the
      // same long-lived pane is indistinguishable. Keep the safe synthetic row.
      remainingIdlePanes.push(idle);
      continue;
    }
    let bound = false;
    for (const pane of panes.filter((candidate) => candidate.tmux.paneId === idle.tmux.paneId)) {
      const terminalAttempt = await readPaneTerminalReceipt(pane.pid);
      const terminal = terminalAttempt.receipt ? pickPaneReceipt({
        paneCwd: pane.cwd,
        agentStartMs: idle.process.startedAtMs,
        receipts: [terminalAttempt.receipt],
      }) : null;
      const exactAttempt = terminal ? {
        receipt: null,
        attempts: 0 as const,
        attemptedEntry: null,
      } : await readExactResumeReceipt(
        pane.cwd,
        idle.agentPid,
        idle.process.startedAtMs,
      );
      const fallbackLimit = runtimeReceiptFallbackBudget(
        terminalAttempt.attempts + exactAttempt.attempts,
      );
      const excludedEntries = new Set(
        exactAttempt.attemptedEntry ? [exactAttempt.attemptedEntry] : [],
      );
      const fallback = terminal || exactAttempt.receipt || fallbackLimit === 0
        || idlePaneCwdCounts.get(pane.cwd) !== 1
        ? null
        : pickPaneReceipt({
            paneCwd: pane.cwd,
            agentStartMs: idle.process.startedAtMs,
            receipts: await readPaneRuntimeReceipts(pane.cwd, fallbackLimit, excludedEntries),
          });
      const receipt = selectAuthoritativePaneReceipt(terminal, exactAttempt.receipt, fallback);
      if (!receipt || claimedIds.has(receipt.sessionId)) {
        continue;
      }
      claimedIds.add(receipt.sessionId);
      // Subtree-proven pane + gjc-authored receipt = lineage-grade evidence
      // (identical rationale to the synthetic idle rows below).
      upgradedRows.push({
        id: receipt.sessionId,
        tmuxName: idle.name,
        tmux: idle.tmux,
        process: idle.process,
        claim: 'lineage',
        kind: idle.kind,
      });
      if (receipt.sessionFile !== null) {
        sessionPaths.set(receipt.sessionId, receipt.sessionFile);
      }
      bound = true;
      break;
    }
    if (!bound) {
      remainingIdlePanes.push(idle);
    }
  }
  // An lsof row may exist claimless for the same id (holder seen, pane unresolved) —
  // the upgraded row supersedes it.
  const namedFinal = named.filter(
    (session) => !(session.tmuxName === null && upgradedRows.some((upgraded) => upgraded.id === session.id)),
  );

  // Enrich with the current model, reasoning effort, and turn activity from
  // each transcript.
  const enriched = await mapTranscriptEnrichments(
    [...namedFinal, ...upgradedRows],
    async (session) => {
      const path = sessionPaths.get(session.id);
      const preferences = path
        ? await readLastSessionPreferencesFromFile(path)
        : { model: null, effort: null };
      const activity = path ? await readTurnActivityFromFile(path) : null;
      return {
        ...session,
        model: preferences.model,
        effort: preferences.effort,
        running: activity === null ? null : activity === 'running',
        error: activity === null ? null : activity === 'error',
      };
    },
  );
  const allSessions = [
    ...enriched,
    ...remainingIdlePanes.map(({ name, tmux, process: agentProcess, kind }) => ({
      id: `${IDLE_GJC_ID_PREFIX}${name}:${tmux.paneId}`,
      tmuxName: name,
      tmux,
      process: agentProcess,
      // Subtree-proven: a gjc process runs INSIDE the pane — same evidence
      // as a lineage claim on transcript-backed rows.
      claim: 'lineage' as const,
      kind,
      model: null,
      effort: null,
      running: null,
      error: null,
    })),
  ];
  return {
    ok: true,
    sessions: dedupeLiveSessionsByLineage(allSessions),
    transcriptPaths: sessionPaths,
  };
}

/** Backward-compatible id-only view (transcript-backed ids only — no synthetic idle rows). */
export async function getLiveGjcSessionIds(): Promise<string[]> {
  return (await getLiveGjcSessions())
    .filter((session) => !session.id.startsWith(IDLE_GJC_ID_PREFIX))
    .map((session) => session.id);
}
