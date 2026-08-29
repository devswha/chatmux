import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';

import { parseFleetTransportTarget } from '@/modules/fleet/protocol/transport-policy.js';
import type { FleetTransportMode } from '@/modules/database/repositories/fleet-peers.js';

export type FleetConnectivityResult = Readonly<{
  readonly reachable: boolean;
  readonly detail: 'connected' | 'refused' | 'timeout' | 'tls-rejected' | 'invalid-target';
}>;

export type FleetConnectivityTarget = Readonly<{
  readonly url: string;
  readonly transportMode: FleetTransportMode;
}>;

export function probeFleetConnectivity(
  input: FleetConnectivityTarget,
  timeoutMs = 3_000,
): Promise<FleetConnectivityResult> {
  const parsed = parseFleetTransportTarget(input.url, input.transportMode);
  if (!parsed.ok) return Promise.resolve({ reachable: false, detail: 'invalid-target' });
  const target = parsed.target;
  const port = target.port.length > 0
    ? Number(target.port)
    : target.protocol === 'wss:' ? 443 : 80;
  const { promise, resolve } = Promise.withResolvers<FleetConnectivityResult>();
  let settled = false;
  const finish = (result: FleetConnectivityResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(result);
  };
  const socket = input.transportMode === 'direct-wss'
    ? connectTls({ host: target.hostname, port, servername: target.hostname })
    : connectTcp({ host: target.hostname, port });
  const timer = setTimeout(() => finish({ reachable: false, detail: 'timeout' }), timeoutMs);
  timer.unref();
  socket.once(input.transportMode === 'direct-wss' ? 'secureConnect' : 'connect', () => {
    finish({ reachable: true, detail: 'connected' });
  });
  socket.once('error', (error) => {
    const detail = input.transportMode === 'direct-wss' && !('code' in error && error.code === 'ECONNREFUSED')
      ? 'tls-rejected'
      : 'refused';
    finish({ reachable: false, detail });
  });
  return promise;
}
