import type { IncomingHttpHeaders } from 'node:http';

import type { FleetTransportMode } from './types.js';

export type FleetAdmissionResult =
  | Readonly<{ readonly ok: true }>
  | Readonly<{
    readonly ok: false;
    readonly reason: 'wrong_path' | 'origin_forbidden' | 'query_forbidden' | 'browser_credentials_forbidden' | 'transport_target_mismatch';
  }>;

export type FleetTransportTargetResult =
  | Readonly<{ readonly ok: true; readonly target: URL }>
  | Readonly<{ readonly ok: false; readonly reason: 'transport_target_mismatch' }>;

type UpgradeRequest = Readonly<{ readonly url?: string; readonly headers: IncomingHttpHeaders }>;

export function validateFleetUpgrade(request: UpgradeRequest): FleetAdmissionResult {
  const target = new URL(request.url ?? '/', 'http://fleet.invalid');
  if (target.pathname !== '/fleet-ws') return { ok: false, reason: 'wrong_path' };
  if (target.search.length > 0) return { ok: false, reason: 'query_forbidden' };
  if (request.headers.origin !== undefined) return { ok: false, reason: 'origin_forbidden' };
  if (request.headers.cookie !== undefined || request.headers.authorization !== undefined) {
    return { ok: false, reason: 'browser_credentials_forbidden' };
  }
  return { ok: true };
}

export function parseFleetTransportTarget(rawUrl: string, mode: FleetTransportMode): FleetTransportTargetResult {
  if (mode === 'direct-wss' && !rawUrl.startsWith('wss://')) {
    return { ok: false, reason: 'transport_target_mismatch' };
  }
  if (mode === 'ssh-loopback' && !/^ws:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?\/fleet-ws$/.test(rawUrl)) {
    return { ok: false, reason: 'transport_target_mismatch' };
  }
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch (error) {
    if (error instanceof TypeError) return { ok: false, reason: 'transport_target_mismatch' };
    throw error;
  }
  if (target.pathname !== '/fleet-ws' || target.search || target.hash || target.username || target.password) {
    return { ok: false, reason: 'transport_target_mismatch' };
  }
  switch (mode) {
    case 'direct-wss':
      return target.protocol === 'wss:'
        ? { ok: true, target }
        : { ok: false, reason: 'transport_target_mismatch' };
    case 'ssh-loopback':
      return { ok: true, target };
  }
}

export function validateFleetDialTarget(rawUrl: string, mode: FleetTransportMode): FleetAdmissionResult {
  const parsed = parseFleetTransportTarget(rawUrl, mode);
  return parsed.ok ? { ok: true } : parsed;
}
