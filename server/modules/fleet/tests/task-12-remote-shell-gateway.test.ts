import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetResponseEnvelope } from '../../../../shared/fleet.js';
import { RemoteTerminalClient, RemoteTerminalShellGateway, type RemoteTerminalChannel, type RemoteTerminalShellSocket } from '../terminal/index.js';
import type { HubPeerStatus } from '../hub/connection/types.js';
import type { FleetProtocolFrame } from '../protocol/types.js';

const HOST = '11111111-1111-4111-8111-111111111111';
const target = {
  kind: 'pane', hostId: HOST, localId: 'session-1', lane: 'external',
  tmux: { socketPath: '/tmp/peer.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
  process: { pid: 42, startedAtMs: 100 },
} as const;
const status: HubPeerStatus = { peerId: HOST, state: 'online', protocolVersion: 'fleet/1', capabilities: ['terminal.attach', 'terminal.input', 'pane.read'], peerProcessEpoch: 'process-1', generation: 7, lastHeartbeatAtMs: 1 };

class Channel implements RemoteTerminalChannel {
  private readonly frameListeners = new Set<(hostId: string, frame: FleetProtocolFrame) => void>();
  private readonly statusListeners = new Set<(status: HubPeerStatus) => void>();
  private readonly sendListeners = new Set<(frame: Extract<FleetProtocolFrame, { readonly kind: 'request' }>) => void>();
  status(): HubPeerStatus { return status; }
  send(hostId: string, frame: FleetProtocolFrame): boolean {
    if (hostId === HOST && frame.kind === 'request') for (const listener of this.sendListeners) listener(frame);
    return true;
  }
  subscribeFrames(listener: (hostId: string, frame: FleetProtocolFrame) => void): () => void { this.frameListeners.add(listener); return () => this.frameListeners.delete(listener); }
  subscribeStatus(listener: (status: HubPeerStatus) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  nextRequest(): Promise<Extract<FleetProtocolFrame, { readonly kind: 'request' }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.sendListeners.delete(listener); reject(new TypeError('request timeout')); }, 1_000);
      const listener = (frame: Extract<FleetProtocolFrame, { readonly kind: 'request' }>): void => { clearTimeout(timer); this.sendListeners.delete(listener); resolve(frame); };
      this.sendListeners.add(listener);
    });
  }
  respond(request: Extract<FleetProtocolFrame, { readonly kind: 'request' }>, body: FleetResponseEnvelope['body']): void {
    const response: FleetResponseEnvelope = { kind: 'response', protocolVersion: 'fleet/1', connectionGeneration: request.connectionGeneration, requestId: request.requestId, target: request.target, status: 'success', sideEffect: 'applied', body };
    for (const listener of this.frameListeners) listener(HOST, response);
  }
  output(): void {
    const frame = { kind: 'event', protocolVersion: 'fleet/1', connectionGeneration: 7, eventId: 'output-1', event: 'pane.output', hostId: HOST, body: { terminalSessionId: 'terminal-1', streamEpoch: 'stream-1', peerProcessEpoch: 'process-1', seq: 1, data: 'peer output', replay: false, leaseToken: 'event-lease' } } as const;
    for (const listener of this.frameListeners) listener(HOST, frame);
  }
}
class Socket implements RemoteTerminalShellSocket {
  bufferedAmount = 0;
  open = true;
  readonly sent: string[] = [];
  private readonly messages = new Set<(raw: Buffer) => void>();
  private readonly closes = new Set<() => void>();
  private readonly sentListeners = new Set<(frame: Readonly<Record<string, unknown>>) => void>();
  send(payload: string): void {
    this.sent.push(payload); const frame: unknown = JSON.parse(payload);
    if (frame !== null && typeof frame === 'object' && !Array.isArray(frame)) for (const listener of this.sentListeners) listener(Object.fromEntries(Object.entries(frame)));
  }
  close(): void { if (!this.open) return; this.open = false; for (const listener of this.closes) listener(); }
  onMessage(listener: (raw: Buffer) => void): void { this.messages.add(listener); }
  onClose(listener: () => void): void { this.closes.add(listener); }
  message(frame: Readonly<Record<string, unknown>>): void { for (const listener of this.messages) listener(Buffer.from(JSON.stringify(frame))); }
  next(type: string): Promise<Readonly<Record<string, unknown>>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.sentListeners.delete(listener); reject(new TypeError('frame timeout')); }, 1_000);
      const listener = (frame: Readonly<Record<string, unknown>>): void => {
        if (frame.type !== type) return; clearTimeout(timer); this.sentListeners.delete(listener); resolve(frame);
      };
      this.sentListeners.add(listener);
    });
  }
}

test('browser protocol attaches peer A, types, resizes, receives output, and never supplies a command', async () => {
  // Given
  const channel = new Channel(); const client = new RemoteTerminalClient(channel); const gateway = new RemoteTerminalShellGateway(); gateway.bind(client);
  const socket = new Socket(); gateway.handle(socket, { id: 'owner-1', owner: true });
  const attachRequest = channel.nextRequest(); const replayFrame = socket.next('replay_start');

  // When
  socket.message({ type: 'init', shellProtocolVersion: 2, mode: 'remote-attach', target, cols: 80, rows: 24, resume: null });
  const attach = await attachRequest;
  channel.respond(attach, { terminalSessionId: 'terminal-1', streamEpoch: 'stream-1', peerProcessEpoch: 'process-1', replay: 'redraw', lastSeq: 0 });
  assert.equal((await replayFrame).mode, 'redraw');
  const inputRequest = channel.nextRequest(); socket.message({ type: 'input', data: 'echo peer-a\r' }); const input = await inputRequest; channel.respond(input, { ok: true });
  const resizeRequest = channel.nextRequest(); socket.message({ type: 'resize', cols: 120, rows: 40 }); const resize = await resizeRequest; channel.respond(resize, { ok: true });
  const outputFrame = socket.next('output'); channel.output();

  // Then
  assert.equal(input.operation, 'pane.input'); assert.equal(resize.operation, 'pane.resize');
  assert.equal((await outputFrame).data, 'peer output');
  assert.equal(JSON.stringify([attach, input, resize]).includes('initialCommand'), false);
  assert.equal(socket.sent.join('').includes('leaseToken'), false, 'opaque fleet authority never reaches the browser');
  socket.close(); gateway.unbind(client); client.dispose();
});

test('non-owner browser is rejected before remote attach admission', async () => {
  // Given
  const channel = new Channel(); const client = new RemoteTerminalClient(channel); const gateway = new RemoteTerminalShellGateway(); gateway.bind(client);
  const socket = new Socket(); gateway.handle(socket, { id: 'user-2', owner: false }); const errorFrame = socket.next('error');

  // When
  socket.message({ type: 'init', shellProtocolVersion: 2, mode: 'remote-attach', target, cols: 80, rows: 24, resume: null });

  // Then
  assert.match(String((await errorFrame).message), /owner/); assert.equal(socket.open, false);
  gateway.unbind(client); client.dispose();
});
