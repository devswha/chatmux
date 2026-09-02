import { randomUUID } from 'node:crypto';

import { FLEET_PROTOCOL_VERSION } from '../../../../../shared/fleet.js';
import { createFleetHello, createFleetProof, negotiateFleetChallenge, verifyFleetProof, type FleetNegotiation } from '../../protocol/auth.js';
import { decodeFleetFrame, encodeFleetFrame } from '../../protocol/codec.js';
import { FleetProtocolError } from '../../protocol/errors.js';
import { parseFleetTransportTarget } from '../../protocol/transport-policy.js';
import type { FleetHelloFrame, FleetProofFrame } from '../../protocol/types.js';

import { reconnectDelayMs } from './backoff.js';
import type { HubPeerConnectionOptions, HubPeerSocket, HubPeerStatus, HubScheduledTask } from './types.js';

const AUTH_DEADLINE_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const DEGRADED_AFTER_MS = 20_000;
const OFFLINE_AFTER_MS = 30_000;

type Handshake = Readonly<{
  readonly remoteHello: FleetHelloFrame;
  readonly negotiation: FleetNegotiation;
}>;

function initialStatus(peerId: string): HubPeerStatus {
  return { peerId, state: 'offline', protocolVersion: null, capabilities: [], peerProcessEpoch: null, generation: null, lastHeartbeatAtMs: null };
}

export class HubPeerConnection {
  private status: HubPeerStatus;
  private socket: HubPeerSocket | undefined;
  private localHello: FleetHelloFrame | undefined;
  private handshake: Handshake | undefined;
  private proofVerified = false;
  private acceptedPeerEpoch: string | undefined;
  private stopped = false;
  private attempt = 0;
  private token = 0;
  private incoming = Promise.resolve();
  private authTask: HubScheduledTask | undefined;
  private heartbeatTask: HubScheduledTask | undefined;
  private degradedTask: HubScheduledTask | undefined;
  private offlineTask: HubScheduledTask | undefined;
  private reconnectTask: HubScheduledTask | undefined;

  constructor(private readonly options: HubPeerConnectionOptions) {
    this.status = initialStatus(options.peer.peerId);
  }

  start(): void {
    if (this.options.peer.enrollmentState === 'revoked') { this.transition({ state: 'revoked' }); return; }
    this.stopped = false;
    this.connect();
  }

  stop(state: 'offline' | 'revoked' = 'offline'): void {
    this.stopped = true;
    this.cancelTasks();
    this.token += 1;
    this.socket?.close(1000, state === 'revoked' ? 'fleet peer revoked' : 'fleet hub stopping');
    this.socket = undefined;
    this.transition({ state });
  }

  reconnect(): void {
    if (this.stopped) return;
    this.cancelTasks();
    this.token += 1;
    this.socket?.close(4001, 'fleet connection superseded');
    this.socket = undefined;
    this.connect();
  }

  markSynchronized(): void {
    if (this.status.state === 'syncing' && this.status.generation !== null) this.transition({ state: 'online' });
  }

  markSyncing(): void {
    if (this.status.generation !== null && (this.status.state === 'online' || this.status.state === 'degraded')) this.transition({ state: 'syncing' });
  }

  requestCatalogSnapshot(): string | undefined {
    if (this.socket === undefined || this.status.generation === null || !this.proofVerified) return undefined;
    const requestId = `catalog-resync-${randomUUID()}`;
    this.socket.send(encodeFleetFrame({ kind: 'request', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: this.status.generation, requestId, operation: 'catalog.snapshot', target: { kind: 'host', hostId: this.options.peer.peerId }, body: {} }));
    return requestId;
  }

  sendFrame(frame: Extract<Parameters<typeof encodeFleetFrame>[0], { readonly kind: 'request' }>): boolean {
    if (this.socket === undefined || !this.proofVerified || this.status.generation === null) return false;
    if (frame.connectionGeneration !== this.status.generation) return false;
    let encoded: string;
    try {
      encoded = encodeFleetFrame(frame);
    } catch (error) {
      // A request the wire cannot carry (oversized chat.send or paste) fails
      // this call only; the peer connection stays up for everything else.
      if (error instanceof FleetProtocolError && error.code === 'PROTOCOL_FRAME_TOO_LARGE') return false;
      throw error;
    }
    this.socket.send(encoded);
    return true;
  }

