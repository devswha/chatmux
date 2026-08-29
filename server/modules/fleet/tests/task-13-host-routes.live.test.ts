import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import express from 'express';

import type { JsonValue } from '../../../../shared/fleet.js';
import type { HubPeerStatus } from '../hub/connection/types.js';
import type { FleetApplicationRouting } from '../routing/application-routing.js';
import { createApiErrorMiddleware } from '../routing/api-error-middleware.js';
import { createHostQualifiedRoutes } from '../routing/host-qualified.routes.js';
import { FleetHostRouter } from '../routing/host-router.js';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const REMOTE = '22222222-2222-4222-8222-222222222222';

function status(
  peerId: string,
  state: HubPeerStatus['state'] = 'online',
  capabilities: HubPeerStatus['capabilities'] = ['session.read', 'pane.read', 'chat.control'],
): HubPeerStatus {
  return { peerId, state, protocolVersion: 'fleet/1', capabilities, peerProcessEpoch: 'peer-process', generation: 7, lastHeartbeatAtMs: 1 };
}

async function startFixture() {
  let peerLookups = 0;
  let localCalls = 0;
  let remoteCalls = 0;
  let genericReports = 0;
  const statuses = new Map<string, HubPeerStatus>([[REMOTE, status(REMOTE)]]);
  const localReads: FleetApplicationRouting['localReads'] = {
    sessionMetadata: async (localId) => { localCalls += 1; return localId === 'same' ? { source: 'local' } : null; },
    history: async () => { localCalls += 1; return { source: 'local-history' }; },
    search: async () => { localCalls += 1; return { source: 'local-search' }; },
    prompt: async () => null,
    approval: async () => null,
    capturePane: async () => { localCalls += 1; return { source: 'local-pane' }; },
    providerInventory: async () => null,
    chatSubscription: async () => null,
    pathSuggestions: async () => null,
  };
  const reads = {
    metadata: async (): Promise<JsonValue> => { remoteCalls += 1; return { source: 'remote' }; },
    history: async (): Promise<JsonValue> => { remoteCalls += 1; return { source: 'remote-history' }; },
    search: async (): Promise<JsonValue> => { remoteCalls += 1; return { source: 'remote-search' }; },
    capturePane: async (): Promise<JsonValue> => { remoteCalls += 1; return { source: 'remote-pane' }; },
    providerInventory: async (): Promise<JsonValue> => { remoteCalls += 1; return { source: 'remote-inventory' }; },
    chatSubscription: async (): Promise<JsonValue> => { remoteCalls += 1; return { isProcessing: false, lastSeq: 0, events: [] }; },
    prompt: async (): Promise<JsonValue> => { remoteCalls += 1; return { source: 'remote-prompt' }; },
    approval: async (): Promise<JsonValue> => { remoteCalls += 1; return { source: 'remote-approval' }; },
    pathSuggestions: async (): Promise<JsonValue> => { remoteCalls += 1; return { source: 'remote-suggestions' }; },
  };
  const clients: FleetApplicationRouting['router'] extends FleetHostRouter<infer T> ? T : never = {
    reads,
    mutations: {
      sendChat: async () => null,
      abortChat: async () => null,
      respondPrompt: async () => null,
      respondApproval: async () => null,
      sendPane: async () => null,
      interrupt: async () => null,
      escape: async () => null,
      terminateProcess: async () => null,
      terminatePane: async () => null,
      terminateSession: async () => null,
      spawn: async () => null,
    },
    terminals: { attach: async () => { throw new TypeError('unused terminal'); } },
  };
  const routing: FleetApplicationRouting = {
    router: new FleetHostRouter({ localHostId: LOCAL, clients, status: (hostId) => { peerLookups += 1; return statuses.get(hostId); } }),
    localReads,
    subscribeFrames: () => () => undefined,
    localSpawn: { spawn: async () => { localCalls += 1; return { source: 'local-spawn' }; } },
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    Object.defineProperty(request, 'user', { value: request.headers['x-role'] === 'user' ? { id: 2, tailscaleRole: 'user' } : { id: 1, tailscaleRole: 'owner' } });
    next();
  });
  app.get('/legacy/:sessionId', async (request, response) => {
    const result = await localReads.sessionMetadata(String(request.params.sessionId), AbortSignal.timeout(1_000));
    if (result === null) { response.status(404).json({ code: 'SESSION_NOT_FOUND' }); return; }
    response.json(result);
  });
  app.use(createHostQualifiedRoutes(() => routing));
  app.get('/generic-error', () => { throw new TypeError('sensitive generic failure'); });
  app.use(createApiErrorMiddleware(() => { genericReports += 1; }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('fixture address unavailable');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    statuses,
    counts: () => ({ peerLookups, localCalls, remoteCalls }),
    reports: () => genericReports,
  };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

function errorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || !('error' in body)) return undefined;
  const error = body.error;
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

