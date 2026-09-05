import { relative, sep, isAbsolute } from 'node:path';

import type { ProviderConnectionIssue } from '../../../../../shared/provider-connection.js';
import type { TmuxPaneIdentity } from '../../../../../shared/tmux.js';
import { tmuxPaneIdentityKey } from '../../../../../shared/tmux.js';

/**
 * Discovers every tmux pane. GJC keeps its dedicated live lane; Claude,
 * Codex, Cursor, OpenCode, and Oh My Pi are surfaced with native transcript
 * ids when they can be proven. SSH and shell panes (including owner-configured
 * custom CLIs with observed process metadata) stay terminal-only; they have no
 * provider-native identity or control integration.
 */

export const TMUX_FIELD_SEP = '\t';

export const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CODEX_RESUME_THREAD_RE = /(?:^|\s)resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i;

export const CLAUDE_RESUME_SESSION_RE = /(?:^|\s)--resume(?:=|\s+)([0-9a-f]{8}-[0-9a-f-]{27,})(?=\s|$)/i;

export const CURSOR_RESUME_SESSION_RE = /(?:^|\s)(?:--resume|resume)(?:=|\s+)([A-Za-z0-9_-]{8,128})(?=\s|$)/;

export const OPENCODE_SESSION_RE = /(?:^|\s)--session(?:=|\s+)([A-Za-z0-9_-]{8,128})(?=\s|$)/;

// Oh My Pi and omo are both pi-derived and accept the identical `--resume|-r` form.
export const PI_RESUME_SESSION_RE = /(?:^|\s)(?:--resume|-r)(?:=|\s+)([A-Za-z0-9_-]{8,128})(?=\s|$)/;

// omo's canonical continuation flag is `--session-id <id>` (its `--resume` takes
// no value and opens a picker, so no id ever appears in argv for that form).
// ChatMux itself resumes omo with `--session-id` in `server/pi-cli.ts`, so a
// pane started that way must link back to its transcript session.
export const OMO_SESSION_ID_RE = /(?:^|\s)--session-id(?:=|\s+)([A-Za-z0-9_-]{8,128})(?=\s|$)/;

export const TRANSCRIPT_FILE_SESSION_ID_RE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export const CODEX_ROLLOUT_FILE_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export const MAX_RUNTIME_DESCRIPTORS = 2_048;

export type ExternalLocalCliKind = 'claude' | 'codex' | 'cursor' | 'opencode' | 'omp' | 'omo';

export type ExternalCliKind = ExternalLocalCliKind | 'ssh' | 'shell';

/**
 * How strongly a pane's `providerSessionId` is tied to the process in it.
 *   'tagged'   — ChatMux wrote the id onto the pane when it spawned the agent.
 *   'observed' — the running process itself names the session: a resume id in
 *                its argv, a per-pid runtime receipt, or a transcript it holds
 *                open (read through /proc).
 *   'inferred' — the id was guessed from cwd plus a time window and can point
 *                at a different TUI in the same folder. Approvals and other
 *                session-addressed actions must not act on such a link; the
 *                user answers in the terminal (attach) instead.
 */
export type ExternalSessionBinding = 'tagged' | 'observed' | 'inferred';

export type ExternalCliSession = {
  tmuxName: string;
  tmux: TmuxPaneIdentity;
  kind: ExternalCliKind;
  providerSessionId?: string;
  /** Present exactly when `providerSessionId` is. */
  binding?: ExternalSessionBinding;
  cwd?: string;
  agentPid?: number;
  startedAtMs?: number;
  connectionIssue?: ProviderConnectionIssue;
};

export type ExternalCliSessionsDetailedResult = {
  ok: boolean;
  sessions: ExternalCliSession[];
};

export type ExternalCliSessionInferenceRetryBackoff = {
  attemptableSessions(sessions: ExternalCliSession[]): ExternalCliSession[];
  recordResults(
    sessions: ExternalCliSession[],
    attemptedSessions: Iterable<ExternalCliSession>,
  ): void;
};

export type ExternalCliSessionInferenceRetryBackoffOptions = {
  now?: () => number;
  retryBackoffMs?: number;
};

