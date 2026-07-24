import { spawn } from 'node:child_process';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  tmuxPaneIdentityKey,
  type TmuxPaneIdentity,
  type TmuxProcessGeneration,
} from '../../../../shared/tmux.js';

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
   * Whether the transcript tail shows a turn in progress (assistant answering
   * or tool loop running). null = undeterminable (no transcript yet, no
   * turn-relevant record in the scan window, or a read failure) — the UI then
   * shows the plain LIVE badge. Purely presentational.
   */
  running: boolean | null;
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
 * rows. Exclusion is LINEAGE names only: a 'cwd' label is weaker evidence than
 * the subtree proof, so it must not hide a real idle gjc pane (리뷰 반영 —
 * 같은 이름의 cwd 라벨 행과 idle 행이 공존할 수 있고 그게 더 정직하다).
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
 * row. cwd claims are guesses (the gjc runs elsewhere); when a lineage row from
 * any lane already covers that exact tmux pane, the cwd row is a spurious duplicate
 * (patina 중복 — lsof cwd row + receipt/idle lineage row for one tmux session).
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
// megabyte stream means something is pathologically wrong — kill instead of
// buffering without bound (리뷰 반영: timeout 뒤에도 listener/버퍼가 남던 문제).
const RUN_COMMAND_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function runCommand(command: string, cmdArgs: string[], timeoutMs = 4000): Promise<string> {
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
// gjc 0.10.2 keeps NO open fd on its transcript while idle (open-append-close), so
// the lsof lane misses quiet TUI sessions entirely (실측 2026-07-14: gjc-app pane —
// transcript on disk, `lsof -c gjc` silent → the app fell to the read-only banner
// with no relay composer). gjc itself leaves an authoritative per-session receipt
// under the pane's cwd, rewritten on every turn event:
//   <cwd>/.gjc/_session-<id>/runtime/runtime-state.json
//     { session_id, cwd, session_file, ... }
// For a pane already PROVEN to run gjc in its subtree (the same evidence grade the
// synthetic idle rows use to permit kill/relay), the newest receipt that (a) points
// at this cwd, (b) has an existing transcript, and (c) is not older than the pane
// process binds pane↔session as a lineage claim. Bare cwd equality alone still
// never grants lineage — the patina-실사고 guard in computeLiveSessions is untouched.

export type RuntimeReceipt = {
  sessionId: string;
  cwd: string | null;
  sessionFile: string | null;
  mtimeMs: number;
};

/** Parses the two-line receipt written by gjc 0.11+ for a tmux pane. */
export function parseTerminalSessionReceipt(content: string, mtimeMs: number): RuntimeReceipt | null {
  const [cwd, sessionFile] = content.split(/\r?\n/);
  if (!cwd || !sessionFile) {
    return null;
  }
  const match = SESSION_FILE_RE.exec(sessionFile);
  if (!match) {
    return null;
  }
  return { sessionId: match[1], cwd, sessionFile, mtimeMs };
}

/** Pure pick: newest receipt for this pane, guarded by cwd match + pane-start floor. */
export function pickPaneReceipt(args: {
  paneCwd: string;
  paneStartMs: number | null;
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
    // A receipt written before the pane process existed belongs to an EARLIER
    // session in this cwd (e.g. a finished headless run) — never capture the pane.
    if (args.paneStartMs !== null && receipt.mtimeMs < args.paneStartMs) {
      continue;
    }
    if (!best || receipt.mtimeMs > best.mtimeMs) {
      best = receipt;
    }
  }
  return best;
}

// A workspace .gjc dir accumulates one _session-* dir per session; cap the scan so
// a pathological directory cannot stall the live poll.
const RUNTIME_RECEIPT_DIR_LIMIT = 512;
const RUNTIME_RECEIPT_READ_CONCURRENCY = 32;

/** Reads all parseable session receipts under `<paneCwd>/.gjc` (missing dir → []). */
async function readPaneRuntimeReceipts(paneCwd: string): Promise<RuntimeReceipt[]> {
  let entries: string[];
  try {
    entries = await readdir(`${paneCwd}/.gjc`);
  } catch {
    return [];
  }
  const candidates = entries
    .filter((entry) => entry.startsWith('_session-'))
    .slice(0, RUNTIME_RECEIPT_DIR_LIMIT);
  const receipts: RuntimeReceipt[] = [];
  for (let offset = 0; offset < candidates.length; offset += RUNTIME_RECEIPT_READ_CONCURRENCY) {
    const batch = await Promise.all(
      candidates
        .slice(offset, offset + RUNTIME_RECEIPT_READ_CONCURRENCY)
        .map(async (entry): Promise<RuntimeReceipt | null> => {
          const statePath = `${paneCwd}/.gjc/${entry}/runtime/runtime-state.json`;
          try {
            const [content, meta] = await Promise.all([readFile(statePath, 'utf8'), stat(statePath)]);
            const parsed = JSON.parse(content) as { session_id?: unknown; cwd?: unknown; session_file?: unknown };
            const sessionFile = typeof parsed.session_file === 'string' ? parsed.session_file : null;
            if (sessionFile !== null) {
              await stat(sessionFile); // the transcript must exist — throws (→ skip) otherwise
            }
            return {
              sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : '',
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
async function readPaneTerminalReceipt(panePid: number): Promise<RuntimeReceipt | null> {
  try {
    const environment = await readFile(`/proc/${panePid}/environ`, 'utf8');
    const paneValue = environment
      .split('\0')
      .find((entry) => entry.startsWith('TMUX_PANE='))
      ?.slice('TMUX_PANE='.length);
    if (!paneValue || !/^%\d+$/.test(paneValue)) {
      return null;
    }
    const receiptPath = join(homedir(), '.gjc', 'agent', 'terminal-sessions', `tmux-${paneValue}`);
    const [content, meta] = await Promise.all([readFile(receiptPath, 'utf8'), stat(receiptPath)]);
    const receipt = parseTerminalSessionReceipt(content, meta.mtimeMs);
    if (!receipt?.sessionFile) {
      return null;
    }
    await stat(receipt.sessionFile);
    return {
      ...receipt,
      cwd: receipt.cwd ? ((await safeRealpath(receipt.cwd)) ?? receipt.cwd) : null,
    };
  } catch {
    return null;
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
 * Whether a transcript tail shows a turn IN PROGRESS (실측 gjc 스키마 — the
 * same records the live turn monitor keys off). Scanned backwards; the LAST
 * turn-relevant record decides:
 * - assistant with stopReason 'stop' | 'error'  → turn finished (false)
 * - assistant with any other stopReason (toolUse) → mid-turn (true)
 * - user message → turn just requested (true)
 * - toolResult → tool loop in progress (true)
 * Returns null when the window holds no turn-relevant record (fail-safe: the
 * UI then shows the plain LIVE badge, never a wrong RUN).
 */
export function parseTurnActivity(tailText: string): boolean | null {
  const lines = tailText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"message"') || !lines[i].includes('"role"')) {
      continue;
    }
    try {
      const record = JSON.parse(lines[i]) as { type?: unknown; message?: { role?: unknown; stopReason?: unknown } };
      if (record.type !== 'message' || !record.message || typeof record.message !== 'object') {
        continue;
      }
      const { role, stopReason } = record.message;
      if (role === 'assistant') {
        return !(stopReason === 'stop' || stopReason === 'error');
      }
      if (role === 'user' || role === 'toolResult') {
        return true;
      }
    } catch {
      // partial first line of the tail window — keep scanning
    }
  }
  return null;
}

const ACTIVITY_SCAN_WINDOW_BYTES = 64 * 1024;

/**
 * Per-transcript activity cache. Transcripts are append-only, so an unchanged
 * size means an unchanged verdict; any growth re-reads only the fixed tail
 * window (turn-relevant records are dense — one window is plenty).
 */
const activityCache = new Map<string, { size: number; running: boolean | null }>();

/** Whether the session's transcript shows a turn in progress. null on any failure. */
async function readTurnActivityFromFile(path: string): Promise<boolean | null> {
  try {
    const { size } = await stat(path);
    const cached = activityCache.get(path);
    if (cached && cached.size === size) {
      return cached.running;
    }
    let running: boolean | null = null;
    if (size > 0) {
      const tail = await readRange(path, Math.max(0, size - ACTIVITY_SCAN_WINDOW_BYTES), size);
      // Only COMPLETE lines: a record being written mid-scan is re-read next poll.
      const lastNewline = tail.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        running = parseTurnActivity(tail.subarray(0, lastNewline + 1).toString('utf8'));
      }
    }
    activityCache.set(path, { size, running });
    return running;
  } catch {
    return null;
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
 * Empty when tmux is absent. lsof failure no longer empties the list — the
 * ps-subtree idle lane is independent evidence and keeps running (리뷰 반영);
 * transcript-backed rows are simply absent for that poll.
 *
 * Concurrent callers share one in-flight scan (single-flight): several browser
 * clients poll every 5s, and overlapping tmux/lsof/ps storms were themselves
 * causing the transient misses this lane exists to avoid.
 */
export type LiveGjcScanResult = {
  sessions: LiveGjcSession[];
  /** session id → open transcript path (server-internal; NOT for API responses). */
  transcriptPaths: Map<string, string>;
};

let liveScanInFlight: Promise<LiveGjcScanResult> | null = null;

function scanShared(): Promise<LiveGjcScanResult> {
  if (!liveScanInFlight) {
    liveScanInFlight = scanLiveGjcSessions().finally(() => {
      liveScanInFlight = null;
    });
  }
  return liveScanInFlight;
}

export async function getLiveGjcSessions(): Promise<LiveGjcSession[]> {
  return (await scanShared()).sessions;
}

/** Detailed view for server-internal consumers (live turn monitor) — shares the single-flight scan. */
export async function getLiveGjcSessionsDetailed(): Promise<LiveGjcScanResult> {
  return scanShared();
}

/** True when the pid holding a transcript is itself a gjc process (not e.g. this server). */
async function isGjcHolderPid(pid: number): Promise<boolean> {
  try {
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
async function runLsofOverSessionRoots(): Promise<string> {
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
  return runCommand('lsof', args);
}

async function scanLiveGjcSessions(): Promise<LiveGjcScanResult> {
  let tmuxOutput: string;
  try {
    tmuxOutput = await runCommand('tmux', ['list-panes', '-a', '-F', `#{socket_path}${TMUX_FIELD_SEP}#{session_id}${TMUX_FIELD_SEP}#{window_id}${TMUX_FIELD_SEP}#{pane_id}${TMUX_FIELD_SEP}#{session_name}${TMUX_FIELD_SEP}#{pane_pid}${TMUX_FIELD_SEP}#{pane_current_command}${TMUX_FIELD_SEP}#{pane_current_path}`]);
  } catch {
    return { sessions: [], transcriptPaths: new Map() };
  }
  if (!tmuxHasPanes(tmuxOutput)) {
    return { sessions: [], transcriptPaths: new Map() };
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
    lsofOutput = await runLsofOverSessionRoots();
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
    const psOutput = await runCommand('ps', ['-eo', 'pid,ppid,args']);
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
    let bound = false;
    for (const pane of panes.filter((candidate) => candidate.tmux.paneId === idle.tmux.paneId)) {
      const terminalReceipt = await readPaneTerminalReceipt(pane.pid);
      const receipt = pickPaneReceipt({
        paneCwd: pane.cwd,
        paneStartMs: await processStartMs(pane.pid),
        receipts: [
          ...(terminalReceipt ? [terminalReceipt] : []),
          ...await readPaneRuntimeReceipts(pane.cwd),
        ],
      });
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
  const enriched = await Promise.all(
    [...namedFinal, ...upgradedRows].map(async (session) => {
      const path = sessionPaths.get(session.id);
      const [preferences, running] = path
        ? await Promise.all([
            readLastSessionPreferencesFromFile(path),
            readTurnActivityFromFile(path),
          ])
        : [{ model: null, effort: null }, null] as const;
      return {
        ...session,
        model: preferences.model,
        effort: preferences.effort,
        running,
      };
    }),
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
    })),
  ];
  return {
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
