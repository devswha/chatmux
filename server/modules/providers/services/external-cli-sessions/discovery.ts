import { homedir } from 'node:os';
import { join, relative, sep, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';

import Database from 'better-sqlite3';

import type { HostDiscoverySnapshot } from '../host-discovery-snapshot.service.js';
import type { TmuxPaneIdentity } from '../../../../../shared/tmux.js';
import { hostDiscoverySnapshotSource } from '../host-discovery-snapshot.service.js';
import { recordHostCommand } from '../host-command-metrics.service.js';

import type { CurrentTmuxPaneIdentity } from './inference-and-spawn.js';
import type { ExternalCliSession, ExternalCliSessionInferenceRetryBackoff, ExternalCliSessionsDetailedResult, ExternalLocalCliKind, ExternalPane, ProcessTreeEntry } from './contracts-and-resume.js';
import type { ExternalCliSessionCommandRunner } from './process-classification.js';
import { CODEX_THREAD_ID_RE, TMUX_FIELD_SEP, createExternalCliSessionInferenceRetryBackoff } from './contracts-and-resume.js';
import { addExternalRuntimeMetadata, applyInferredProviderSessionIds } from './provider-runtime-inference.js';
import { classifyExternalSessions, runCommand } from './process-classification.js';
import { inferExternalProviderSessionIds } from './inference-and-spawn.js';
import { parseExternalPanes, parsePsTree } from './session-correlation.js';



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
export async function runDiscoveryCommand(
  commandRunner: ExternalCliSessionCommandRunner,
  command: string,
  cmdArgs: string[],
): Promise<string> {
  if (commandRunner !== runCommand) recordHostCommand(command, cmdArgs);
  return commandRunner(command, cmdArgs);
}

export async function discoverExternalCliSessions(
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
      ...(pane.taggedKind && ['claude', 'codex', 'cursor', 'opencode', 'omp', 'omo'].includes(pane.taggedKind)
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

export const defaultExternalCliSessionDiscovery = createExternalCliSessionDiscovery({
  hostSnapshot: hostDiscoverySnapshotSource.get,
  freshHostSnapshot: hostDiscoverySnapshotSource.getFresh,
});

/** Distinguishes a confirmed empty discovery from unavailable tmux/ps evidence. */
export function getExternalCliSessionsDetailed(): Promise<ExternalCliSessionsDetailedResult> {
  return defaultExternalCliSessionDiscovery.getExternalCliSessionsDetailed();
}
