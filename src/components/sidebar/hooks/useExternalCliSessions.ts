import { useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../shared/tmux';

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

const POLL_INTERVAL_MS = 5000;

/**
 * Polls /sessions/external (5s, best-effort) for every non-GJC tmux pane.
 * GJC remains on its dedicated live poll.
 */
export function useExternalCliSessions(
  onSessionsChange?: (sessions: ExternalCliSession[]) => void,
): { sessions: ExternalCliSession[]; loading: boolean; refresh: () => void } {
  const [sessions, setSessions] = useState<ExternalCliSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const onSessionsChangeRef = useRef(onSessionsChange);
  onSessionsChangeRef.current = onSessionsChange;

  useEffect(() => {
    let cancelled = false;
    // Generation guard: a delayed older response must not overwrite a newer
    // snapshot (stale name could attach a terminal to a reused tmux session).
    let generation = 0;
    let applied = 0;
    const poll = async () => {
      const myGeneration = ++generation;
      try {
        const response = await api.externalSessions();
        if (!response.ok) return;
        const body = await response.json();
        const list: ExternalCliSession[] = body?.data?.externalSessions ?? body?.externalSessions ?? [];
        if (!cancelled && myGeneration > applied) {
          applied = myGeneration;
          const sessions = list.filter((session) => session?.tmuxName && ['claude', 'codex', 'cursor', 'opencode', 'omp', 'ssh', 'shell'].includes(session.kind));
          setSessions(sessions);
          onSessionsChangeRef.current?.(sessions);
        }
      } catch {
        // best-effort — no tmux / endpoint error just empties the tab
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshToken]);

  return {
    sessions,
    loading,
    refresh: () => setRefreshToken((value) => value + 1),
  };
}
