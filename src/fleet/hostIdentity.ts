/**
 * Ambient host identity for one browser session.
 *
 * Two facts are ambient because they describe the page, not any one component:
 *  - the authoritative LOCAL host id, supplied by the server (never guessed);
 *  - the host the currently viewed session belongs to, decided by the route.
 *
 * They are ambient for a second, harder reason: `chatStorage` persists composer
 * drafts on behalf of a chat composer that cannot be given new arguments, so the
 * host qualification has to be readable from module scope. `src/utils/authToken.ts`
 * establishes the same pattern for the auth token.
 */

import { useSyncExternalStore } from 'react';

import { parseHostId } from './references';

export type LocalHostIdentity =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known'; readonly hostId: string };

const UNKNOWN: LocalHostIdentity = { kind: 'unknown' };

let localIdentity: LocalHostIdentity = UNKNOWN;
let activeHostId: string | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function subscribeHostIdentity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function localHostIdentity(): LocalHostIdentity {
  return localIdentity;
}

export function localHostId(): string | null {
  return localIdentity.kind === 'known' ? localIdentity.hostId : null;
}

/**
 * Records the server-supplied local host id. Malformed values leave the identity
 * unknown: an unattributable id must never become the anchor legacy sessions are
 * migrated onto.
 */
export function setLocalHostIdentity(value: unknown): LocalHostIdentity {
  const hostId = parseHostId(value);
  if (hostId === null || hostId === localHostId()) {
    return localIdentity;
  }
  localIdentity = { kind: 'known', hostId };
  publish();
  return localIdentity;
}

/** Drops ambient identity at an auth boundary, like the session store's `clear`. */
export function clearHostIdentity(): void {
  if (localIdentity.kind === 'unknown' && activeHostId === null) {
    return;
  }
  localIdentity = UNKNOWN;
  activeHostId = null;
  publish();
}

const activeHostListeners = new Set<() => void>();

/** The host owning the session currently open in the chat view. */
export function activeSessionHostId(): string | null {
  return activeHostId;
}

/**
 * Publishes the route-resolved active host. Called synchronously from the route
 * boundary's render (see FleetSessionRoute), so it is silent by design: React
 * subscribers get the new value from the same render pass, and non-React
 * listeners attach via {@link subscribeActiveSessionHostId}.
 */
export function setActiveSessionHostId(hostId: string | null): void {
  activeHostId = hostId === null ? null : parseHostId(hostId);
}

export function subscribeActiveSessionHostId(listener: () => void): () => void {
  activeHostListeners.add(listener);
  return () => {
    activeHostListeners.delete(listener);
  };
}

export function useActiveSessionHostId(): string | null {
  return useSyncExternalStore(
    subscribeActiveSessionHostId,
    activeSessionHostId,
    activeSessionHostId,
  );
}

export function useLocalHostIdentity(): LocalHostIdentity {
  return useSyncExternalStore(subscribeHostIdentity, localHostIdentity, localHostIdentity);
}