  whenIdle(): Promise<void> { return this.incoming; }
  currentStatus(): HubPeerStatus { return this.status; }

  private connect(): void {
    const parsed = parseFleetTransportTarget(this.options.peer.url, this.options.peer.transportMode);
    if (!parsed.ok) { this.transition({ state: 'offline' }); return; }
    this.transition({ state: 'connecting' });
    const token = this.token + 1;
    this.token = token;
    let socket: HubPeerSocket;
    try {
      socket = this.options.dial(parsed.target);
    } catch (error) {
      if (error instanceof Error) { this.scheduleReconnect(token); return; }
      throw error;
    }
    this.socket = socket;
    socket.onOpen(() => this.open(token, socket));
    socket.onMessage((raw) => {
      if (token !== this.token) return;
      this.incoming = this.incoming.then(() => this.receive(token, socket, raw)).catch((error: unknown) => this.reject(token, socket, error));
    });
    socket.onClose(() => this.closed(token));
    socket.onError(() => this.closed(token));
  }

  private open(token: number, socket: HubPeerSocket): void {
    if (token !== this.token) return;
    this.localHello = createFleetHello({ role: 'hub', signer: this.options.local.signer, processEpoch: this.options.local.processEpoch, capabilities: this.options.local.capabilities, transportMode: this.options.peer.transportMode });
    this.handshake = undefined;
    this.proofVerified = false;
    socket.send(encodeFleetFrame(this.localHello));
    this.authTask = this.options.scheduler.schedule(AUTH_DEADLINE_MS, () => { this.reject(token, socket, new FleetProtocolError('AUTH_DEADLINE_EXCEEDED', 'fleet authentication deadline exceeded')); });
  }

