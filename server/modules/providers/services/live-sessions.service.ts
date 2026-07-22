import { spawn } from 'node:child_process';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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
  /**
   * tmux server-unique session id (`$N`) of the pane backing this row — a
   * GENERATION token: tmux never reuses `$N` within one server lifetime, so a
   * kill/send request carrying it cannot hit a same-named replacement session
   * created after the client's snapshot (이름 재사용 race 차단).
   */
  tmuxId: string | null;
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

// Matches live-send/tower tmux-name discipline; unsafe names get no synthetic row
// (they could not be killed/relayed anyway).
const IDLE_TMUX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  panes: Array<{ name: string; sid: string; pid: number; cmd?: string }>;
  /** From `ps -eo pid,ppid,args` — argv, not comm: an interpreter-launched gjc reports comm 'bun'/'node' (#1). */
  procs: Array<{ pid: number; ppid: number; args: string }>;
  excludedNames: ReadonlySet<string>;
}): Array<{ name: string; sid: string; kind: 'interactive' | 'batch' | null }> {
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

  const subtreeHasGjc = (rootPid: number): boolean => {
    const seen = new Set<number>();
    const queue: number[] = [rootPid];
    while (queue.length > 0 && seen.size < 4096) {
      const pid = queue.shift()!;
      if (seen.has(pid)) {
        continue;
      }
      seen.add(pid);
      if (isGjcProcessArgs(argsByPid.get(pid) ?? '')) {
        return true;
      }
      for (const child of children.get(pid) ?? []) {
        queue.push(child);
      }
    }
    return false;
  };

  const idle = new Map<string, { sid: string; cmd: string | undefined }>();
  for (const pane of args.panes) {
    if (idle.has(pane.name) || args.excludedNames.has(pane.name) || !IDLE_TMUX_NAME_RE.test(pane.name)) {
      continue;
    }
    if (subtreeHasGjc(pane.pid)) {
      idle.set(pane.name, { sid: pane.sid, cmd: pane.cmd });
    }
  }
  return [...idle]
    .map(([name, entry]) => ({ name, sid: entry.sid, kind: paneKind(entry.cmd) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** True when `tmux list-panes` reported at least one pane (a tmux server is up). */
export function tmuxHasPanes(output: string): boolean {
  return output.split(/\r?\n/).some((line) => line.trim().length > 0);
}

/** Parses `#{session_name}\t#{session_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}` into {name, sid, pid, cmd, cwd}. */
export function parseTmuxPanes(output: string): Array<{ name: string; sid: string; pid: number; cmd: string; cwd: string }> {
  const panes: Array<{ name: string; sid: string; pid: number; cmd: string; cwd: string }> = [];
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim()) {
      continue;
    }
    const first = raw.indexOf(TMUX_FIELD_SEP);
    const second = raw.indexOf(TMUX_FIELD_SEP, first + 1);
    const third = raw.indexOf(TMUX_FIELD_SEP, second + 1);
    const fourth = raw.indexOf(TMUX_FIELD_SEP, third + 1);
    if (first < 0 || second < 0 || third < 0 || fourth < 0) {
      continue;
    }
    const name = raw.slice(0, first).trim();
    const sid = raw.slice(first + 1, second).trim();
    const pid = Number.parseInt(raw.slice(second + 1, third).trim(), 10);
    // pane_current_command is a process name (no spaces); pane_current_path is
    // LAST so a path with spaces survives (only a tab in a path could split it).
    const cmd = raw.slice(third + 1, fourth).trim();
    const cwd = raw.slice(fourth + 1).trim();
    // tmux session ids are `$<number>` — anything else means a format drift we
    // must not feed into the generation-token contract.
    if (name && /^\$\d+$/.test(sid) && Number.isFinite(pid) && cwd) {
      panes.push({ name, sid, pid, cmd, cwd });
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
  panes: Array<{ name: string; sid: string; pid: number; cwd: string; cmd?: string }>;
  sessions: Array<{ id: string; pidChain: number[]; cwd: string | null }>;
}): Array<Pick<LiveGjcSession, 'id' | 'tmuxName' | 'tmuxId' | 'claim' | 'kind'>> {
  if (!args.tmuxPresent) {
    return [];
  }
  const panePidToIndex = new Map<number, number>();
  args.panes.forEach((pane, index) => {
    if (!panePidToIndex.has(pane.pid)) {
      panePidToIndex.set(pane.pid, index);
    }
  });

  // Merge holder rows into one entry per session id (a session may have several
  // open-file holders); union their pid chains, keep the first resolved cwd.
  const merged = new Map<string, { pidChain: number[]; cwd: string | null }>();
  for (const session of args.sessions) {
    const existing = merged.get(session.id);
    if (!existing) {
      merged.set(session.id, { pidChain: [...session.pidChain], cwd: session.cwd });
    } else {
      existing.pidChain.push(...session.pidChain);
      if (!existing.cwd) {
        existing.cwd = session.cwd;
      }
    }
  }

  const claimed = new Set<number>();
  // tmux session ids already proven by a lineage claim. A cwd fallback must not
  // attach a second row to a sibling pane of an already-claimed session — that
  // produced duplicate rows for one tmux session (patina 중복 관찰) and, worse,
  // mislabeled an unrelated session onto that pane (실사고).
  const claimedSids = new Set<string>();
  const result = new Map<string, { tmuxName: string | null; tmuxId: string | null; claim: 'lineage' | 'cwd' | null; kind: 'interactive' | 'batch' | null }>();

  // Pass 1: lineage matches claim their pane (authoritative, run for ALL sessions
  // before any cwd fallback so claims are complete).
  for (const [id, session] of merged) {
    let name: string | null = null;
    let sid: string | null = null;
    let cmd: string | undefined;
    for (const pid of session.pidChain) {
      const index = panePidToIndex.get(pid);
      if (index !== undefined) {
        name = args.panes[index].name;
        sid = args.panes[index].sid;
        cmd = args.panes[index].cmd;
        claimed.add(index);
        claimedSids.add(args.panes[index].sid);
        break;
      }
    }
    result.set(id, {
      tmuxName: name,
      tmuxId: sid,
      claim: name !== null ? 'lineage' : null,
      // Lineage pane KNOWN to hold this gjc → classify by its foreground cmd.
      kind: name !== null ? paneKind(cmd) : null,
    });
  }

  // Pass 2: cwd fallback to an UNCLAIMED pane, only when the match is unique.
  for (const [id, session] of merged) {
    if (result.get(id)?.tmuxName !== null || !session.cwd) {
      continue;
    }
    const candidates = args.panes
      .map((pane, index) => ({ pane, index }))
      .filter(({ pane, index }) => !claimed.has(index) && pane.cwd === session.cwd && !claimedSids.has(pane.sid));
    if (candidates.length === 1) {
      // A cwd match only LABELS the row: the gjc process is NOT inside the
      // pane, so tmux-session actions (kill/relay) must never key off it —
      // 실사고: patina의 백그라운드 gjc 행을 닫자 무관한 claude tmux가 죽음.
      // cwd = label-only (gjc runs elsewhere), so the pane's foreground command
      // says nothing about this session → kind stays null.
      result.set(id, { tmuxName: candidates[0].pane.name, tmuxId: candidates[0].pane.sid, claim: 'cwd', kind: null });
      claimed.add(candidates[0].index);
    }
  }

  return [...result].map(([id, entry]) => ({ id, tmuxName: entry.tmuxName, tmuxId: entry.tmuxId, claim: entry.claim, kind: entry.kind }));
}

/**
 * A tmux session proven by lineage must not ALSO surface as a cwd label-only
 * row. cwd claims are guesses (the gjc runs elsewhere); when a lineage row from
 * any lane already covers that tmuxId, the cwd row is a spurious duplicate
 * (patina 중복 — lsof cwd row + receipt/idle lineage row for one tmux session).
 * Lineage rows are never dropped — including several sharing one pane
 * (main+worker), which is a real configuration.
 */
export function dedupeLiveSessionsByLineage<T extends { claim: 'lineage' | 'cwd' | null; tmuxId: string | null }>(
  sessions: T[],
): T[] {
  const lineageTmuxIds = new Set(
    sessions.flatMap((session) => (session.claim === 'lineage' && session.tmuxId ? [session.tmuxId] : [])),
  );
  return sessions.filter(
    (session) => !(session.claim === 'cwd' && session.tmuxId !== null && lineageTmuxIds.has(session.tmuxId)),
  );
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

/** Reads all parseable session receipts under `<paneCwd>/.gjc` (missing dir → []). */
async function readPaneRuntimeReceipts(paneCwd: string): Promise<RuntimeReceipt[]> {
  let entries: string[];
  try {
    entries = await readdir(`${paneCwd}/.gjc`);
  } catch {
    return [];
  }
  const receipts: RuntimeReceipt[] = [];
  for (const entry of entries.slice(0, RUNTIME_RECEIPT_DIR_LIMIT)) {
    if (!entry.startsWith('_session-')) {
      continue;
    }
    const statePath = `${paneCwd}/.gjc/${entry}/runtime/runtime-state.json`;
    try {
      const [content, meta] = await Promise.all([readFile(statePath, 'utf8'), stat(statePath)]);
      const parsed = JSON.parse(content) as { session_id?: unknown; cwd?: unknown; session_file?: unknown };
      const sessionFile = typeof parsed.session_file === 'string' ? parsed.session_file : null;
      if (sessionFile !== null) {
        await stat(sessionFile); // the transcript must exist — throws (→ skip) otherwise
      }
      receipts.push({
        sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : '',
        cwd: typeof parsed.cwd === 'string' ? ((await safeRealpath(parsed.cwd)) ?? parsed.cwd) : null,
        sessionFile,
        mtimeMs: meta.mtimeMs,
      });
    } catch {
      // unreadable/corrupt receipt or missing transcript — skip this candidate
    }
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

/** Last `model_change` model in a transcript tail (NDJSON lines, scanned backwards). */
export function parseLastModelChange(tailText: string): string | null {
  const lines = tailText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"model_change"')) {
      continue;
    }
    try {
      const entry = JSON.parse(lines[i]) as { type?: unknown; model?: unknown };
      if (entry.type === 'model_change' && typeof entry.model === 'string' && entry.model) {
        return entry.model;
      }
    } catch {
      // partial first line of the tail window — keep scanning
    }
  }
  return null;
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
 * Per-transcript incremental model cache. A session's model_change usually sits
 * near the START of a (potentially huge, append-only) transcript, so a fixed
 * tail read misses it. First sight does a windowed BACKWARD scan (with a small
 * overlap so a line split across windows is still seen); afterwards only the
 * appended delta is read per poll. A shrunken/rotated file triggers a rescan.
 */
const modelCache = new Map<string, { scannedTo: number; model: string | null }>();

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
async function readLastModelFromFile(path: string): Promise<string | null> {
  try {
    const { size } = await stat(path);
    const cached = modelCache.get(path);
    if (cached && size >= cached.scannedTo) {
      if (size === cached.scannedTo) {
        return cached.model;
      }
      // Only the appended delta. Parse up to the last COMPLETE line so a
      // mid-write entry is re-read next poll instead of being lost.
      const delta = await readRange(path, cached.scannedTo, size);
      const lastNewline = delta.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        return cached.model;
      }
      const found = parseLastModelChange(delta.subarray(0, lastNewline + 1).toString('utf8'));
      const next = { scannedTo: cached.scannedTo + lastNewline + 1, model: found ?? cached.model };
      modelCache.set(path, next);
      return next.model;
    }

    // Cold scan: parse only up to the last COMPLETE line, and remember that
    // boundary — otherwise a model_change being written mid-scan would land in
    // the skipped partial tail and never be re-read (리뷰 지적 반영).
    let parseEnd = size;
    if (size > 0) {
      const tail = await readRange(path, Math.max(0, size - MODEL_SCAN_WINDOW_BYTES), size);
      const lastNewline = tail.lastIndexOf(0x0a);
      parseEnd = lastNewline < 0 ? 0 : Math.max(0, size - tail.length) + lastNewline + 1;
    }
    let model: string | null = null;
    let end = parseEnd;
    while (end > 0 && model === null) {
      const start = Math.max(0, end - MODEL_SCAN_WINDOW_BYTES);
      model = parseLastModelChange((await readRange(path, start, end)).toString('utf8'));
      end = start === 0 ? 0 : start + MODEL_SCAN_OVERLAP_BYTES;
    }
    modelCache.set(path, { scannedTo: parseEnd, model });
    return model;
  } catch {
    return null;
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
    tmuxOutput = await runCommand('tmux', ['list-panes', '-a', '-F', `#{session_name}${TMUX_FIELD_SEP}#{session_id}${TMUX_FIELD_SEP}#{pane_pid}${TMUX_FIELD_SEP}#{pane_current_command}${TMUX_FIELD_SEP}#{pane_current_path}`]);
  } catch {
    return { sessions: [], transcriptPaths: new Map() };
  }
  if (!tmuxHasPanes(tmuxOutput)) {
    return { sessions: [], transcriptPaths: new Map() };
  }
  const panes: Array<{ name: string; sid: string; pid: number; cwd: string; cmd: string }> = [];
  for (const pane of parseTmuxPanes(tmuxOutput)) {
    panes.push({ name: pane.name, sid: pane.sid, pid: pane.pid, cmd: pane.cmd, cwd: (await safeRealpath(pane.cwd)) ?? pane.cwd });
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
  const sessions: Array<{ id: string; pidChain: number[]; cwd: string | null }> = [];
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
    });
  }

  const sessionPaths = extractSessionPathsFromLsof(lsofOutput);
  const named = computeLiveSessions({ tmuxPresent: true, panes, sessions });

  // gjc panes with no open transcript (first message pending). Best-effort:
  // a ps failure only hides idle rows, never the lsof-backed ones. Exclusion
  // is LINEAGE names only — a cwd label must not hide a subtree-proven pane.
  let idlePanes: Array<{ name: string; sid: string; kind: 'interactive' | 'batch' | null }> = [];
  try {
    const psOutput = await runCommand('ps', ['-eo', 'pid,ppid,args']);
    idlePanes = findIdleGjcTmuxSessions({
      panes,
      procs: parsePsArgsTree(psOutput),
      excludedNames: new Set(
        named.flatMap((session) => (session.claim === 'lineage' && session.tmuxName ? [session.tmuxName] : [])),
      ),
    });
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
    for (const pane of panes.filter((candidate) => candidate.sid === idle.sid)) {
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
      upgradedRows.push({ id: receipt.sessionId, tmuxName: idle.name, tmuxId: idle.sid, claim: 'lineage', kind: idle.kind });
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

  // Enrich with the current model (last model_change) and turn activity
  // (running vs waiting) from the transcript tail.
  const enriched = await Promise.all(
    [...namedFinal, ...upgradedRows].map(async (session) => {
      const path = sessionPaths.get(session.id);
      return {
        ...session,
        model: path ? await readLastModelFromFile(path) : null,
        running: path ? await readTurnActivityFromFile(path) : null,
      };
    }),
  );
  const allSessions = [
    ...enriched,
    ...remainingIdlePanes.map(({ name, sid, kind }) => ({
      id: `${IDLE_GJC_ID_PREFIX}${name}`,
      tmuxName: name,
      tmuxId: sid,
      // Subtree-proven: a gjc process runs INSIDE the pane — same evidence
      // grade as a lineage claim, so kill/relay stay permitted and safe.
      claim: 'lineage' as const,
      kind,
      model: null,
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
