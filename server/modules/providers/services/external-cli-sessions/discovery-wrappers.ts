import type { ExternalCliSession, ExternalCliSessionsDetailedResult } from './contracts-and-resume.js';
import { defaultExternalCliSessionDiscovery } from './discovery.js';

/** Bypasses completed-result caching after an authoritative host-roster change. */
export function getExternalCliSessionsDetailedFresh(): Promise<ExternalCliSessionsDetailedResult> {
  return defaultExternalCliSessionDiscovery.getExternalCliSessionsDetailedFresh();
}

/** Compatible session-only wrapper for existing callers. */
export function getExternalCliSessions(): Promise<ExternalCliSession[]> {
  return defaultExternalCliSessionDiscovery.getExternalCliSessions();
}

/** Bypasses the display cache for request-time control authorization. */
export function getExternalCliSessionsFresh(): Promise<ExternalCliSession[]> {
  return defaultExternalCliSessionDiscovery.getExternalCliSessionsFresh();
}
