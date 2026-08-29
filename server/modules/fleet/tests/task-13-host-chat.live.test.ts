import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import type { JsonValue } from '../../../../shared/fleet.js';
import type { FleetProtocolFrame } from '../protocol/types.js';
import type { FleetApplicationRouting } from '../routing/application-routing.js';
import { createHostQualifiedChatConnectionHandler } from '../routing/chat-websocket-routing.js';
import { FleetHostRouter } from '../routing/host-router.js';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const REMOTE = '22222222-2222-4222-8222-222222222222';
const REMOTE_B = '33333333-3333-4333-8333-333333333333';

function nextMessage(socket: WebSocket): Promise<Readonly<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', listener); reject(new TypeError('websocket response timeout')); }, 1_000);
    const listener = (raw: Buffer): void => {
      clearTimeout(timer); socket.off('message', listener);
      const value: unknown = JSON.parse(raw.toString());
      if (value === null || typeof value !== 'object' || Array.isArray(value)) { reject(new TypeError('websocket response malformed')); return; }
      resolve(Object.fromEntries(Object.entries(value)));
    };
    socket.on('message', listener);
  });
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new TypeError('websocket open timeout')); }, 1_000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

async function close(server: Server, wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

test('Given a real host-qualified chat socket, when remote and exact-local frames arrive, then remote never invokes local and local delegates unchanged', async (context) => {
  // Given
  const remoteCalls: string[] = [];
  let localCalls = 0;
  let frameListener: ((hostId: string, frame: FleetProtocolFrame) => void) | undefined;
  const localReads: FleetApplicationRouting['localReads'] = {
    sessionMetadata: async () => null, history: async () => null, search: async () => null,
    prompt: async () => null, approval: async () => null, capturePane: async () => null,
    providerInventory: async () => null, chatSubscription: async () => null,
    pathSuggestions: async () => null,
  };
  const clients: FleetApplicationRouting['router'] extends FleetHostRouter<infer T> ? T : never = {
    reads: {
      metadata: async (): Promise<JsonValue> => null,
      chatSubscription: async (target, _deadline, lastSeq): Promise<JsonValue> => {
        remoteCalls.push(`subscribe:${target.hostId}:${lastSeq}`);
        return { isProcessing: true, lastSeq, events: [] };
      },
      history: async (): Promise<JsonValue> => null, search: async (): Promise<JsonValue> => null,
      capturePane: async (): Promise<JsonValue> => null, providerInventory: async (): Promise<JsonValue> => null,
      prompt: async (): Promise<JsonValue> => null, approval: async (): Promise<JsonValue> => null,
      pathSuggestions: async (): Promise<JsonValue> => null,
    },
    mutations: {
      sendChat: async (target) => { remoteCalls.push(`send:${target.hostId}`); return { accepted: true }; },
      abortChat: async (target) => { remoteCalls.push(`abort:${target.hostId}`); return { aborted: true }; },
      respondPrompt: async (target) => { remoteCalls.push(`prompt:${target.hostId}`); return { selected: true }; },
      respondApproval: async (target) => { remoteCalls.push(`approval:${target.hostId}`); return { approved: true }; },
      sendPane: async () => null,
      interrupt: async () => null,
      escape: async () => null,
      terminateProcess: async () => null,
      terminatePane: async () => null,
      terminateSession: async () => null,
      spawn: async (target) => { remoteCalls.push(`spawn:${target.hostId}`); return { ok: true }; },
    },
    terminals: { attach: async () => { throw new TypeError('unused terminal'); } },
  };
  const routing: FleetApplicationRouting = {
    localReads,
    localSpawn: { spawn: async () => { localCalls += 1; return { ok: true }; } },
    subscribeFrames: (listener) => { frameListener = listener; return () => { frameListener = undefined; }; },
    router: new FleetHostRouter({
      localHostId: LOCAL, clients,
      status: (hostId) => hostId === REMOTE || hostId === REMOTE_B
        ? { peerId: hostId, state: 'online', protocolVersion: 'fleet/1', capabilities: ['session.read', 'chat.control', 'prompt.respond'], peerProcessEpoch: `peer-${hostId}`, generation: 1, lastHeartbeatAtMs: 1 }
        : undefined,
    }),
  };
  const handler = createHostQualifiedChatConnectionHandler(() => routing);
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, request) => {
    const authenticated = Object.assign(request, { user: { id: 1, tailscaleRole: 'owner' } });
    handler(socket, authenticated, (raw) => { localCalls += 1; socket.send(raw); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('websocket fixture address unavailable');
  context.after(() => close(server, wss));

  // When
  const remote = await connect(`ws://127.0.0.1:${address.port}`);
  const accepted = [
    { frame: { type: 'chat.send', hostId: REMOTE, sessionId: 'same', content: 'peer-a' }, kind: 'chat_accepted' },
    { frame: { type: 'chat.send', hostId: REMOTE_B, sessionId: 'same', content: 'peer-b' }, kind: 'chat_accepted' },
    { frame: { type: 'chat.abort', hostId: REMOTE, sessionId: 'same' }, kind: 'chat_aborted' },
    { frame: { type: 'chat.subscribe', hostId: REMOTE, sessionId: 'same', lastSeq: 7 }, kind: 'chat_subscribed' },
    { frame: { type: 'chat.permission-response', hostId: REMOTE, sessionId: 'same', allow: true }, kind: 'chat_permission_resolved' },
    { frame: { type: 'chat.prompt-response', hostId: REMOTE, sessionId: 'same', promptId: 'prompt-1', response: 'choices', choices: [1] }, kind: 'chat_prompt_resolved' },
    { frame: { type: 'chat.prompt-response', hostId: REMOTE, sessionId: 'same', promptId: 'prompt-2', response: 'custom', message: 'peer response' }, kind: 'chat_prompt_resolved' },
    { frame: { type: 'chat.approval-response', hostId: REMOTE, sessionId: 'same', decision: 'reject' }, kind: 'chat_approval_resolved' },
  ] as const;
  for (const scenario of accepted) {
    const reply = nextMessage(remote);
    remote.send(JSON.stringify(scenario.frame));
    assert.equal((await reply).kind, scenario.kind);
  }
  const streamed = nextMessage(remote);
  frameListener?.(REMOTE, {
    kind: 'event', protocolVersion: 'fleet/1', connectionGeneration: 1,
    eventId: 'delta-8', event: 'chat.delta', hostId: REMOTE,
    body: { kind: 'stream_delta', id: 'delta-8', sessionId: 'same', provider: 'gjc', timestamp: '2026-01-01T00:00:00Z', content: 'peer stream', seq: 8 },
  });
  assert.equal((await streamed).content, 'peer stream');
  const unknownReply = nextMessage(remote);
  remote.send(JSON.stringify({ type: 'chat.unsupported', hostId: REMOTE, sessionId: 'same' }));
  const unknown = await unknownReply;
  const local = await connect(`ws://127.0.0.1:${address.port}`);
  const localReply = nextMessage(local);
  local.send(JSON.stringify({ type: 'chat.send', hostId: LOCAL, sessionId: 'same', content: 'local' }));
  const localFrame = await localReply;

  // Then
  assert.equal(unknown.kind, 'protocol_error');
  assert.equal(unknown.code, 'FLEET_UNKNOWN_OPERATION');
  assert.equal(localFrame.hostId, LOCAL);
  assert.deepEqual(remoteCalls, [
    `send:${REMOTE}`, `send:${REMOTE_B}`, `abort:${REMOTE}`, `subscribe:${REMOTE}:7`,
    `approval:${REMOTE}`, `prompt:${REMOTE}`, `prompt:${REMOTE}`, `approval:${REMOTE}`,
  ]);
  assert.equal(localCalls, 1);
  remote.close(); local.close();
});
