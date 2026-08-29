import { useEffect, useRef, useState } from 'react';

import { useLocalHostIdentity } from '../../../fleet/hostIdentity';
import { parseTranscriptSearch, requestHostJson } from '../../../fleet/hostApi/requests';
import { hostTranscriptSearchUrl } from '../../../fleet/hostApi/urls';
import { api } from '../../../utils/api';
import type { LLMProvider, Project } from '../../../types/app';

export type SessionMessageMatch = {
  sessionId: string;
  label: string;
  snippet: string;
  provider: LLMProvider;
};

type ProjectResult = {
  projectId: string | null;
  projectName: string;
  sessions: Array<{
    sessionId: string;
    provider: LLMProvider;
    sessionSummary: string;
    matches: Array<{ snippet: string }>;
  }>;
};

export type SessionMessageSearchInput = {
  /** Project whose transcripts are searched, including the host that owns it. */
  readonly project: Project | undefined;
  readonly query: string;
  readonly enabled: boolean;
};

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 50;

/**
 * Transcript search for the selected project, on the host that owns it.
 *
 * The local host streams results over SSE, unchanged. A project owned by a peer
 * cannot be searched here — its transcripts only exist on that installation — so
 * the search is issued through the host-qualified route and the peer's own search
 * service answers it. Results from another project are dropped even when both
 * hosts happen to use the same project id.
 */
export function useSessionMessageSearch(input: SessionMessageSearchInput): SessionMessageMatch[] {
  const { project, query, enabled } = input;
  const identity = useLocalHostIdentity();
  const localHostId = identity.kind === 'known' ? identity.hostId : null;
  const projectId = project?.projectId;
  const hostId = project?.hostId ?? null;
  const [items, setItems] = useState<SessionMessageMatch[]>([]);
  const seqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || !projectId || trimmed.length < MIN_QUERY) {
      setItems([]);
      esRef.current?.close();
      esRef.current = null;
      return;
    }

    esRef.current?.close();
    esRef.current = null;
    seqRef.current++;
    const remoteUrl = hostTranscriptSearchUrl(
      { hostId, localHostId },
      projectId,
      { query: trimmed, limit: SEARCH_LIMIT },
    );

    const handle = setTimeout(() => {
      const seq = ++seqRef.current;
      if (remoteUrl !== null) {
        void requestHostJson(remoteUrl).then((result) => {
          if (seq !== seqRef.current) return;
          setItems(result.ok
            ? parseTranscriptSearch(result.value, projectId).map((match) => ({
              sessionId: match.sessionId,
              label: match.label,
              snippet: match.snippet,
              provider: match.provider as LLMProvider,
            }))
            : []);
        });
        return;
      }
      const url = api.searchConversationsUrl(trimmed, SEARCH_LIMIT);
      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;
      const accumulated: SessionMessageMatch[] = [];

      es.addEventListener('result', (evt) => {
        if (seq !== seqRef.current) {
          es.close();
          return;
        }
        try {
          const data = JSON.parse((evt as MessageEvent).data) as { projectResult: ProjectResult };
          const pr = data.projectResult;
          if (pr.projectId !== projectId) return;
          for (const s of pr.sessions) {
            accumulated.push({
              sessionId: s.sessionId,
              label: s.sessionSummary || s.sessionId,
              snippet: s.matches[0]?.snippet ?? '',
              provider: s.provider,
            });
          }
          setItems([...accumulated]);
        } catch {
          // ignore malformed
        }
      });

      const finish = () => {
        if (seq !== seqRef.current) return;
        es.close();
        esRef.current = null;
      };
      es.addEventListener('done', finish);
      es.addEventListener('error', finish);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(handle);
    };
  }, [enabled, hostId, localHostId, projectId, query]);

  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  return items;
}
