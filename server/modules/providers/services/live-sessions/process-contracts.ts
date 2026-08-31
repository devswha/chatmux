import { basename, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import type { ProviderConnectionIssue } from '../../../../../shared/provider-connection.js';
import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../../shared/tmux.js';

/**
 * Live gjc session detection + tmux-session naming.
 *
 * A GJC pane is discovered by process lineage, then bound to its active
 * transcript through GJC's pane-specific terminal receipt. Exact --resume
 * metadata, the active process's own file descriptors, and a small bounded
 * runtime-receipt scan are compatibility fallbacks. Every binding is checked
 * against the current process generation and real pane cwd.
 *
 * GJC creates the transcript only at the FIRST user message. Until then the
 * lineage-proven pane is surfaced as a synthetic `idle-gjc:<tmux name>` row so
 * the user can start the conversation from ChatMux.
 */

export const SESSIONS_SEGMENT = '.gjc/agent/sessions';

export const SESSION_FILE_RE = /\.gjc\/agent\/sessions\/[^/]+\/[^/]*_([0-9a-fA-F][0-9a-fA-F-]{7,})\.jsonl\b/;

export const SESSION_SIDECAR_FILE_RE = /^(.*\/\.gjc\/agent\/sessions\/[^/]+\/[^/]*_([0-9a-fA-F][0-9a-fA-F-]{7,}))\/[^/]+\.jsonl$/;

export const TMUX_FIELD_SEP = '\t';

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
  /** Deterministic reason this pane was not bound to a transcript. */
  connectionIssue?: ProviderConnectionIssue;
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
  return argv.some((token) => basename(token) === 'gjc')
    || cmdline.includes('@gajae-code/coding-agent');
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
  const entryIndex = head === 'gjc'
    ? 0
    : (head === 'bun' || head === 'node')
        && tokens.length > 1
        && (basename(tokens[1]) === 'gjc' || tokens[1].includes('@gajae-code/coding-agent'))
      ? 1
      : -1;
  if (entryIndex < 0) return false;

  // ChatMux probes GJC's native skill inventory in short-lived child
  // processes. Those utility commands never own an interactive transcript and
  // must not turn the server's own tmux pane into a live GJC row.
  return tokens[entryIndex + 1] !== 'skills';
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
export const GJC_INTERPRETER_COMMS = new Set(['bun', 'node']);

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
export function paneKind(cmd: string | null | undefined): 'interactive' | 'batch' | null {
  if (!cmd) {
    return null;
  }
  return cmd === 'gjc' || GJC_INTERPRETER_COMMS.has(cmd) ? 'interactive' : 'batch';
}
