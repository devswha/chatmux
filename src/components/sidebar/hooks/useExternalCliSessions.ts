import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import { tmuxPaneIdentityKey, type TmuxPaneIdentity, type TmuxProcessGeneration } from '../../../../shared/tmux';
import { readRestSessionContainer } from '../../../utils/liveSessions';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { useDiscoveryStream, type DiscoveryRow, type RuntimeDiscoveryRow } from '../../../hooks/useDiscoveryStream';
import type { ProviderConnectionIssue } from '../../../../shared/provider-connection';

export type ExternalSessionActivity = 'running' | 'waiting_user' | 'asking_user' | 'error' | 'unknown';

export type ExternalCliSession = {
  tmuxName: string;
  tmux: TmuxPaneIdentity;
  process: TmuxProcessGeneration | null;
  kind: 'claude' | 'codex' | 'cursor' | 'opencode' | 'omp' | 'omo' | 'ssh' | 'shell';
  projectPath?: string;
  transcriptSessionId?: string;
  sessionName?: string;
  model?: string | null;
  effort?: string | null;
  activity?: ExternalSessionActivity;
  /** True when the transcript stream is closed while the pane may still run. */
  transcriptEnded?: boolean;
  /** Opaque server-issued token required to attach SSH and shell panes. */
  attachCapability?: string;
  presence?: 'present' | 'stale';
  authority?: 'stream' | 'rest' | 'none';
  connectionIssue?: ProviderConnectionIssue;
};

export type HerdrTerminalSession = {
  key: string;
  sourceId: string;
  target: Extract<RuntimeDiscoveryRow['terminal'], { runtime: 'herdr' }>;
  capabilities: RuntimeDiscoveryRow['capabilities'];
};
export function mergeExternalDiscoveryRows(
  rows: DiscoveryRow[],
  restSessions: Map<string, ExternalCliSession>,
  previousSessions: ExternalCliSession[],
): ExternalCliSession[] {
  const previous = new Map(previousSessions.map((session) => [
    tmuxPaneIdentityKey(session.tmux),
    session,
  ]));
  return rows
    .filter((row) => row.lane === 'external' && ['claude', 'codex', 'cursor', 'opencode', 'omp', 'omo', 'ssh', 'shell'].includes(row.kind))
    .map((row) => {
      const metadata = restSessions.get(tmuxPaneIdentityKey(row.tmux)) ?? previous.get(tmuxPaneIdentityKey(row.tmux));
      const { connectionIssue: _staleConnectionIssue, ...stableMetadata } = metadata ?? {};
      if (row.presence !== 'present') {
        return externalIdentityOnly({
          tmuxName: row.tmuxName,
          tmux: row.tmux,
          process: null,
          kind: row.kind as ExternalCliSession['kind'],
          presence: row.presence,
        }, 'stream');
      }
      return {
        ...stableMetadata,
        tmuxName: row.tmuxName,
        tmux: row.tmux,
        process: row.process,
        kind: row.kind as ExternalCliSession['kind'],
        activity: row.activity,
        ...(row.connectionIssue ? { connectionIssue: row.connectionIssue } : {}),
        projectPath: row.cwd ?? metadata?.projectPath,
        presence: 'present' as const,
        authority: 'stream' as const,
      };
    });
}

export function clearExternalSessionActivities(
  sessions: ExternalCliSession[],
): ExternalCliSession[] {
  return sessions.map((session) => (
    session.activity === 'unknown' || session.activity === undefined
      ? session
      : { ...session, activity: 'unknown' }
  ));
}

export function shouldApplyExternalRestResponse(
  generation: number,
  appliedGeneration: number,
  cancelled: boolean,
  latestGeneration = generation,
): boolean {
  return !cancelled && generation === latestGeneration && generation > appliedGeneration;
}

export function externalIdentityOnly(
  session: ExternalCliSession,
  authority: ExternalCliSession['authority'] = 'none',
): ExternalCliSession {
  return {
    tmuxName: session.tmuxName,
    tmux: session.tmux,
    process: null,
    kind: session.kind,
    activity: 'unknown',
    presence: session.presence ?? 'stale',
    authority,
  };
}

/**
 * Seeds the display from REST, uses discovery while it is healthy, and resumes
 * bounded REST fallback polling after stream loss.
 */
