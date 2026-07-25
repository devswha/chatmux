import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import { tmuxPaneIdentityKey, type TmuxPaneIdentity, type TmuxProcessGeneration } from '../../../../shared/tmux';
import { readDiscoveryOk } from '../../../utils/liveSessions';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { useDiscoveryStream, type DiscoveryRow } from '../../../hooks/useDiscoveryStream';

export type ExternalSessionActivity = 'running' | 'waiting_user' | 'asking_user' | 'unknown';

export type ExternalCliSession = {
  tmuxName: string;
  tmux: TmuxPaneIdentity;
  process: TmuxProcessGeneration | null;
  kind: 'claude' | 'codex' | 'cursor' | 'opencode' | 'omp' | 'ssh' | 'shell';
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
    .filter((row) => row.lane === 'external' && ['claude', 'codex', 'cursor', 'opencode', 'omp', 'ssh', 'shell'].includes(row.kind))
    .map((row) => {
      const metadata = restSessions.get(tmuxPaneIdentityKey(row.tmux)) ?? previous.get(tmuxPaneIdentityKey(row.tmux));
      return {
        ...metadata,
        tmuxName: row.tmuxName,
        tmux: row.tmux,
        process: row.process,
        kind: row.kind as ExternalCliSession['kind'],
        activity: row.activity,
        projectPath: row.cwd ?? metadata?.projectPath,
      };
    });
}

/**
 * Seeds the display from REST, uses discovery while it is healthy, and resumes
 * bounded REST fallback polling after stream loss.
 */
export function useExternalCliSessions(
  onSessionsChange?: (sessions: ExternalCliSession[]) => void,
): {
  sessions: ExternalCliSession[];
  loading: boolean;
  discoveryOk: boolean;
  refresh: () => void;
} {
  const [sessions, setSessions] = useState<ExternalCliSession[]>([]);
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

  const applyRows = useCallback((rows: DiscoveryRow[]) => {
    streamRowsRef.current = rows;
    const next = mergeExternalDiscoveryRows(rows, restSessionsRef.current, sessionsRef.current);
    setSessions(next);
    onSessionsChangeRef.current?.(next);
    setLoading(false);
  }, []);
  const applyRestSessions = useCallback((list: ExternalCliSession[], discoveryOk: boolean) => {
    const next = list.filter((session) => session?.tmuxName && ['claude', 'codex', 'cursor', 'opencode', 'omp', 'ssh', 'shell'].includes(session.kind));
    restSessionsRef.current = new Map(next.map((session) => [tmuxPaneIdentityKey(session.tmux), session]));
    setDiscoveryOk(discoveryOk);
    if (streamRowsRef.current !== null) {
      applyRows(streamRowsRef.current);
      return;
    }
    setSessions(next);
    onSessionsChangeRef.current?.(next);
  }, [applyRows]);
  const streamHealthy = useDiscoveryStream({ lanes: ['external', 'live'], isConnected, sendMessage, subscribe, onRows: applyRows });
  useEffect(() => {
    let cancelled = false;
    void api.externalSessions()
      .then(async (response) => response.ok ? response.json() : null)
      .then((body) => {
        if (cancelled || !body) return;
        const data = body?.data ?? body ?? {};
        applyRestSessions(data.externalSessions ?? [], readDiscoveryOk(data));
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [applyRestSessions]);

  useEffect(() => {
    if (streamHealthy) return undefined;
    let cancelled = false;
    let generation = 0;
    let applied = 0;
    const poll = async () => {
      const myGeneration = ++generation;
      try {
        const response = await api.externalSessions();
        if (!response.ok) return;
        const body = await response.json();
        const data = body?.data ?? body ?? {};
        if (!cancelled && myGeneration > applied) {
          applied = myGeneration;
          applyRestSessions(data.externalSessions ?? [], readDiscoveryOk(data));
        }
      } catch {
        // Best-effort: retain the last known roster while the fallback retries.
      }
    };
    if (refreshToken > 0) void poll();
    const timer = window.setInterval(() => { void poll(); }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [applyRestSessions, refreshToken, streamHealthy]);

  return {
    sessions,
    loading,
    discoveryOk,
    refresh: () => {
      setRefreshToken((value) => value + 1);
      sendMessage({ type: 'discovery.resync', reason: 'client_refresh' });
    },
  };
}
