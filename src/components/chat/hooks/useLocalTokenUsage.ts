import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { useFleetHost } from '../../../fleet/FleetSessionRoute';
import { localProjectIdForScope } from '../../../fleet/hostApi/urls';
import type { Project } from '../../../types/app';
import { authenticatedFetch } from '../../../utils/api';

/** Peer token usage comes from host-qualified history, never the hub's compatibility endpoint. */
export function useLocalTokenUsage(
  project: Project | null,
  sessionId: string | undefined,
  setTokenBudget: Dispatch<SetStateAction<Record<string, unknown> | null>>,
): void {
  const { storeScope } = useFleetHost();
  const projectId = localProjectIdForScope(storeScope, project);
  useEffect(() => {
    if (!projectId || !sessionId) return;
    const controller = new AbortController();
    const url = `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/token-usage`;
    void authenticatedFetch(url, { signal: controller.signal })
      .then(async (response) => {
        const usage = response.ok ? await response.json() as Record<string, unknown> : null;
        if (!controller.signal.aborted) setTokenBudget(usage);
      })
      .catch(() => { if (!controller.signal.aborted) setTokenBudget(null); });
    return () => controller.abort();
  }, [projectId, sessionId, setTokenBudget]);
}
