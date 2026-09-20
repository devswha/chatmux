import { homedir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { open, realpath, stat } from 'node:fs/promises';

import Database from 'better-sqlite3';

import { tmuxPaneIdentityKey } from '../../../../../shared/tmux.js';

import type { ExternalCliSession, ExternalPane, ProcessTreeEntry } from './contracts-and-resume.js';
import { CODEX_THREAD_ID_RE, externalSessionInferenceKey } from './contracts-and-resume.js';
import { descendants, isCodexRuntimeProcess, processCliKind, runCommand } from './process-classification.js';
import { readOpenCodexThreads } from './codex-runtime-inference.js';
import { isCodexMainThreadMetadata } from './session-correlation.js';

const MAX_THREADS = 32;
const MAX_ANCESTORS = 16;
const MAX_TAIL_BYTES = 1024 * 1024;
const MAX_LOG_ROWS = 256;
const ANCHOR_LENGTH = 96;
const MIN_ANCHOR_LENGTH = 64;
export const CODEX_ANCHORLESS_BINDING_RECHECK_MS = 60_000;

/** Text is evidence for display only, never a native session-binding receipt. */
export function normalizeCodexDisplayText(text: string): string {
  return text.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
}

export function codexRenderAnchor(bodies: readonly string[]): string | null {
  let rendered = '';
  let completed = '';
  for (const body of bodies) {
    if (body.startsWith('ConsolidateAgentMessage:') && body.includes('source_len=')) {
      completed = rendered;
      rendered = '';
      continue;
    }
    if (!body.startsWith('push_delta: ')) continue;
    try {
      const delta: unknown = JSON.parse(body.slice('push_delta: '.length));
      if (typeof delta !== 'string') return null;
      rendered = (rendered + normalizeCodexDisplayText(delta)).slice(-ANCHOR_LENGTH);
      completed = '';
    } catch {
      // A truncated/unrecognized delta must not bridge two unrelated messages.
      rendered = '';
    }
  }
  const anchor = rendered || completed;
  return anchor.length >= MIN_ANCHOR_LENGTH && new Set(anchor).size >= 12 ? anchor : null;
}

export function selectCodexForkByDisplay(args: {
  anchor: string;
  paneOutput: string;
  candidates: readonly { id: string; messages: readonly string[] }[];
}): string | null {
  if (args.anchor.length < MIN_ANCHOR_LENGTH || args.anchor.length > ANCHOR_LENGTH) return null;
  // /new or /resume can leave old cells in scrollback above a new welcome card.
  const output = currentCodexPaneOutput(args.paneOutput);
  if (!normalizeCodexDisplayText(output).includes(args.anchor)) return null;
  const matches = new Set(args.candidates.filter((candidate) => (
    candidate.messages.some((message) => normalizeCodexDisplayText(message).includes(args.anchor))
  )).map((candidate) => candidate.id));
  return matches.size === 1 ? [...matches][0] : null;
}

type ForkTranscript = { id: string; parentId?: string; messages: string[] };
type InitialDisplayCandidate = ForkTranscript & { cwd: string };

function currentCodexPaneOutput(paneOutput: string): string {
  const headers = [...paneOutput.matchAll(/OpenAI Codex \(v[^\n]*\)/g)];
  return paneOutput.slice(headers.at(-1)?.index ?? 0);
}

function transcriptMessageAnchor(message: string): string | null {
  const normalized = normalizeCodexDisplayText(message);
  const anchor = normalized.slice(-ANCHOR_LENGTH);
  return anchor.length >= MIN_ANCHOR_LENGTH && new Set(anchor).size >= 12 ? anchor : null;
}

/**
 * A shared app-server owns the rollout file, so a new TUI may have no
 * process-local file descriptor or `source = 'cli'` state row. The exact cwd
 * narrows the app-server candidates; render and pane text must still select a
 * single transcript before ChatMux exposes a display-only binding.
 */
export function selectInitialCodexThreadByDisplay(args: {
  cwd?: string;
  anchor?: string;
  paneOutput: string;
  candidates: readonly InitialDisplayCandidate[];
}): string | null {
  if (!args.cwd) return null;
  const candidates = args.candidates.filter((candidate) => candidate.cwd === args.cwd);
  if (args.anchor) {
    return selectCodexForkByDisplay({
      anchor: args.anchor,
      paneOutput: args.paneOutput,
      candidates,
    });
  }

  // A newly attached TUI restores transcript cells without replaying their
  // markdown-stream deltas. In that startup window, use only a long, diverse
  // assistant-message suffix visible below the newest Codex welcome card. The
  // cwd and uniqueness checks keep this a conservative display-only fallback.
  const output = normalizeCodexDisplayText(currentCodexPaneOutput(args.paneOutput));
  const matches = new Set(candidates.filter((candidate) => candidate.messages.some((message) => {
    const messageAnchor = transcriptMessageAnchor(message);
    return messageAnchor !== null && output.includes(messageAnchor);
  })).map((candidate) => candidate.id));
  return matches.size === 1 ? [...matches][0] : null;
}

type CachedTranscript = { signature: string; transcript: ForkTranscript };
type CachedForkBinding = { processKey: string; anchor?: string; selectedId: string; validatedAtMs: number };
// Bounded, server-private text cache. No prompt bodies enter logs or descriptors.
const transcriptCache = new Map<string, CachedTranscript>();
const forkBindingsByTarget = new Map<string, CachedForkBinding>();

export function canReuseCodexDisplayBinding(args: {
  previous?: Readonly<CachedForkBinding>;
  processKey: string;
  anchor?: string;
  nowMs?: number;
}): boolean {
  if (args.previous?.processKey !== args.processKey || args.previous.anchor !== args.anchor) return false;
  if (args.anchor !== undefined) return true;
  const ageMs = (args.nowMs ?? Date.now()) - args.previous.validatedAtMs;
  return ageMs >= 0 && ageMs < CODEX_ANCHORLESS_BINDING_RECHECK_MS;
}

export async function readCodexForkTranscript(path: string, expectedId: string, root: string): Promise<ForkTranscript | null> {
  try {
    const canonical = await realpath(path);
    const rel = relative(root, canonical);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    const metadata = await stat(canonical);
    if (!metadata.isFile()) return null;
    const signature = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
    const cached = transcriptCache.get(canonical);
    if (cached?.signature === signature && cached.transcript.id === expectedId) return cached.transcript;
    const handle = await open(canonical, 'r');
    let head: string;
    let tail: string;
    try {
      const header = Buffer.alloc(Math.min(metadata.size, 128 * 1024));
      const headerRead = await handle.read(header, 0, header.length, 0);
      head = header.subarray(0, headerRead.bytesRead).toString('utf8').split('\n')[0];
      const buffer = Buffer.alloc(Math.min(metadata.size, MAX_TAIL_BYTES));
      const offset = metadata.size - buffer.length;
      const result = await handle.read(buffer, 0, buffer.length, offset);
      tail = buffer.subarray(0, result.bytesRead).toString('utf8');
      if (offset > 0) tail = tail.slice(tail.indexOf('\n') + 1);
    } finally {
      await handle.close();
    }
    const record = JSON.parse(head) as { type?: string; payload?: { id?: string; forked_from_id?: string } };
    if (record.type !== 'session_meta' || record.payload?.id !== expectedId) return null;
    const parentId = record.payload.forked_from_id;
    if (parentId !== undefined && !CODEX_THREAD_ID_RE.test(parentId)) return null;
    const messages: string[] = [];
    for (const line of tail.split('\n')) {
      try {
        const item = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string; content?: { type?: string; text?: string }[]; last_agent_message?: unknown } };
        if (item.type === 'response_item' && item.payload?.type === 'message'
          && item.payload.role === 'assistant' && Array.isArray(item.payload.content)) {
          const text = item.payload.content.filter((part) => part.type === 'output_text' && typeof part.text === 'string').map((part) => part.text).join('');
          // Keep a bounded suffix; a missing/oversize anchor simply cannot bind.
          messages.push(text.slice(-8192));
          if (messages.length > 8) messages.shift();
        } else if (item.type === 'event_msg' && item.payload?.type === 'task_complete') {
          const text = item.payload.last_agent_message;
          if (typeof text === 'string' && text.trim()) {
            messages.push(text.slice(-8192));
            if (messages.length > 8) messages.shift();
          }
        }
      } catch { /* Partial appended records are retried on the next file change. */ }
    }
    const transcript = { id: expectedId, ...(parentId ? { parentId } : {}), messages };
    transcriptCache.delete(canonical);
    transcriptCache.set(canonical, { signature, transcript });
    while (transcriptCache.size > MAX_THREADS) transcriptCache.delete(transcriptCache.keys().next().value!);
    return transcript;
  } catch {
    return null;
  }
}

