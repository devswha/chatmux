import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readlink, stat, realpath } from 'node:fs/promises';

import Database from 'better-sqlite3';

import { processStartMs } from '../process-start-time.service.js';
import { tmuxPaneIdentityKey } from '../../../../../shared/tmux.js';

import type { CodexThreadObservationState, ExternalCliSession, ExternalPane, FreshCodexProcess, FreshCodexThread, OpenCodexThread, ProcessTreeEntry } from './contracts-and-resume.js';
import { CODEX_THREAD_ID_RE, MAX_RUNTIME_DESCRIPTORS, assignFreshCodexThreadIds, externalSessionInferenceKey, extractCodexThreadIdFromRolloutPath } from './contracts-and-resume.js';
import { descendants, isCodexRuntimeProcess, selectPrimaryCodexProcessPid } from './process-classification.js';
import { isCodexMainThreadMetadata, selectObservedCodexThread } from './session-correlation.js';





export function readFreshCodexThreads(minCreatedAtMs: number): FreshCodexThread[] {
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

export async function inferFreshCodexThreadIds(args: {
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

export async function readOpenCodexThreads(
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

export const observedCodexThreadsByTarget = new Map<string, CodexThreadObservationState>();

/**
 * Reads the rollout files held open by every live Codex process. This is
 * independent of process age and continues to follow in-TUI `/new` and
 * `/resume` transitions.
 */
export async function inferOpenCodexThreadIds(args: {
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
