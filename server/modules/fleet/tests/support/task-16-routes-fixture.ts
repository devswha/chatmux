/**
 * Real HTTP fixture for the Todo 16 host-qualified chat/inventory/spawn routes.
 *
 * Two peers carry the SAME local session and project ids as the local host, so
 * every assertion in the suite is about which host a request reached, never
 * about which id it named.
 */

import { createServer, type Server } from 'node:http';

import express from 'express';

import type { JsonValue } from '../../../../../shared/fleet.js';
import type { HubPeerStatus } from '../../hub/connection/types.js';
import { createApiErrorMiddleware } from '../../routing/api-error-middleware.js';
import type { FleetApplicationClients, FleetApplicationRouting } from '../../routing/application-routing.js';
import { createHostQualifiedRoutes } from '../../routing/host-qualified.routes.js';
import { FleetHostRouter } from '../../routing/host-router.js';

export const LOCAL_HOST = '11111111-1111-4111-8111-111111111111';
export const PEER_A = '22222222-2222-4222-8222-222222222222';
export const PEER_B = '33333333-3333-4333-8333-333333333333';
export const COLLIDING_SESSION = 'session-collision';
export const COLLIDING_PROJECT = 'project-collision';

const ALL_CAPABILITIES: HubPeerStatus['capabilities'] = [
  'catalog.read', 'session.read', 'chat.control', 'prompt.respond',
  'pane.read', 'terminal.attach', 'terminal.input', 'session.spawn', 'session.terminate',
];

export function peerStatus(
  peerId: string,
  state: HubPeerStatus['state'] = 'online',
  capabilities: HubPeerStatus['capabilities'] = ALL_CAPABILITIES,
): HubPeerStatus {
  return {
    peerId, state, protocolVersion: 'fleet/1', capabilities,
    peerProcessEpoch: `${peerId}-process`, generation: 4, lastHeartbeatAtMs: 1,
  };
}

export type RemoteCall = Readonly<{ readonly hostId: string; readonly method: string; readonly localId: string }>;

function localSpawn(record: (call: RemoteCall) => void): FleetApplicationRouting['localSpawn'] {
  return {
    spawn: async (projectLocalId, input) => {
      record({ hostId: LOCAL_HOST, method: 'spawn', localId: projectLocalId });
      return { ok: true, name: input.name, cwd: input.cwd };
    },
  };
}

function localReads(record: (call: RemoteCall) => void): FleetApplicationRouting['localReads'] {
  const note = (method: string, localId: string): void => record({ hostId: LOCAL_HOST, method, localId });
  return {
    sessionMetadata: async (localId) => { note('metadata', localId); return { source: 'local' }; },
    history: async (localId) => { note('history', localId); return { source: 'local' }; },
    search: async (localId, options) => { note('search', localId); return { source: 'local', query: options.query }; },
    prompt: async (localId) => { note('prompt', localId); return { prompt: 'local-prompt' }; },
    approval: async (localId) => { note('approval', localId); return { approval: 'local-approval' }; },
    capturePane: async (target) => { note('capturePane', target.localId); return { source: 'local' }; },
    providerInventory: async (localId) => { note('inventory', localId); return { provider: 'gjc', commands: [] }; },
    chatSubscription: async (localId) => { note('chatSubscription', localId); return { isProcessing: false, lastSeq: 0, events: [] }; },
    pathSuggestions: async (localId, prefix) => { note('pathSuggestions', localId); return { suggestions: [`local/${prefix}`] }; },
  };
}

