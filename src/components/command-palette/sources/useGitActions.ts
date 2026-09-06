import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { useFleetHost } from '../../../fleet/FleetSessionRoute';
import { isLocalHostScope } from '../../../fleet/hostApi/urls';

async function postGit(path: string, body: Record<string, unknown>) {
  const res = await authenticatedFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.json();
}

export function useGitActions(projectId: string | undefined) {
  const { storeScope } = useFleetHost();
  const localId = isLocalHostScope(storeScope) ? projectId : undefined;
  const selection = useMemo(() => ({ localId }), [localId]);
  const current = useRef<typeof selection | null>(selection);
  current.current = selection;
  useLayoutEffect(() => {
    current.current = selection;
    return () => { current.current = null; };
  }, [selection]);
  const run = useCallback((path: string, extra: Record<string, unknown> = {}) => {
    if (!localId || current.current !== selection) return Promise.resolve();
    return postGit(path, { project: localId, ...extra });
  }, [localId, selection]);
  const fetch = useCallback(() => {
    return run('/api/git/fetch');
  }, [run]);

  const pull = useCallback(() => {
    return run('/api/git/pull');
  }, [run]);

  const push = useCallback(() => {
    return run('/api/git/push');
  }, [run]);

  const checkout = useCallback(
    (branch: string) => {
      return run('/api/git/checkout', { branch });
    },
    [run],
  );

  return { fetch, pull, push, checkout };
}
