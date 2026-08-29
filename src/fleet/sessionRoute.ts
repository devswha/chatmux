/**
 * Browser routing contract for host-qualified sessions.
 *
 * `/session/:sessionId` stays the legacy, local-only deep link. Remote sessions
 * live at `/hosts/:hostId/session/:sessionId`. A host segment that is not a
 * canonical host id resolves to `host-not-found`; it must never fall back to
 * loading a local session with the same local id.
 */

import { type FleetSessionReference, parseHostId, parseLocalId, sessionRef } from './references';

export const LOCAL_SESSION_ROUTE = '/session/:sessionId';
export const REMOTE_SESSION_ROUTE = '/hosts/:hostId/session/:sessionId';

export type SessionRouteParams = {
  readonly hostId?: string;
  readonly sessionId?: string;
};

export type SessionRouteResolution =
  /** No session segment: the app opens its default view. */
  | { readonly kind: 'no-session' }
  /**
   * A local session. `reference` is null while the authoritative local host id
   * is still unknown — the session is addressable, but not yet host-qualified.
   */
  | { readonly kind: 'local-session'; readonly reference: FleetSessionReference }
  | { readonly kind: 'local-session'; readonly reference: null; readonly localId: string }
  | { readonly kind: 'remote-session'; readonly reference: FleetSessionReference }
  | { readonly kind: 'host-not-found'; readonly requestedHostId: string };

export function resolveSessionRoute(
  params: SessionRouteParams,
  localHostId: string | null,
): SessionRouteResolution {
  const requestedHostId = params.hostId === undefined ? null : parseHostId(params.hostId);
  if (params.hostId !== undefined && requestedHostId === null) {
    return { kind: 'host-not-found', requestedHostId: params.hostId };
  }

  const localId = parseLocalId(params.sessionId);
  if (localId === null) {
    return requestedHostId === null
      ? { kind: 'no-session' }
      : { kind: 'host-not-found', requestedHostId };
  }

  if (requestedHostId === null) {
    return localHostId === null
      ? { kind: 'local-session', reference: null, localId }
      : { kind: 'local-session', reference: sessionRef(localHostId, localId) };
  }

  return requestedHostId === localHostId
    ? { kind: 'local-session', reference: sessionRef(requestedHostId, localId) }
    : { kind: 'remote-session', reference: sessionRef(requestedHostId, localId) };
}

/**
 * Canonical path for a session reference. The legacy local URL is preserved for
 * the local host so existing bookmarks, notifications and history stay valid.
 */
export function sessionRoutePath(
  reference: FleetSessionReference,
  localHostId: string | null,
): string {
  const session = encodeURIComponent(reference.localId);
  return reference.hostId === localHostId
    ? `/session/${session}`
    : `/hosts/${encodeURIComponent(reference.hostId)}/session/${session}`;
}