function remoteClients(record: (call: RemoteCall) => void, fail: () => Error | null): FleetApplicationClients {
  const note = <T extends JsonValue>(method: string, hostId: string, localId: string, value: T): Promise<T> => {
    record({ hostId, method, localId });
    const error = fail();
    return error === null ? Promise.resolve(value) : Promise.reject(error);
  };
  return {
    reads: {
      metadata: (target) => note('metadata', target.hostId, target.localId, { source: target.hostId }),
      history: (target) => note('history', target.hostId, target.localId, { source: target.hostId }),
      search: (target, options) => note('search', target.hostId, target.localId, { source: target.hostId, query: options.query }),
      capturePane: (target) => note('capturePane', target.hostId, target.localId, { source: target.hostId }),
      providerInventory: (target) => note('inventory', target.hostId, target.localId, { provider: 'codex', commands: [{ name: 'peer-skill', description: '', scope: 'project' }] }),
      chatSubscription: (target, _deadline, lastSeq) => note('chatSubscription', target.hostId, target.localId, { isProcessing: false, lastSeq, events: [] }),
      prompt: (target) => note('prompt', target.hostId, target.localId, { prompt: target.hostId }),
      approval: (target) => note('approval', target.hostId, target.localId, { approval: target.hostId }),
      pathSuggestions: (target, options) => note('pathSuggestions', target.hostId, target.localId, { suggestions: [`${target.hostId}/${options.prefix}`] }),
    },
    mutations: {
      sendChat: (target) => note('sendChat', target.hostId, target.localId, { ok: true }),
      abortChat: (target) => note('abortChat', target.hostId, target.localId, { ok: true }),
      respondPrompt: (target) => note('respondPrompt', target.hostId, target.localId, { action: 'selected' }),
      respondApproval: (target) => note('respondApproval', target.hostId, target.localId, { ok: true }),
      sendPane: (target) => note('sendPane', target.hostId, target.localId, { ok: true }),
      interrupt: (target) => note('interrupt', target.hostId, target.localId, { ok: true }),
      escape: (target) => note('escape', target.hostId, target.localId, { ok: true }),
      terminateProcess: (target) => note('terminateProcess', target.hostId, target.localId, { ok: true }),
      terminatePane: (target) => note('terminatePane', target.hostId, target.localId, { ok: true }),
      terminateSession: (target) => note('terminateSession', target.hostId, target.localId, { ok: true }),
      spawn: (target, input) => note('spawn', target.hostId, target.localId, { ok: true, name: input.name, cwd: input.cwd }),
    },
    terminals: { attach: () => { throw new TypeError('terminal attach is out of scope'); } },
  };
}

export type RoutesFixture = Readonly<{
  readonly baseUrl: string;
  readonly server: Server;
  readonly statuses: Map<string, HubPeerStatus>;
  readonly calls: readonly RemoteCall[];
  readonly failNextRemote: (error: Error | null) => void;
  readonly peerLookups: () => number;
}>;

export async function startRoutesFixture(): Promise<RoutesFixture> {
  const calls: RemoteCall[] = [];
  let lookups = 0;
  let remoteFailure: Error | null = null;
  const statuses = new Map<string, HubPeerStatus>([[PEER_A, peerStatus(PEER_A)], [PEER_B, peerStatus(PEER_B)]]);
  const routing: FleetApplicationRouting = {
    router: new FleetHostRouter({
      localHostId: LOCAL_HOST,
      clients: remoteClients((call) => calls.push(call), () => remoteFailure),
      status: (hostId) => { lookups += 1; return statuses.get(hostId); },
    }),
    localReads: localReads((call) => calls.push(call)),
    localSpawn: localSpawn((call) => calls.push(call)),
    subscribeFrames: () => () => undefined,
  };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    Object.defineProperty(request, 'user', {
      value: request.headers['x-role'] === 'user' ? { id: 2, tailscaleRole: 'user' } : { id: 1, tailscaleRole: 'owner' },
    });
    next();
  });
  app.use(createHostQualifiedRoutes(() => routing));
  app.use(createApiErrorMiddleware(() => undefined));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('fixture address unavailable');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    statuses,
    calls,
    failNextRemote: (error) => { remoteFailure = error; },
    peerLookups: () => lookups,
  };
}

export async function closeFixture(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

export function errorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || !('error' in body)) return undefined;
  const error = body.error;
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
