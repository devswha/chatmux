/**
 * Route boundary for host-qualified sessions.
 *
 * Every session-bearing route renders through here: the URL is parsed once into
 * a typed resolution, the ambient active host is published for the storage layer,
 * and an unusable host segment renders an explicit dead end instead of silently
 * opening a local session that happens to share the id.
 */

import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useParams } from 'react-router-dom';

import { LOCAL_SESSION_STORE_SCOPE, type SessionStoreScope } from '../stores/sessionStoreScope';

import HostNotFound from './view/HostNotFound';
import { setActiveSessionHostId } from './hostIdentity';
import {
  type HostQualifiedKey,
  type SessionTarget,
  sessionSlotKey,
} from './references';
import { resolveSessionRoute, type SessionRouteResolution } from './sessionRoute';
import { useFleetIdentity } from './useFleetIdentity';

export type FleetHostState = {
  /** Authoritative local host id, or null before the server supplies one. */
  readonly localHostId: string | null;
  readonly route: SessionRouteResolution;
  /** Session the route addresses, host-qualified when the host is known. */
  readonly activeSession: SessionTarget | null;
  readonly activeSessionKey: HostQualifiedKey | null;
  readonly storeScope: SessionStoreScope;
};

const LEGACY_FLEET_HOST_STATE: FleetHostState = {
  localHostId: null,
  route: { kind: 'no-session' },
  activeSession: null,
  activeSessionKey: null,
  storeScope: LOCAL_SESSION_STORE_SCOPE,
};

const FleetHostContext = createContext<FleetHostState>(LEGACY_FLEET_HOST_STATE);

/**
 * Host context for the current route. Outside a `FleetSessionRoute` this reports
 * the legacy local-only state, which is what a component test or a non-session
 * surface should see.
 */
export function useFleetHost(): FleetHostState {
  return useContext(FleetHostContext);
}

function activeSessionOf(route: SessionRouteResolution): SessionTarget | null {
  switch (route.kind) {
    case 'local-session':
      return route.reference === null
        ? { hostId: null, localId: route.localId }
        : { hostId: route.reference.hostId, localId: route.reference.localId };
    case 'remote-session':
      return { hostId: route.reference.hostId, localId: route.reference.localId };
    case 'no-session':
    case 'host-not-found':
      return null;
    default:
      return null;
  }
}

export default function FleetSessionRoute({ children }: { children: ReactNode }) {
  const identity = useFleetIdentity();
  const params = useParams<{ hostId?: string; sessionId?: string }>();
  const localHostId = identity.kind === 'known' ? identity.hostId : null;

  const state = useMemo<FleetHostState>(() => {
    const route = resolveSessionRoute(params, localHostId);
    const activeSession = activeSessionOf(route);
    return {
      localHostId,
      route,
      activeSession,
      activeSessionKey: activeSession === null
        ? null
        : sessionSlotKey(activeSession.hostId, activeSession.localId),
      storeScope: {
        hostId: activeSession === null ? localHostId : activeSession.hostId,
        localHostId,
      },
    };
  }, [localHostId, params]);

  // The composer persists queued drafts through module-scope storage helpers, and
  // it reads them during its very first render. The route decision is final at
  // this point in the render pass — parents render before children — so the
  // ambient host must already be published here; an effect would let the first
  // composer read race a stale host. Publishing is an idempotent write to a
  // module-scope ambient value (same pattern as the auth token), not a React
  // state update, so it cannot loop renders.
  setActiveSessionHostId(state.activeSession?.hostId ?? null);

  return (
    <FleetHostContext.Provider value={state}>
      {state.route.kind === 'host-not-found'
        ? <HostNotFound requestedHostId={state.route.requestedHostId} />
        : children}
    </FleetHostContext.Provider>
  );
}