export function isUnresolvedExternalLocalCliSession(
  session: ExternalCliSession,
): session is ExternalCliSession & { kind: ExternalLocalCliKind } {
  return session.kind !== 'ssh'
    && session.kind !== 'shell'
    && !session.providerSessionId
    && !session.connectionIssue;
}

export function externalSessionInferenceKey(session: ExternalCliSession): string {
  return [
    tmuxPaneIdentityKey(session.tmux),
    session.kind,
    session.agentPid ?? '',
    session.startedAtMs ?? '',
  ].join('\0');
}

/**
 * Backs off failed native-id inference per fixed pane/process generation.
 * Resolved, removed, and restarted sessions discard their prior retry state.
 */
export function createExternalCliSessionInferenceRetryBackoff(
  options: ExternalCliSessionInferenceRetryBackoffOptions = {},
): ExternalCliSessionInferenceRetryBackoff {
  const now = options.now ?? Date.now;
  const requestedRetryBackoffMs = options.retryBackoffMs;
  const retryBackoffMs = typeof requestedRetryBackoffMs === 'number'
    && Number.isFinite(requestedRetryBackoffMs)
    && requestedRetryBackoffMs >= 0
    ? requestedRetryBackoffMs
    : 30_000;
  const retryAtMsByKey = new Map<string, number>();

  const reconcile = (sessions: ExternalCliSession[]): void => {
    const activeUnresolvedKeys = new Set<string>();
    for (const session of sessions) {
      if (session.kind === 'ssh' || session.kind === 'shell') continue;
      const key = externalSessionInferenceKey(session);
      if (session.providerSessionId) {
        retryAtMsByKey.delete(key);
      } else {
        activeUnresolvedKeys.add(key);
      }
    }
    for (const key of retryAtMsByKey.keys()) {
      if (!activeUnresolvedKeys.has(key)) retryAtMsByKey.delete(key);
    }
  };

  return {
    attemptableSessions(sessions) {
      reconcile(sessions);
      const currentMs = now();
      return sessions.filter((session) => {
        if (!isUnresolvedExternalLocalCliSession(session)) return false;
        return (retryAtMsByKey.get(externalSessionInferenceKey(session)) ?? 0) <= currentMs;
      });
    },
    recordResults(sessions, attemptedSessions) {
      reconcile(sessions);
      const attemptedKeys = new Set(
        [...attemptedSessions].map((session) => externalSessionInferenceKey(session)),
      );
      const retryAtMs = now() + retryBackoffMs;
      for (const session of sessions) {
        if (!isUnresolvedExternalLocalCliSession(session)) continue;
        const key = externalSessionInferenceKey(session);
        if (attemptedKeys.has(key)) retryAtMsByKey.set(key, retryAtMs);
      }
    },
  };
}

export type ExternalPane = {
  name: string;
  tmux: TmuxPaneIdentity;
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

export type FreshCodexProcess = { targetKey: string; cwd: string; startedAtMs: number };

export type FreshCodexThread = { id: string; cwd: string; createdAtMs: number };

export type OpenCodexThread = { id: string; modifiedAtMs: number };

export type CodexThreadObservationState = {
  processKey: string;
  selectedId: string | null;
  modifiedAtById: Map<string, number>;
};

export type FreshIndexedProviderSession = {
  id: string;
  kind: ExternalLocalCliKind;
  cwd: string;
  createdAtMs: number;
  updatedAtMs?: number;
  diskDiscovered: boolean;
};

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
  if (kind === 'omp') return processArgs.match(PI_RESUME_SESSION_RE)?.[1] ?? null;
  if (kind === 'omo') {
    return processArgs.match(OMO_SESSION_ID_RE)?.[1]
      ?? processArgs.match(PI_RESUME_SESSION_RE)?.[1]
      ?? null;
  }
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
      !assigned.has(process.targetKey)
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
      assigned.set(owner.targetKey, thread.id);
    }
  }
  return assigned;
}

export function extractCodexThreadIdFromRolloutPath(
  filePath: string,
  sessionsRoot: string,
): string | null {
  const normalizedPath = filePath.endsWith(' (deleted)')
    ? filePath.slice(0, -' (deleted)'.length)
    : filePath;
  const rel = relative(sessionsRoot, normalizedPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return CODEX_ROLLOUT_FILE_RE.exec(normalizedPath.split(sep).at(-1) ?? '')?.[1] ?? null;
}
