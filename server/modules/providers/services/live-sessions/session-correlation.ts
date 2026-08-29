import { realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { recordHostCommand } from '../host-command-metrics.service.js';
import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../../shared/tmux.js';
import { tmuxPaneIdentityKey } from '../../../../../shared/tmux.js';

import { SESSION_FILE_RE, SESSION_SIDECAR_FILE_RE, paneKind } from './process-parsing.js';
import type { LiveGjcSession } from './process-parsing.js';

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
export const RUN_COMMAND_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type LiveGjcSessionCommandRunner = (
  command: string,
  cmdArgs: string[],
  timeoutMs?: number,
) => Promise<string>;

export function runCommand(command: string, cmdArgs: string[], timeoutMs = 4000): Promise<string> {
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

export async function safeRealpath(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

// ── Runtime-receipt lane ─────────────────────────────────────────────────────
// gjc 0.10.2 keeps no open fd on its transcript while idle (open-append-close), so
// descriptor inspection misses quiet TUI sessions. This was observed on 2026-07-14
// when a transcript existed on disk but no fd stayed open, leaving only a read-only
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

export function resolveInteractiveSessionTranscript(
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
export const RECEIPT_ATTEMPT_LIMIT = 18;

export const RUNTIME_RECEIPT_FALLBACK_LIMIT = 16;

export const GJC_CMDLINE_MAX_BYTES = 64 * 1024;
