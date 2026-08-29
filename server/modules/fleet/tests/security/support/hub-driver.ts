import { randomUUID } from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { once } from 'node:events';

import { WebSocket, type RawData } from 'ws';

import {
  parseFleetRequestEnvelope,
  type FleetCapability,
  type FleetOperation,
  type FleetReference,
  type FleetResponseEnvelope,
} from '../../../../../../shared/fleet.js';
import {
  createFleetHello,
  createFleetProof,
  negotiateFleetChallenge,
  verifyFleetProof,
} from '../../../protocol/auth.js';
import { decodeFleetFrame, encodeFleetFrame } from '../../../protocol/codec.js';
import type {
  FleetHeartbeatFrame,
  FleetHelloFrame,
  FleetProofFrame,
  FleetProtocolFrame,
} from '../../../protocol/types.js';

import type { TestInstallation } from './identities.js';

const BOUND_MS = 4_000;

export function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fleet security wait timed out: ${label}`)), BOUND_MS);
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

type FrameWaiter = Readonly<{
  predicate: (frame: FleetProtocolFrame) => boolean;
  resolve: (frame: FleetProtocolFrame) => void;
}>;

function isHello(frame: FleetProtocolFrame): frame is FleetHelloFrame { return frame.kind === 'auth.hello'; }
function isProof(frame: FleetProtocolFrame): frame is FleetProofFrame { return frame.kind === 'auth.proof'; }
function isHeartbeat(frame: FleetProtocolFrame): frame is FleetHeartbeatFrame { return frame.kind === 'heartbeat'; }

export type HubClose = Readonly<{ readonly code: number; readonly reason: string }>;

/** A real WebSocket hub endpoint speaking the real fleet protocol with real keys. */
export class HubLink {
  // Mutable logs and waiter registry: observing the wire is their documented purpose.
  readonly frames: FleetProtocolFrame[] = [];
  private readonly waiters: FrameWaiter[] = [];
  private readonly closeSignal: Promise<HubClose>;

  private constructor(private readonly socket: WebSocket) {
    this.closeSignal = new Promise<HubClose>((resolve) => {
      socket.once('close', (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString('utf8') });
      });
    });
    socket.on('message', (raw: RawData) => {
      const bytes = raw instanceof ArrayBuffer ? Buffer.from(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw;
      const frame = decodeFleetFrame(bytes);
      this.frames.push(frame);
      for (const waiter of this.waiters.filter((candidate) => candidate.predicate(frame))) waiter.resolve(frame);
    });
  }

  static async open(port: number, headers?: Readonly<Record<string, string>>): Promise<HubLink> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/fleet-ws`, { headers });
    const link = new HubLink(socket);
    await bounded(once(socket, 'open').then(() => undefined), 'fleet-ws upgrade');
    return link;
  }

  static async rejected(port: number, headers?: Readonly<Record<string, string>>): Promise<number> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/fleet-ws`, { headers });
    const status = new Promise<number>((resolve) => {
      socket.once('unexpected-response', (_request: ClientRequest, response: IncomingMessage) => {
        resolve(response.statusCode ?? 0);
      });
    });
    const failure = new Promise<number>((resolve) => {
      socket.once('error', () => resolve(-1));
    });
    const code = await bounded(Promise.race([status, failure]), 'fleet-ws rejection');
    socket.terminate();
    return code;
  }

  expectFrame<T extends FleetProtocolFrame>(
    guard: (frame: FleetProtocolFrame) => frame is T,
    label: string,
  ): Promise<T> {
    const existing = this.frames.find(guard);
    if (existing !== undefined) return Promise.resolve(existing);
    return this.expectNext(guard, label);
  }

  expectNext<T extends FleetProtocolFrame>(
    guard: (frame: FleetProtocolFrame) => frame is T,
    label: string,
  ): Promise<T> {
    const waiter = Promise.withResolvers<T>();
    this.waiters.push({
      predicate: guard,
      resolve: (frame) => { if (guard(frame)) waiter.resolve(frame); },
    });
    return bounded(waiter.promise, label);
  }

  send(frame: FleetProtocolFrame): void {
    this.socket.send(encodeFleetFrame(frame));
  }

  sendRaw(payload: string | Buffer): void {
    this.socket.send(payload);
  }

  closed(): Promise<HubClose> {
    return bounded(this.closeSignal, 'fleet-ws close');
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = this.closeSignal.then(() => undefined);
    this.socket.close();
    await closed;
  }
}

export type HandshakeOptions = Readonly<{
  readonly hub: TestInstallation;
  readonly peer: Readonly<{ readonly installationId: string; readonly publicKey: string }>;
  readonly processEpoch: string;
  readonly capabilities: readonly FleetCapability[];
}>;

export function createHubHello(options: HandshakeOptions, connectionId: string): FleetHelloFrame {
  return createFleetHello({
    role: 'hub',
    signer: options.hub.signer,
    processEpoch: options.processEpoch,
    capabilities: options.capabilities,
    transportMode: 'ssh-loopback',
    connectionId,
  });
}

/** Performs the real mutual challenge handshake; returns the activated generation. */
export async function authenticateLink(link: HubLink, options: HandshakeOptions): Promise<number> {
  const connectionId = randomUUID();
  const hello = createHubHello(options, connectionId);
  const peerHello = link.expectFrame(isHello, 'peer hello');
  const peerProof = link.expectFrame(isProof, 'peer proof');
  link.send(hello);
  const remoteHello = await peerHello;
  const negotiation = negotiateFleetChallenge(hello, remoteHello, options.peer.installationId);
  verifyFleetProof({
    proof: await peerProof,
    remoteHello,
    pinnedPublicKey: options.peer.publicKey,
    challenge: negotiation.challenge,
  });
  const heartbeat = link.expectFrame(isHeartbeat, 'first heartbeat');
  link.send(await createFleetProof({
    signer: options.hub.signer,
    role: 'hub',
    connectionId,
    challenge: negotiation.challenge,
  }));
  return (await heartbeat).connectionGeneration;
}

export async function connectAuthenticated(
  port: number,
  options: HandshakeOptions,
): Promise<Readonly<{ link: HubLink; generation: number }>> {
  const link = await HubLink.open(port);
  const generation = await authenticateLink(link, options);
  return { link, generation };
}

/** Arms the response waiter before sending, then returns the armed response promise. */
export function sendRequest(
  link: HubLink,
  input: Readonly<{
    readonly operation: FleetOperation;
    readonly target: FleetReference;
    readonly generation: number;
    readonly requestId: string;
    readonly body: Readonly<Record<string, unknown>>;
  }>,
): Promise<FleetResponseEnvelope> {
  const response = link.expectNext(
    (frame): frame is FleetResponseEnvelope => frame.kind === 'response' && frame.requestId === input.requestId,
    `response ${input.requestId}`,
  );
  link.send(parseFleetRequestEnvelope({
    kind: 'request',
    protocolVersion: 'fleet/1',
    connectionGeneration: input.generation,
    requestId: input.requestId,
    operation: input.operation,
    target: input.target,
    body: input.body,
  }));
  return response;
}

export function failureOf(response: FleetResponseEnvelope): string {
  return response.status === 'failure' ? response.error : 'not-a-failure';
}