test('Given a real server, when legacy, local-qualified, and remote-qualified reads run, then routing preserves local parity and isolates services', async (context) => {
  // Given
  const fixture = await startFixture(); context.after(() => close(fixture.server));

  // When
  const legacy = await fetch(`${fixture.baseUrl}/legacy/same`);
  const local = await fetch(`${fixture.baseUrl}/hosts/${LOCAL}/providers/sessions/same`);
  const remote = await fetch(`${fixture.baseUrl}/hosts/${REMOTE}/providers/sessions/same`);

  // Then
  assert.deepEqual(await legacy.json(), { source: 'local' });
  assert.deepEqual(await local.json(), { success: true, data: { source: 'local' } });
  assert.deepEqual(await remote.json(), { success: true, data: { source: 'remote' } });
  assert.deepEqual(fixture.counts(), { peerLookups: 1, localCalls: 2, remoteCalls: 1 });
});

test('Given missing host context or a non-owner, when requests run, then no peer search or controller fallback occurs', async (context) => {
  // Given
  const fixture = await startFixture(); context.after(() => close(fixture.server));

  // When
  const missingHost = await fetch(`${fixture.baseUrl}/legacy/remote-only`);
  const afterMissing = fixture.counts();
  const denied = await fetch(`${fixture.baseUrl}/hosts/${REMOTE}/providers/sessions/same`, { headers: { 'x-role': 'user' } });

  // Then
  assert.equal(missingHost.status, 404);
  assert.deepEqual(afterMissing, { peerLookups: 0, localCalls: 1, remoteCalls: 0 });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), {
    success: false,
    error: { code: 'FLEET_UNAUTHORIZED', message: 'Fleet owner access is required.' },
  });
  assert.deepEqual(fixture.counts(), { peerLookups: 0, localCalls: 1, remoteCalls: 0 });
});

test('Given every controlled fleet denial, when production API error middleware handles it, then exact status and code remain explicit', async (context) => {
  const fixture = await startFixture(); context.after(() => close(fixture.server));
  const unknown = '33333333-3333-4333-8333-333333333333';
  const cases = [
    { hostId: unknown, expected: 404, code: 'HOST_NOT_FOUND' },
    { state: 'revoked', expected: 410, code: 'HOST_REVOKED' },
    { state: 'offline', expected: 503, code: 'HOST_OFFLINE' },
    { state: 'degraded', expected: 503, code: 'HOST_OFFLINE' },
    { state: 'syncing', expected: 503, code: 'HOST_SYNCING' },
    { state: 'connecting', expected: 503, code: 'HOST_SYNCING' },
    { state: 'incompatible', expected: 503, code: 'HOST_INCOMPATIBLE' },
    { state: 'online', capabilities: ['pane.read'], expected: 422, code: 'FLEET_CAPABILITY_UNAVAILABLE' },
  ] as const;
  for (const scenario of cases) {
    if ('state' in scenario) fixture.statuses.set(REMOTE, status(REMOTE, scenario.state, 'capabilities' in scenario ? scenario.capabilities : undefined));
    const response = await fetch(`${fixture.baseUrl}/hosts/${'hostId' in scenario ? scenario.hostId : REMOTE}/providers/sessions/same`);
    const body: unknown = await response.json();
    assert.equal(response.status, scenario.expected);
    assert.equal(errorCode(body), scenario.code);
  }
  const generic = await fetch(`${fixture.baseUrl}/generic-error`);
  assert.equal(generic.status, 500);
  assert.deepEqual(await generic.json(), {
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
  assert.deepEqual(fixture.counts(), { peerLookups: cases.length, localCalls: 0, remoteCalls: 0 });
  assert.equal(fixture.reports(), 1);
});
