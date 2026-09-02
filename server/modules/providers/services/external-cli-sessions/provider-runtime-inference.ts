import { homedir } from 'node:os';
import { join, relative, sep, isAbsolute } from 'node:path';
import { readFile, realpath, readdir } from 'node:fs/promises';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsDb } from '@/modules/database/index.js';

import { processStartMs } from '../process-start-time.service.js';
import { tmuxPaneIdentityKey } from '../../../../../shared/tmux.js';
import { validateLocalAgentContext } from '../local-agent-context.service.js';

import { descendants, isClaudeRuntimeProcess, parseClaudeRuntimeSession } from './process-classification.js';
import { assignFreshIndexedProviderSessionIds, assignUniqueIndexedProviderSessionIds } from './session-correlation.js';
import { MAX_RUNTIME_DESCRIPTORS, TRANSCRIPT_FILE_SESSION_ID_RE } from './contracts-and-resume.js';
import type { ExternalCliSession, ExternalPane, ExternalSessionBinding, FreshIndexedProviderSession, ProcessTreeEntry } from './contracts-and-resume.js';

export async function inferClaudeSessionIds(args: {
  sessions: ExternalCliSession[];
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
}): Promise<Map<string, string>> {
  const claudeTargets = new Set(
    args.sessions
      .filter((session) => session.kind === 'claude')
      .map((session) => tmuxPaneIdentityKey(session.tmux)),
  );
  if (claudeTargets.size === 0) return new Map();

  const children = new Map<number, number[]>();
  const procByPid = new Map(args.procs.map((proc) => [proc.pid, proc]));
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid) ?? [];
    siblings.push(proc.pid);
    children.set(proc.ppid, siblings);
  }

  const candidates = new Map<string, Map<number, string>>();
  for (const pane of args.panes) {
    const targetKey = tmuxPaneIdentityKey(pane.tmux);
    if (!claudeTargets.has(targetKey) || !pane.cwd) continue;
    for (const pid of descendants(pane.pid, children)) {
      const proc = procByPid.get(pid);
      if (!proc || !isClaudeRuntimeProcess(proc)) continue;
      const byPid = candidates.get(targetKey) ?? new Map<number, string>();
      byPid.set(pid, pane.cwd);
      candidates.set(targetKey, byPid);
    }
  }

  const resolved = new Map<string, string>();
  await Promise.all([...candidates].map(async ([targetKey, byPid]) => {
    if (byPid.size !== 1) return;
    const [[pid, paneCwd]] = [...byPid];
    try {
      const receipt = parseClaudeRuntimeSession(
        JSON.parse(await readFile(join(homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8')),
        pid,
      );
      if (!receipt) return;
      const [realPaneCwd, realReceiptCwd] = await Promise.all([
        realpath(paneCwd),
        realpath(receipt.cwd),
      ]);
      if (realPaneCwd === realReceiptCwd) {
        resolved.set(targetKey, receipt.sessionId);
      }
    } catch {
      // The Claude runtime receipt is best-effort and may disappear on exit.
    }
  }));
  return resolved;
}

export function extractContainedTranscriptSessionId(
  sessionsRoot: string,
  transcriptPath: string,
): string | null {
  const rel = relative(sessionsRoot, transcriptPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return TRANSCRIPT_FILE_SESSION_ID_RE.exec(rel)?.[1] ?? null;
}

/**
 * Oh My Pi keeps its active JSONL transcript open for the lifetime of the TUI.
 * Resolve that file through /proc so an already-running, untagged tmux pane can
 * attach to structured history without relying on filesystem creation times.
 */
export const PI_TRANSCRIPT_HOME_DIRS = {
  omp: '.omp',
  omo: '.omo',
} as const;

export async function inferOpenPiSessionIds(
  sessions: ExternalCliSession[],
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const kinds = Object.keys(PI_TRANSCRIPT_HOME_DIRS) as Array<keyof typeof PI_TRANSCRIPT_HOME_DIRS>;
  await Promise.all(kinds.map(async (kind) => {
    const targets = sessions.filter((session) => (
      session.kind === kind
      && session.agentPid !== undefined
    ));
    if (targets.length === 0) return;

    const sessionsRoot = await realpath(
      join(homedir(), PI_TRANSCRIPT_HOME_DIRS[kind], 'agent', 'sessions'),
    ).catch(() => null);
    if (!sessionsRoot) return;

    await Promise.all(targets.map(async (session) => {
      const fdRoot = `/proc/${session.agentPid}/fd`;
      const descriptors = await readdir(fdRoot).catch(() => []);
      const transcriptById = new Map<string, string>();
      await Promise.all(descriptors.slice(0, MAX_RUNTIME_DESCRIPTORS).map(async (descriptor) => {
        const transcriptPath = await realpath(join(fdRoot, descriptor)).catch(() => null);
        if (!transcriptPath) return;
        const sessionId = extractContainedTranscriptSessionId(sessionsRoot, transcriptPath);
        if (sessionId) transcriptById.set(sessionId, transcriptPath);
      }));
      if (transcriptById.size !== 1) return;

      const [[sessionId, transcriptPath]] = [...transcriptById];
      if (!sessionsDb.getSessionByProviderSessionId(kind, sessionId)) {
        await providerRegistry.resolveProvider(kind).sessionSynchronizer
          .synchronizeFile(transcriptPath)
          .catch(() => undefined);
      }
      resolved.set(tmuxPaneIdentityKey(session.tmux), sessionId);
    }));
  }));
  return resolved;
}

export async function addExternalRuntimeMetadata(args: {
  sessions: ExternalCliSession[];
  panes: ExternalPane[];
  procs: ProcessTreeEntry[];
}): Promise<ExternalCliSession[]> {
  return Promise.all(args.sessions.map(async (session) => {
    if (session.kind === 'ssh' || session.agentPid === undefined) return session;
    const startedAtMs = await processStartMs(session.agentPid);
    const connectionIssue = await validateLocalAgentContext({
      pid: session.agentPid,
      startedAtMs,
      socketPath: session.tmux.socketPath,
    });
    if (connectionIssue) {
      const { providerSessionId: _providerSessionId, binding: _binding, ...unbound } = session;
      return {
        ...unbound,
        ...(startedAtMs === null ? {} : { startedAtMs }),
        connectionIssue,
      };
    }
    return startedAtMs === null ? session : { ...session, startedAtMs };
  }));
}

export async function inferIndexedProviderSessionIds(
  sessions: ExternalCliSession[],
  attemptableTargetKeys: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const unresolved = sessions.filter((session): session is ExternalCliSession & {
    kind: 'cursor' | 'opencode' | 'omp' | 'omo';
    cwd: string;
    startedAtMs: number;
  } => (
    (session.kind === 'cursor' || session.kind === 'opencode' || session.kind === 'omp' || session.kind === 'omo')
    && !session.providerSessionId
    && typeof session.cwd === 'string'
    && typeof session.startedAtMs === 'number'
  ));
  if (unresolved.length === 0) return new Map();

  const providers = [...new Set(
    unresolved
      .filter((session) => attemptableTargetKeys.has(tmuxPaneIdentityKey(session.tmux)))
      .map((session) => session.kind),
  )];
  await Promise.all(providers.map(async (provider) => {
    const starts = unresolved
      .filter((session) => session.kind === provider)
      .map((session) => session.startedAtMs);
    const since = new Date(Math.min(...starts) - 30_000);
    await providerRegistry.resolveProvider(provider).sessionSynchronizer.synchronize(since);
  })).catch(() => undefined);

  const candidates: FreshIndexedProviderSession[] = [];
  const seen = new Set<string>();
  for (const session of unresolved) {
    for (const row of sessionsDb.getSessionsByProjectPath(session.cwd)) {
      const providerSessionId = row.provider_session_id;
      if (
        row.provider !== session.kind
        || !providerSessionId
        || row.session_id !== providerSessionId
      ) {
        continue;
      }
      const key = `${session.kind}:${providerSessionId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({
        id: providerSessionId,
        kind: session.kind,
        cwd: session.cwd,
        createdAtMs: new Date(row.created_at).getTime(),
        updatedAtMs: new Date(row.updated_at).getTime(),
        diskDiscovered: true,
      });
    }
  }
  const fresh = assignFreshIndexedProviderSessionIds(unresolved, candidates);
  return new Map(
    [...assignUniqueIndexedProviderSessionIds(unresolved, candidates, fresh, Date.now(), sessions)]
      .filter(([targetKey]) => attemptableTargetKeys.has(targetKey)),
  );
}

export function applyInferredProviderSessionIds(
  sessions: ExternalCliSession[],
  inferredIds: ReadonlyMap<string, string>,
  authoritativeTargetKeys: ReadonlySet<string> = new Set(),
): ExternalCliSession[] {
  return sessions.map((session) => {
    if (session.connectionIssue) {
      const { providerSessionId: _providerSessionId, binding: _binding, ...unbound } = session;
      return unbound;
    }
    const targetKey = tmuxPaneIdentityKey(session.tmux);
    const providerSessionId = inferredIds.get(targetKey);
    // Authoritative keys are the process-scoped sources (runtime receipt,
    // open transcript, open rollout); everything else in `inferredIds` came
    // from a cwd or time-window guess and is graded accordingly.
    const binding: ExternalSessionBinding = authoritativeTargetKeys.has(targetKey) ? 'observed' : 'inferred';
    return providerSessionId
      && (!session.providerSessionId || authoritativeTargetKeys.has(targetKey))
      ? { ...session, providerSessionId, binding }
      : session;
  });
}

export type ExternalProviderSessionInference = {
  ids: Map<string, string>;
  authoritativeTargetKeys: Set<string>;
};
