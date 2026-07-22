import { useEffect, useState } from 'react';

import { api } from '../../../utils/api';

export type ExternalCliSession = {
  tmuxName: string;
  kind: 'claude' | 'codex' | 'ssh';
  transcriptSessionId?: string;
  sessionName?: string;
  model?: string | null;
};

const POLL_INTERVAL_MS = 5000;

/**
 * Polls /sessions/external (5s, best-effort) for claude/codex tmux sessions.
 * Self-contained so the gjc live lane (useProjectsState's live poll) stays
 * untouched; gjc sessions are excluded server-side. [] on any failure.
 */
export function useExternalCliSessions(): { sessions: ExternalCliSession[]; loading: boolean; refresh: () => void } {
  const [sessions, setSessions] = useState<ExternalCliSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);

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
          setSessions(list.filter((session) => session?.tmuxName && (session.kind === 'claude' || session.kind === 'codex' || session.kind === 'ssh')));
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
