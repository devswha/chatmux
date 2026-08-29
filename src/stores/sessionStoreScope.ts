/**
 * Host scope for the session message store.
 *
 * The store holds one slot per session and addresses sessions by the bare local
 * id its callers already use. That id only identifies a session *within one
 * installation*, so every slot is keyed by a host-qualified key and every request
 * URL is resolved against the owning host. Without this, two installations
 * running the same local session id would share one slot and one transcript.
 *
 * `hostId: null` means the server has not supplied an authoritative local host id
 * yet: slots live in the `unknown-host` namespace and requests keep the legacy
 * local URLs, which is exactly the pre-fleet behaviour.
 */

import {
  type HostQualifiedKey,
  sessionSlotKey,
  unknownHostSessionLocalId,
} from '../fleet/references';

import { buildRefreshMessagesUrl } from './sessionMessageFetch';

export type SessionStoreScope = {
  /** Host owning the sessions this store is asked about. */
  readonly hostId: string | null;
  /** Authoritative local host id, or null before the server supplies one. */
  readonly localHostId: string | null;
};

export const LOCAL_SESSION_STORE_SCOPE: SessionStoreScope = { hostId: null, localHostId: null };

export function sessionStoreSlotKey(scope: SessionStoreScope, localId: string): HostQualifiedKey {
  return sessionSlotKey(scope.hostId, localId);
}

function isLocal(scope: SessionStoreScope): boolean {
  return scope.hostId === null || scope.hostId === scope.localHostId;
}

/**
 * Messages endpoint for a session. Local sessions keep the existing route so
 * nothing about single-machine ChatMux changes; a remote session is addressed
 * through its host so the hub can route it to the owning peer.
 */
export function sessionMessagesUrl(
  scope: SessionStoreScope,
  localId: string,
  query: string,
): string {
  const session = encodeURIComponent(localId);
  const suffix = query ? `?${query}` : '';
  return isLocal(scope)
    ? `/api/providers/sessions/${session}/messages${suffix}`
    : `/api/hosts/${encodeURIComponent(scope.hostId ?? '')}/providers/sessions/${session}/messages${suffix}`;
}

export function sessionRefreshUrl(
  scope: SessionStoreScope,
  localId: string,
  loadedCount: number,
  includeImages: boolean,
): string {
  const localUrl = buildRefreshMessagesUrl(localId, loadedCount, includeImages);
  if (isLocal(scope)) {
    return localUrl;
  }
  const query = localUrl.slice(localUrl.indexOf('?') + 1);
  return sessionMessagesUrl(scope, localId, query);
}

/**
 * Re-keys slots loaded before the authoritative local host id arrived.
 *
 * Only a *local* session can be keyed without a host: a host-qualified URL
 * carries its host from the first render. So when the identity lands, every
 * `unknown-host` slot provably belongs to the local installation, and moving it
 * keeps the transcript already on screen instead of orphaning it behind a new key.
 */
export function rekeyUnknownHostSlots<T>(
  slots: Map<HostQualifiedKey, T>,
  localHostId: string,
): Map<HostQualifiedKey, HostQualifiedKey> {
  const moved = new Map<HostQualifiedKey, HostQualifiedKey>();
  for (const [key, slot] of [...slots]) {
    const localId = unknownHostSessionLocalId(key);
    if (localId === null) {
      continue;
    }
    const qualified = sessionSlotKey(localHostId, localId);
    slots.delete(key);
    if (!slots.has(qualified)) {
      slots.set(qualified, slot);
    }
    moved.set(key, qualified);
  }
  return moved;
}
