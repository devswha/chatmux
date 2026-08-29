import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import type { FleetProcess } from './fleet-process-lifecycle.js';
import { enrollFleetPeers } from './fleet-enrollment.js';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

type OwnedServer = Readonly<{ server: Server; process: FleetProcess }>;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test listener omitted its port.');
  return address.port;
}

function fleetProcess(server: Server, port: number, hostId: string): FleetProcess {
  return {
    role: 'peer', hostId, pid: process.pid, processGroupPid: process.pid,
    listenerPid: process.pid, port, url: `http://127.0.0.1:${port}`, logPath: '/dev/null',
    health: { status: 200, body: {} }, child: null as never,
    listenerExit: { ready: Promise.resolve(), exited: Promise.resolve() },
    closeLog: () => Promise.resolve(),
  };
}

async function peer(hostId: string, token: string): Promise<OwnedServer> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/fleet/settings') {
      response.end(JSON.stringify({ local: { installationId: hostId } }));
      return;
    }
    if (request.url === '/api/fleet/pairing-tokens' && request.method === 'POST') {
      response.statusCode = 201;
      response.end(JSON.stringify({ token }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  const port = await listen(server);
  return { server, process: fleetProcess(server, port, hostId) };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('enrollment arms Online and snapshot signals before each peer request and returns no token material', async (t) => {
  const first = await peer(HOST_A, 'a'.repeat(43));
  const second = await peer(HOST_B, 'b'.repeat(43));
  t.after(() => Promise.all([close(first.server), close(second.server)]).then(() => undefined));

  const sockets = new Set<import('ws').WebSocket>();
  const hubServer = createServer((request, response) => {
    if (request.url !== '/api/fleet/peers' || request.method !== 'POST') {
      response.statusCode = 404; response.end('{}'); return;
    }
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const input = JSON.parse(body) as { peerUrl: string; label: string };
      const hostId = input.peerUrl.includes(String(first.process.port)) ? HOST_A : HOST_B;
      response.statusCode = 201;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ peerId: hostId }));
      for (const socket of sockets) {
        socket.send(JSON.stringify({ kind: 'fleet.host_state', host: { hostId, state: 'online' } }));
        socket.send(JSON.stringify({ kind: 'fleet.catalog.snapshot', hostId, epoch: 'test', revision: 1 }));
      }
    });
  });
  const wss = new WebSocketServer({ server: hubServer, path: '/ws' });
  wss.on('connection', (socket) => sockets.add(socket));
  const hubPort = await listen(hubServer);
  t.after(async () => { wss.close(); await close(hubServer); });
  const hub = fleetProcess(hubServer, hubPort, '00000000-0000-4000-8000-000000000000');

  const enrollment = await enrollFleetPeers(hub, [first.process, second.process], 'studio');
  await enrollment.close();

  assert.deepEqual(enrollment.peers, [
    { hostId: HOST_A, label: 'studio', state: 'online', snapshotObserved: true },
    { hostId: HOST_B, label: 'studio', state: 'online', snapshotObserved: true },
  ]);
  assert.equal(JSON.stringify(enrollment).includes('a'.repeat(43)), false);
  assert.equal(enrollment.frames().filter((frame) => frame.kind === 'fleet.catalog.snapshot').length, 2);
});