export function readCodexRenderAnchor(db: Database.Database, pid: number, startedAtMs: number): string | null {
  try {
    // Resolve the log process UUID first so the tail query can use exact index
    // equality. A recycled PID with conflicting generations is not evidence.
    const generations = db.prepare(`
      SELECT DISTINCT process_uuid AS id FROM logs INDEXED BY idx_logs_process_uuid_threadless_ts
      WHERE process_uuid GLOB ? AND thread_id IS NULL AND ts >= ? LIMIT 2
    `).all(`pid:${pid}:*`, Math.ceil(startedAtMs / 1000)) as { id: string }[];
    if (generations.length !== 1) return null;
    const rows = db.prepare(`
      SELECT substr(feedback_log_body, 1, 4096) AS body FROM logs
      WHERE process_uuid = ? AND thread_id IS NULL AND ts >= ?
        AND target IN ('codex_tui::markdown_stream', 'codex_tui::app::agent_message_consolidation')
      ORDER BY ts DESC, ts_nanos DESC, id DESC LIMIT ?
    `).all(generations[0].id, Math.ceil(startedAtMs / 1000), MAX_LOG_ROWS) as { body: string }[];
    return codexRenderAnchor(rows.reverse().map((row) => row.body));
  } catch { return null; }
}

export function shouldInferSharedCodexDisplay(
  session: ExternalCliSession,
  observed: ReadonlyMap<string, string>,
  attemptableTargetKeys: ReadonlySet<string>,
): boolean {
  const targetKey = tmuxPaneIdentityKey(session.tmux);
  return session.kind === 'codex'
    && !session.connectionIssue
    && session.startedAtMs !== undefined
    && !observed.has(targetKey)
    && Boolean(session.providerSessionId || attemptableTargetKeys.has(targetKey));
}

