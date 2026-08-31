import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';
import { WebSocket } from 'ws';

import { FLEET_PROTOCOL_VERSION } from '../../../../shared/fleet.js';
import { createWebSocketServer } from '../../websocket/index.js';

import { createFleetBrowserDiscovery } from './browser-discovery.js';
import { createFleetBrowserDiscoveryRouter } from './browser-discovery.routes.js';
import { fleetBrowserDiscoveryGateway } from './gateway.js';

const LOCAL = randomUUID();
const PEER = randomUUID();

function authority() {
  return createFleetBrowserDiscovery({
    local: { hostId: LOCAL, displayLabel: 'controller', capabilities: ['catalog.read'] },
    peers: { list: () => [{ peerId: PEER, displayLabel: 'studio', enrollmentState: 'enrolled' }] },
    registry: {
      listStatuses: () => [{
        peerId: PEER,
        state: 'online',
        protocolVersion: FLEET_PROTOCOL_VERSION,
        capabilities: ['catalog.read'],
        peerProcessEpoch: 'peer-epoch',
        generation: 1,
        lastHeartbeatAtMs: 1,
      }],
      subscribeStatus: () => () => undefined,
      requestCatalogSnapshot: () => 'requested',
    },
    catalog: { host: () => undefined, subscribe: () => () => undefined },
  });
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function stop(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function nextFrame(socket: WebSocket): Promise<Readonly<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (payload) => resolve(JSON.parse(String(payload)) as Readonly<Record<string, unknown>>));
    socket.once('error', reject);
  });
}

test('Given owner and allowlisted HTTP users, when hosts are requested, then only the owner receives descriptors', async () => {
  const discovery = authority();
  fleetBrowserDiscoveryGateway.bind(discovery);
  const app = express();
  app.use((request, _response, next) => {
    Object.defineProperty(request, 'user', {
      value: { id: 1, tailscaleRole: request.headers['x-role'] === 'owner' ? 'owner' : 'user' },
    });
    next();
  });
  app.use('/api', createFleetBrowserDiscoveryRouter('tailscale'));
  const server = createServer(app);
  const port = await listen(server);
  try {
    const owner = await fetch(`http://127.0.0.1:${port}/api/fleet/hosts`, { headers: { 'x-role': 'owner' } });
    const ordinary = await fetch(`http://127.0.0.1:${port}/api/fleet/hosts`, { headers: { 'x-role': 'user' } });

    assert.equal(owner.status, 200);
    assert.deepEqual((await owner.json() as { data: { hosts: readonly { hostId: string }[] } }).data.hosts.map((host) => host.hostId), [LOCAL, PEER]);
    assert.equal(ordinary.status, 403);
    assert.equal(JSON.stringify(await ordinary.json()).includes(PEER), false);
  } finally {
    await stop(server);
    fleetBrowserDiscoveryGateway.unbind(discovery);
  }
});

test('Given an available fleet authority, when identity is requested, then only the owner receives the local installation id', async () => {
  const discovery = authority();
  fleetBrowserDiscoveryGateway.bind(discovery);
  const app = express();
  app.use((request, _response, next) => {
    Object.defineProperty(request, 'user', {
      value: { id: 1, tailscaleRole: request.headers['x-role'] === 'owner' ? 'owner' : 'user' },
    });
    next();
  });
  app.use('/api', createFleetBrowserDiscoveryRouter('tailscale'));
  const server = createServer(app);
  const port = await listen(server);
  try {
    const owner = await fetch(`http://127.0.0.1:${port}/api/fleet/identity`, { headers: { 'x-role': 'owner' } });
    const ordinary = await fetch(`http://127.0.0.1:${port}/api/fleet/identity`, { headers: { 'x-role': 'user' } });

    assert.equal(owner.status, 200);
    assert.deepEqual(await owner.json(), { data: { installationId: LOCAL } });
    assert.equal(ordinary.status, 403);
    assert.equal(JSON.stringify(await ordinary.json()).includes(LOCAL), false);
  } finally {
    await stop(server);
    fleetBrowserDiscoveryGateway.unbind(discovery);
  }
});

test('Given the authenticated app websocket, when the owner subscribes, then the real gateway sends the roster', async () => {
  const discovery = authority();
  fleetBrowserDiscoveryGateway.bind(discovery);
  const server = createServer();
  const wss = createWebSocketServer(server, {
    verifyClient: { authenticateWebSocket: () => ({ id: 1, username: 'owner' }) },
    fleet: { authMode: 'password' },
  } as never);
  const port = await listen(server);
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    const roster = nextFrame(client);
    client.send(JSON.stringify({ type: 'fleet.subscribe', protocolVersion: FLEET_PROTOCOL_VERSION }));

    const frame = await roster;
    assert.equal(frame.kind, 'fleet.hosts');
    assert.equal(frame.localHostId, LOCAL);
    assert.equal(JSON.stringify(frame).includes(PEER), true);
  } finally {
    client.close();
    await new Promise<void>((resolve) => client.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
    await stop(server);
    fleetBrowserDiscoveryGateway.unbind(discovery);
  }
});

test('Given an ordinary allowlisted websocket user, when fleet subscribe is sent, then peer metadata is withheld', async () => {
  const discovery = authority();
  fleetBrowserDiscoveryGateway.bind(discovery);
  const server = createServer();
  const wss = createWebSocketServer(server, {
    verifyClient: { authenticateWebSocket: () => ({ id: 2, username: 'user', tailscaleRole: 'user' }) },
    fleet: { authMode: 'tailscale' },
  } as never);
  const port = await listen(server);
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    const response = nextFrame(client);
    client.send(JSON.stringify({ type: 'fleet.subscribe', protocolVersion: FLEET_PROTOCOL_VERSION }));

    const frame = await response;
    assert.equal(frame.code, 'FLEET_UNAUTHORIZED');
    assert.equal(JSON.stringify(frame).includes(PEER), false);
  } finally {
    client.close();
    await new Promise<void>((resolve) => client.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
    await stop(server);
    fleetBrowserDiscoveryGateway.unbind(discovery);
  }
});