  private async receive(token: number, socket: HubPeerSocket, raw: Buffer): Promise<void> {
    if (token !== this.token) return;
    const frame = decodeFleetFrame(raw);
    if (frame.kind === 'auth.hello') { await this.acceptHello(socket, frame); return; }
    if (frame.kind === 'auth.proof') { this.acceptProof(frame); return; }
    if (!this.proofVerified) throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'mutual authentication required');
    if (frame.kind === 'heartbeat') { this.acceptHeartbeat(token, socket, frame.connectionGeneration); return; }
    if (this.status.generation === null || frame.connectionGeneration !== this.status.generation) throw new FleetProtocolError('PROTOCOL_STALE_GENERATION', 'connection generation is stale');
    this.options.onFrame(frame);
  }

  private async acceptHello(socket: HubPeerSocket, remoteHello: FleetHelloFrame): Promise<void> {
    if (this.handshake !== undefined || this.localHello === undefined) throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'unexpected authentication hello');
    const negotiation = negotiateFleetChallenge(this.localHello, remoteHello, this.options.peer.peerId);
    if ((this.options.requiredCapabilities ?? []).some((capability) => !negotiation.capabilities.includes(capability))) throw new FleetProtocolError('AUTH_TRANSCRIPT_MISMATCH', 'required capability is unavailable');
    this.handshake = { remoteHello, negotiation };
    socket.send(encodeFleetFrame(await createFleetProof({ signer: this.options.local.signer, role: 'hub', connectionId: this.localHello.connectionId, challenge: negotiation.challenge })));
  }

  private acceptProof(proof: FleetProofFrame): void {
    if (this.handshake === undefined) throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'authentication hello required');
    verifyFleetProof({ proof, remoteHello: this.handshake.remoteHello, pinnedPublicKey: this.options.peer.pinnedPublicKey, challenge: this.handshake.negotiation.challenge });
    this.proofVerified = true;
    this.authTask?.cancel();
    this.transition({ state: 'syncing', protocolVersion: this.handshake.negotiation.protocolVersion, capabilities: this.handshake.negotiation.capabilities, peerProcessEpoch: this.handshake.remoteHello.processEpoch, generation: null });
  }

  private acceptHeartbeat(token: number, socket: HubPeerSocket, generation: number): void {
    if (this.status.generation !== null && generation !== this.status.generation) throw new FleetProtocolError('PROTOCOL_STALE_GENERATION', 'connection generation changed in place');
    const previousEpoch = this.acceptedPeerEpoch ?? null;
    const peerProcessEpoch = this.handshake?.remoteHello.processEpoch ?? null;
    const epochChanged = previousEpoch !== null && peerProcessEpoch !== previousEpoch;
    this.acceptedPeerEpoch = peerProcessEpoch ?? undefined;
    this.attempt = 0;
    this.transition({ state: epochChanged ? 'syncing' : 'online', generation, peerProcessEpoch, lastHeartbeatAtMs: this.options.scheduler.nowMs });
    this.options.onNegotiated?.(this.status);
    socket.send(encodeFleetFrame({ kind: 'heartbeat', connectionGeneration: generation, sentAtMs: Math.max(1, this.options.scheduler.nowMs) }));
    this.scheduleHeartbeat(token, socket, generation);
    this.scheduleHealth(token, socket);
  }

  private scheduleHeartbeat(token: number, socket: HubPeerSocket, generation: number): void { this.heartbeatTask?.cancel(); this.heartbeatTask = this.options.scheduler.schedule(HEARTBEAT_INTERVAL_MS, () => { if (token !== this.token || this.status.generation !== generation) return; socket.send(encodeFleetFrame({ kind: 'heartbeat', connectionGeneration: generation, sentAtMs: Math.max(1, this.options.scheduler.nowMs) })); this.scheduleHeartbeat(token, socket, generation); }); }
  private scheduleHealth(token: number, socket: HubPeerSocket): void { this.degradedTask?.cancel(); this.offlineTask?.cancel(); this.degradedTask = this.options.scheduler.schedule(DEGRADED_AFTER_MS, () => { if (token === this.token && this.status.state === 'online') this.transition({ state: 'degraded' }); }); this.offlineTask = this.options.scheduler.schedule(OFFLINE_AFTER_MS, () => { if (token !== this.token) return; this.transition({ state: 'offline' }); socket.close(4002, 'fleet heartbeat lease expired'); this.scheduleReconnect(token); }); }
  private reject(token: number, socket: HubPeerSocket, error: unknown): void { if (token !== this.token) return; const incompatible = error instanceof FleetProtocolError && (error.message === 'required capability is unavailable' || error.message.includes('protocol versions do not overlap')); this.cancelConnectionTasks(); this.token += 1; socket.close(incompatible ? 4004 : 4003, incompatible ? 'fleet peer incompatible' : 'fleet authentication rejected'); this.socket = undefined; this.transition({ state: incompatible ? 'incompatible' : 'offline' }); if (!incompatible) this.scheduleReconnect(this.token); }
  private closed(token: number): void { if (token !== this.token || this.stopped || this.status.state === 'incompatible') return; this.cancelConnectionTasks(); this.socket = undefined; this.transition({ state: 'offline' }); this.scheduleReconnect(token); }
  private scheduleReconnect(token: number): void { if (this.stopped || this.reconnectTask !== undefined) return; const delay = reconnectDelayMs(this.attempt, this.options.random()); this.attempt += 1; this.reconnectTask = this.options.scheduler.schedule(delay, () => { this.reconnectTask = undefined; if (token === this.token && !this.stopped) this.connect(); }); }
  private cancelConnectionTasks(): void { this.authTask?.cancel(); this.heartbeatTask?.cancel(); this.degradedTask?.cancel(); this.offlineTask?.cancel(); this.authTask = undefined; this.heartbeatTask = undefined; this.degradedTask = undefined; this.offlineTask = undefined; }
  private cancelTasks(): void { this.cancelConnectionTasks(); this.reconnectTask?.cancel(); this.reconnectTask = undefined; }
  private transition(change: Partial<HubPeerStatus>): void { this.status = { ...this.status, ...change }; this.options.onStatus(this.status); }
}