export function useExternalCliSessions(
  onSessionsChange?: (sessions: ExternalCliSession[]) => void,
): {
  sessions: ExternalCliSession[];
  herdrSessions: HerdrTerminalSession[];
  loading: boolean;
  discoveryOk: boolean;
  refresh: () => void;
} {
  const [sessions, setSessions] = useState<ExternalCliSession[]>([]);
  const [herdrSessions, setHerdrSessions] = useState<HerdrTerminalSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [discoveryOk, setDiscoveryOk] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const { isConnected, sendMessage, subscribe } = useWebSocket();
  const sessionsRef = useRef<ExternalCliSession[]>([]);
  const onSessionsChangeRef = useRef(onSessionsChange);
  onSessionsChangeRef.current = onSessionsChange;
  const restSessionsRef = useRef(new Map<string, ExternalCliSession>());
  sessionsRef.current = sessions;
  const streamRowsRef = useRef<DiscoveryRow[] | null>(null);
  const streamEverHealthyRef = useRef(false);
  const authorityRef = useRef<'stream' | 'rest' | 'none'>('none');
  const restRequestGenerationRef = useRef(0);
  const appliedRestGenerationRef = useRef(0);
  const restRequestControllerRef = useRef<AbortController | null>(null);

  const publish = useCallback((next: ExternalCliSession[]) => {
    sessionsRef.current = next;
    setSessions(next);
    onSessionsChangeRef.current?.(next);
  }, []);

  const applyNone = useCallback((identities = sessionsRef.current) => {
    authorityRef.current = 'none';
    streamRowsRef.current = null;
    restSessionsRef.current = new Map();
    publish(identities.map((session) => externalIdentityOnly(session)));
    setHerdrSessions([]);
    setLoading(false);
  }, [publish]);

  const applyRows = useCallback((allRows: DiscoveryRow[]) => {
    const rows = allRows.filter((row) => row.lane === 'external');
    authorityRef.current = 'stream';
    streamRowsRef.current = rows;
    const next = mergeExternalDiscoveryRows(rows, restSessionsRef.current, sessionsRef.current);
    publish(next);
    setLoading(false);
  }, [publish]);
  const applyRuntimeRows = useCallback((rows: RuntimeDiscoveryRow[]) => {
    setHerdrSessions(rows
      .filter((row): row is RuntimeDiscoveryRow & {
        terminal: Extract<RuntimeDiscoveryRow['terminal'], { runtime: 'herdr' }>;
      } => row.lane === 'external' && row.runtime === 'herdr' && row.terminal.runtime === 'herdr')
      .map((row) => ({
        key: row.key,
        sourceId: row.sourceId,
        target: row.terminal,
        capabilities: row.capabilities,
      })));
  }, []);

  const applyRestSessions = useCallback((list: ExternalCliSession[], responseDiscoveryOk: boolean) => {
    const supported = list.filter((session) => (
      session?.tmuxName
      && ['claude', 'codex', 'cursor', 'opencode', 'omp', 'omo', 'ssh', 'shell'].includes(session.kind)
    ));
    setDiscoveryOk(responseDiscoveryOk);
    if (!responseDiscoveryOk) {
      applyNone(supported);
      return;
    }

    const authoritative = supported.map((session) => (
      session.presence === 'stale'
        ? externalIdentityOnly(session, 'rest')
        : { ...session, presence: 'present' as const, authority: 'rest' as const }
    ));
    restSessionsRef.current = new Map(authoritative.map((session) => [tmuxPaneIdentityKey(session.tmux), session]));
    if (authorityRef.current === 'stream' && streamRowsRef.current !== null) {
      applyRows(streamRowsRef.current);
      return;
    }
    authorityRef.current = 'rest';
    publish(authoritative);
    setLoading(false);
  }, [applyNone, applyRows, publish]);

  const invalidateRestRequests = useCallback(() => {
    restRequestControllerRef.current?.abort();
    ++restRequestGenerationRef.current;
  }, []);

  const requestRestSessions = useCallback(async () => {
    const generation = ++restRequestGenerationRef.current;
    restRequestControllerRef.current?.abort();
    const controller = new AbortController();
    restRequestControllerRef.current = controller;
    try {
      const response = await api.externalSessions(controller.signal);
      if (!shouldApplyExternalRestResponse(
        generation,
        appliedRestGenerationRef.current,
        controller.signal.aborted,
        restRequestGenerationRef.current,
      )) return;

      if (!response.ok) {
        appliedRestGenerationRef.current = generation;
        applyNone();
        return;
      }

      const body = await response.json();
      if (!shouldApplyExternalRestResponse(
        generation,
        appliedRestGenerationRef.current,
        controller.signal.aborted,
        restRequestGenerationRef.current,
      )) return;
      const container = readRestSessionContainer(body, 'externalSessions');
      appliedRestGenerationRef.current = generation;
      if (!container) {
        setDiscoveryOk(false);
        applyNone();
        return;
      }
      applyRestSessions(
        container.sessions as ExternalCliSession[],
        container.discoveryOk,
      );
    } catch {
      if (shouldApplyExternalRestResponse(
        generation,
        appliedRestGenerationRef.current,
        controller.signal.aborted,
        restRequestGenerationRef.current,
      )) {
        appliedRestGenerationRef.current = generation;
        applyNone();
      }
    }
  }, [applyNone, applyRestSessions]);

  const handleStreamHealthChange = useCallback((healthy: boolean) => {
    if (healthy) {
      streamEverHealthyRef.current = true;
      void requestRestSessions();
      return;
    }
    invalidateRestRequests();
    applyNone();
  }, [applyNone, invalidateRestRequests, requestRestSessions]);

  const streamHealthy = useDiscoveryStream({
    lanes: ['external'],
    isConnected,
    sendMessage,
    subscribe,
    onRows: (rows) => {
      applyRows(rows);
    },
    onRuntimeRows: applyRuntimeRows,
    onHealthChange: handleStreamHealthChange,
  });

  useEffect(() => {
    void requestRestSessions();
    return () => {
      invalidateRestRequests();
    };
  }, [invalidateRestRequests, requestRestSessions]);

  useEffect(() => {
    if (streamHealthy) return undefined;
    const poll = () => { void requestRestSessions(); };
    if (streamEverHealthyRef.current || refreshToken > 0) poll();
    const timer = window.setInterval(poll, 5_000);
    return () => window.clearInterval(timer);
  }, [refreshToken, requestRestSessions, streamHealthy]);

  return {
    sessions,
    herdrSessions,
    loading,
    discoveryOk,
    refresh: () => {
      setRefreshToken((value) => value + 1);
      sendMessage({ type: 'discovery.resync', reason: 'client_refresh' });
    },
  };
}
