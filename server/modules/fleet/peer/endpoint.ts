import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import type {
  FleetCapability,
  FleetEvent,
  JsonValue,
} from '../../../../shared/fleet.js';
import { FleetChallengeReplayGuard } from '../protocol/auth.js';
import type { FleetWritableTransport } from '../protocol/bounded-writer.js';
import { FleetProtocolConnection } from '../protocol/connection.js';
import type { FleetProtocolConnectionOptions } from '../protocol/connection-types.js';
import { validateFleetUpgrade } from '../protocol/transport-policy.js';

export type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

type FleetPeerEndpointOptions = Readonly<{
  readonly server: HttpServer;
  readonly browserUpgradeListeners: readonly UpgradeListener[];
  readonly local: FleetProtocolConnectionOptions['local'];
  readonly trust: FleetProtocolConnectionOptions['trust'];
  readonly registry: FleetProtocolConnectionOptions['registry'];
  readonly dispatch: FleetProtocolConnectionOptions['dispatch'];
  readonly catalogPublisher?: Readonly<{ readonly accept: (publish: (event: Extract<FleetEvent, 'catalog.snapshot' | 'catalog.delta'>, body: JsonValue, eventId: string) => void) => Promise<() => void> }>;
  readonly onAuthenticated?: (connection: Readonly<{ readonly remoteInstallationId: string; readonly generation: number }>) => void;
  readonly onDisconnected?: (connection: Readonly<{ readonly remoteInstallationId: string; readonly generation: number }>) => void;
}>;

export type FleetPeerEventPublisher = (
  event: FleetEvent,
  eventId: string,
  body: JsonValue,
) => void;

function rejectUpgrade(socket: Duplex): void {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
}

export function createFleetPeerEndpoint(options: FleetPeerEndpointOptions): Readonly<{
  readonly capabilities: readonly FleetCapability[];
  readonly publish: FleetPeerEventPublisher;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
}> {
  const wss = new WebSocketServer({ noServer: true });
  const replayGuard = new FleetChallengeReplayGuard();
  const connections = new Set<FleetProtocolConnection>();
  const catalogReleases = new Map<FleetProtocolConnection, () => void>();
  let started = false;
  let accepting = false;

  wss.on('connection', (socket: WebSocket) => {
    let authenticated: Readonly<{ readonly remoteInstallationId: string; readonly generation: number }> | undefined;
    const transport: FleetWritableTransport = {
      send: (payload, callback) => socket.send(payload, (error) => callback(error ?? undefined)),
      close: (code, reason) => socket.close(code, reason),
    };
    const connection = new FleetProtocolConnection({
      local: options.local, trust: options.trust, registry: options.registry,
      replayGuard, transport, dispatch: options.dispatch,
      onAuthenticated: (connectionState) => {
        authenticated = connectionState;
        options.onAuthenticated?.(connectionState);
        const accepted = options.catalogPublisher?.accept((event, body, eventId) => connection.publish(event, eventId, body));
        if (accepted !== undefined) void accepted
          .then((release) => connections.has(connection) ? catalogReleases.set(connection, release) : release())
          .catch((error: unknown) => { if (error instanceof Error) { connection.stop(); socket.close(1011, 'fleet catalog unavailable'); return; } throw error; });
      },
    });
    connections.add(connection);
    socket.on('message', (raw: RawData) => { void connection.receive(raw); });
    socket.on('close', () => {
      catalogReleases.get(connection)?.(); catalogReleases.delete(connection); connection.stop(); connections.delete(connection);
      if (authenticated !== undefined) options.onDisconnected?.(authenticated);
    });
  });

  const routeUpgrade: UpgradeListener = (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://fleet.invalid').pathname;
    if (pathname !== '/fleet-ws') {
      for (const listener of options.browserUpgradeListeners) listener(request, socket, head);
      return;
    }
    if (!accepting || !validateFleetUpgrade(request).ok) {
      rejectUpgrade(socket);
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  };

  const start = (): void => {
    if (started) return;
    started = true;
    accepting = true;
    for (const listener of options.browserUpgradeListeners) options.server.removeListener('upgrade', listener);
    options.server.on('upgrade', routeUpgrade);
  };

  const stop = async (): Promise<void> => {
    if (!started) return;
    accepting = false;
    options.server.removeListener('upgrade', routeUpgrade);
    for (const listener of options.browserUpgradeListeners) options.server.on('upgrade', listener);
    for (const release of catalogReleases.values()) release();
    catalogReleases.clear();
    for (const connection of connections) connection.stop();
    connections.clear();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => error === undefined ? resolve() : reject(error));
    });
    started = false;
  };

  const publish: FleetPeerEventPublisher = (event, eventId, body) => {
    for (const connection of connections) connection.publish(event, eventId, body);
  };

  return { capabilities: options.local.capabilities, publish, start, stop };
}
