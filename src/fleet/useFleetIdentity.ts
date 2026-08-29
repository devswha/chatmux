/**
 * Bootstraps the authoritative local host id from the server, then migrates the
 * browser's legacy bare-id state onto it exactly once.
 *
 * The identity is never inferred from the URL, the hostname or any provider id.
 * A server without the fleet surface simply answers 404, the identity stays
 * unknown, and the browser keeps its pre-fleet local-only behaviour.
 */

import { useEffect } from 'react';

import { authenticatedFetch } from '../utils/api';

import { type LocalHostIdentity, setLocalHostIdentity, useLocalHostIdentity } from './hostIdentity';
import { browserPersistedStateStorage, migrateLegacyPersistedState } from './persistedHostState';
import { parseHostId } from './references';

export const FLEET_IDENTITY_ENDPOINT = '/api/fleet/identity';

/** Accepts `{ installationId }` at the top level or inside the standard envelope. */
export function parseInstallationId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record: Record<string, unknown> = { ...body };
  const direct = parseHostId(record.installationId);
  if (direct !== null) {
    return direct;
  }
  const data: unknown = record.data;
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const nested: Record<string, unknown> = { ...data };
  return parseHostId(nested.installationId);
}

/**
 * Adopts a server-supplied local host id.
 *
 * Migration runs before publication: the moment the identity is visible every
 * reader switches to host-qualified keys, and a draft still sitting under its
 * legacy key would read as missing. Both identity sources (this endpoint and the
 * owner host roster) go through here so that ordering holds for either.
 */
export function adoptLocalHostIdentity(installationId: string): void {
  const storage = browserPersistedStateStorage();
  if (storage !== null) {
    migrateLegacyPersistedState(storage, installationId);
  }
  setLocalHostIdentity(installationId);
}

export function useFleetIdentity(): LocalHostIdentity {
  const identity = useLocalHostIdentity();

  useEffect(() => {
    const controller = new AbortController();

    void authenticatedFetch(FLEET_IDENTITY_ENDPOINT, { signal: controller.signal })
      .then(async (response: Response) => {
        if (!response.ok) {
          // A server without the fleet surface is a supported deployment: the
          // browser stays local-only instead of guessing an installation id.
          return;
        }
        const installationId = parseInstallationId(await response.json());
        if (installationId === null || controller.signal.aborted) {
          return;
        }
        adoptLocalHostIdentity(installationId);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        console.warn('[fleet] local host identity is unavailable; staying local-only', error);
      });

    return () => controller.abort();
  }, []);

  return identity;
}
