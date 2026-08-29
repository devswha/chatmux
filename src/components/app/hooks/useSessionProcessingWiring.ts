/**
 * Host-qualified processing-state wiring for the app shell.
 *
 * Owns the protection map plus the adapters chat surfaces consume: bare-id
 * mark/idle callbacks bound to the viewed session's host, a bare-id activity
 * view scoped to exactly that host, a second view for the local installation
 * (project events), and the session path builder that keeps local URLs legacy
 * while host-qualified sessions get their `/hosts/...` URL.
 * Split from the former `AppContent.tsx`.
 */

import { useCallback } from 'react';

import { useHostScopedSessionActivity } from '../../../fleet/hostScopedSessionActivity';
import { parseHostId, sessionRef } from '../../../fleet/references';
import { sessionRoutePath } from '../../../fleet/sessionRoute';
import type { FleetHostState } from '../../../fleet/FleetSessionRoute';
import {
  useSessionProtection,
  type MarkSessionIdle,
  type MarkSessionProcessing,
  type MarkTargetProcessing,
  type QualifiedSessionActivityMap,
  type SessionActivityMap,
} from '../../../hooks/useSessionProtection';

export type SessionProcessingWiring = {
  qualifiedProcessingSessions: QualifiedSessionActivityMap;
  processingSessions: SessionActivityMap;
  localProcessingSessions: SessionActivityMap;
  markSessionProcessing: MarkSessionProcessing;
  markSessionIdle: MarkSessionIdle;
  markProcessing: MarkTargetProcessing;
  syncProcessing: ReturnType<typeof useSessionProtection>['syncProcessing'];
  sessionPathFor: (hostId: unknown, localId: string) => string;
  localHostId: string | null;
  viewedHostId: string | null;
};

export function useSessionProcessingWiring(fleetHost: FleetHostState): SessionProcessingWiring {
  const {
    processingSessions: qualifiedProcessingSessions,
    markProcessing,
    markIdle,
    syncProcessing,
  } = useSessionProtection();

  const localHostId = fleetHost.localHostId;
  // Host of the session on screen. Chat surfaces read activity by bare session
  // id, so they get a view scoped to exactly that host; project events arrive
  // from the local installation and get the local-host view.
  const viewedHostId = fleetHost.activeSession?.hostId ?? localHostId;
  const processingSessions = useHostScopedSessionActivity(qualifiedProcessingSessions, viewedHostId);
  const localProcessingSessions = useHostScopedSessionActivity(qualifiedProcessingSessions, localHostId);

  const markSessionProcessing = useCallback<MarkSessionProcessing>((targetSessionId, activity) => {
    markProcessing(targetSessionId ? { hostId: viewedHostId, localId: targetSessionId } : null, activity);
  }, [markProcessing, viewedHostId]);

  const markSessionIdle = useCallback<MarkSessionIdle>((targetSessionId, opts) => {
    markIdle(targetSessionId ? { hostId: viewedHostId, localId: targetSessionId } : null, opts);
  }, [markIdle, viewedHostId]);

  const sessionPathFor = useCallback((hostId: unknown, localId: string) => {
    const owningHostId = parseHostId(hostId);
    return owningHostId === null
      ? `/session/${encodeURIComponent(localId)}`
      : sessionRoutePath(sessionRef(owningHostId, localId), localHostId);
  }, [localHostId]);

  return {
    qualifiedProcessingSessions,
    processingSessions,
    localProcessingSessions,
    markSessionProcessing,
    markSessionIdle,
    markProcessing,
    syncProcessing,
    sessionPathFor,
    localHostId,
    viewedHostId,
  };
}
