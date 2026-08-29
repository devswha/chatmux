import { parseHostDiscoveryPanes, parseHostDiscoveryProcesses } from '../host-discovery-snapshot.service.js';
import { tmuxPaneIdentityKey } from '../../../../../shared/tmux.js';

import type { CodexThreadObservationState, ExternalCliSession, ExternalLocalCliKind, ExternalPane, FreshIndexedProviderSession, OpenCodexThread, ProcessTreeEntry } from './contracts-and-resume.js';

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
    ...(pane.taggedKind && ['claude', 'codex', 'cursor', 'opencode', 'omp', 'omo'].includes(pane.taggedKind)
      ? { taggedKind: pane.taggedKind as ExternalLocalCliKind }
      : {}),
    ...(pane.taggedSessionId ? { taggedSessionId: pane.taggedSessionId } : {}),
  }));
}

/** Parses `ps -eo pid,ppid,comm[,args]` output (header tolerated). */
export function parsePsTree(output: string): ProcessTreeEntry[] {
  return parseHostDiscoveryProcesses(output);
}