/**
 * Shared app-server Codex releases no longer keep rollouts open in the TUI.
 * Recover a *display-only* link from exact TUI render content + that pane's
 * current output. Existing sessions additionally require native fork ancestry;
 * initial sessions require an exact cwd match against app-server-owned open
 * rollouts. Do not promote either path to `observed`: text and ancestry are not
 * provider identity receipts.
 */
export async function inferSharedCodexForkIds(args: {
  sessions: ExternalCliSession[];
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
  observed: ReadonlyMap<string, string>;
  attemptableTargetKeys: ReadonlySet<string>;
}): Promise<Map<string, string>> {
  const targets = args.sessions.filter((session) => (
    shouldInferSharedCodexDisplay(session, args.observed, args.attemptableTargetKeys)
  ));
  const resolved = new Map<string, string>();
  if (!targets.length) {
    forkBindingsByTarget.clear();
    return resolved;
  }
  let state: Database.Database | undefined;
  let logs: Database.Database | undefined;
  try {
    const codexHome = join(homedir(), '.codex');
    const root = await realpath(join(codexHome, 'sessions'));
    logs = new Database(join(codexHome, 'logs_2.sqlite'), { readonly: true, fileMustExist: true, timeout: 100 });
    const children = new Map<number, number[]>();
    const byPid = new Map(args.procs.map((proc) => [proc.pid, proc]));
    for (const proc of args.procs) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid]);
    const pending: Array<{
      session: ExternalCliSession;
      pane: ExternalPane;
      key: string;
      processKey: string;
      anchor?: string;
      previous?: CachedForkBinding;
    }> = [];
    const nowMs = Date.now();
    for (const session of targets) {
      const key = tmuxPaneIdentityKey(session.tmux);
      const pane = args.panes.find((candidate) => tmuxPaneIdentityKey(candidate.tmux) === key);
      if (!pane) continue;
      const anchors = new Set<string>();
      const codexPids = descendants(pane.pid, children).filter((pid) => {
        const proc = byPid.get(pid);
        return proc ? isCodexRuntimeProcess(proc) : false;
      });
      for (const pid of codexPids) {
        const anchor = readCodexRenderAnchor(logs, pid, session.startedAtMs! - 1000);
        if (anchor) anchors.add(anchor);
      }
      if (anchors.size > 1 || (session.providerSessionId && anchors.size !== 1)) continue;
      const anchor = anchors.size === 1 ? [...anchors][0] : undefined;
      const processKey = [externalSessionInferenceKey(session), ...codexPids.sort((a, b) => a - b)].join('\0');
      const cached = forkBindingsByTarget.get(key);
      if (cached && canReuseCodexDisplayBinding({ previous: cached, processKey, anchor, nowMs })) {
        resolved.set(key, cached.selectedId);
        continue;
      }
      // An expired anchorless match must fail closed on revalidation instead of
      // keeping an old thread visible after /new in the same TUI process.
      const previous = cached?.processKey === processKey && cached.anchor !== undefined ? cached : undefined;
      pending.push({ session, pane, key, processKey, ...(anchor ? { anchor } : {}), ...(previous ? { previous } : {}) });
    }
    for (const key of forkBindingsByTarget.keys()) {
      if (!targets.some((session) => tmuxPaneIdentityKey(session.tmux) === key)) forkBindingsByTarget.delete(key);
    }
    if (!pending.length) return resolved;

    state = new Database(join(codexHome, 'state_5.sqlite'), { readonly: true, fileMustExist: true, timeout: 100 });
    const servers = args.procs.filter((proc) => processCliKind(proc) === 'codex' && /(?:^|\s)app-server(?:\s|$)/.test(proc.args ?? ''));
    if (!servers.length || servers.length > 8) return resolved;
    const openIds = new Set((await Promise.all(servers.map((proc) => readOpenCodexThreads(proc.pid, root)))).flat().map((thread) => thread.id));
    if (!openIds.size || openIds.size > MAX_THREADS) return resolved;
    type ThreadRow = {
      rollout_path: string;
      cwd: string;
      source?: string;
      thread_source?: string;
      agent_role?: string;
    };
    const readRow = state.prepare('SELECT rollout_path, cwd, source, thread_source, agent_role FROM threads WHERE id = ?');
    const threadRows = new Map<string, ThreadRow | undefined>();
    const transcripts = new Map<string, ForkTranscript | null>();
    const read = async (id: string): Promise<ForkTranscript | null> => {
      if (transcripts.has(id)) return transcripts.get(id)!;
      if (transcripts.size >= MAX_THREADS * 2) return null;
      const row = readRow.get(id) as ThreadRow | undefined;
      threadRows.set(id, row);
      const transcript = row && isCodexMainThreadMetadata(row) ? await readCodexForkTranscript(row.rollout_path, id, root) : null;
      transcripts.set(id, transcript);
      return transcript;
    };
    const initial: InitialDisplayCandidate[] = [];
    const forks: ForkTranscript[] = [];
    // Large rollouts can have large individual records; keep scratch buffers
    // sequential rather than multiplying them by the number of loaded threads.
    for (const id of openIds) {
      const transcript = await read(id);
      const row = threadRows.get(id);
      if (transcript && row?.cwd) initial.push({ ...transcript, cwd: row.cwd });
      if (transcript?.parentId) forks.push(transcript);
    }
    if (!initial.length) return resolved;
    for (const target of pending) {
      let candidates: ForkTranscript[];
      if (target.session.providerSessionId) {
        candidates = [];
        for (const fork of forks) {
          let parent = fork.parentId;
          const visited = new Set([fork.id]);
          for (let depth = 0; parent && depth < MAX_ANCESTORS && !visited.has(parent); depth += 1) {
            if (parent === target.session.providerSessionId) { candidates.push(fork); break; }
            visited.add(parent);
            parent = (await read(parent))?.parentId;
          }
        }
      } else {
        candidates = initial.filter((candidate) => candidate.cwd === target.session.cwd);
      }
      if (!candidates.length) {
        if (target.previous) resolved.set(target.key, target.previous.selectedId);
        continue;
      }
      // Most turns need no extra tmux command: first check whether any child
      // transcript even contains this process's current rendered content.
      if (target.anchor && !candidates.some((candidate) => candidate.messages.some((message) => normalizeCodexDisplayText(message).includes(target.anchor!)))) {
        if (target.previous) resolved.set(target.key, target.previous.selectedId);
        continue;
      }
      const output = await runCommand('tmux', ['-S', target.pane.tmux.socketPath, 'capture-pane', '-p', '-J', '-S', '-500', '-t', target.pane.tmux.paneId]).catch(() => '');
      const identity = await runCommand('tmux', ['-S', target.pane.tmux.socketPath, 'display-message', '-p', '-t', target.pane.tmux.paneId, '#{socket_path}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}']).catch(() => '');
      const expected = [target.pane.tmux.socketPath, target.pane.tmux.sessionId, target.pane.tmux.windowId, target.pane.tmux.paneId, target.pane.pid].join('\t');
      if (identity.trimEnd() !== expected) {
        if (target.previous) resolved.set(target.key, target.previous.selectedId);
        continue;
      }
      const paneOutput = output.slice(-131072);
      const selected = target.session.providerSessionId
        ? selectCodexForkByDisplay({ anchor: target.anchor!, paneOutput, candidates })
        : selectInitialCodexThreadByDisplay({
          cwd: target.session.cwd,
          anchor: target.anchor,
          paneOutput,
          candidates: initial,
        });
      if (selected) {
        forkBindingsByTarget.set(target.key, {
          processKey: target.processKey,
          ...(target.anchor ? { anchor: target.anchor } : {}),
          selectedId: selected,
          validatedAtMs: nowMs,
        });
        resolved.set(target.key, selected);
      } else if (target.previous) {
        resolved.set(target.key, target.previous.selectedId);
      }
    }
  } catch {
    // Optional format/schema/permission failure leaves proven legacy paths alone.
  } finally {
    logs?.close();
    state?.close();
  }
  return resolved;
}
