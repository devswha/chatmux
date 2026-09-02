import {
  FLEET_PROTOCOL_VERSION,
  type FleetEvent,
  type FleetRequestEnvelope,
  type FleetResponseEnvelope,
  type JsonValue,
} from '../../../../shared/fleet.js';

import {
  createFleetHello,
  createFleetProof,
  FleetAuthDeadline,
  negotiateFleetChallenge,
  requireAuthorizedFleetPeer,
  verifyFleetProof,
} from './auth.js';
import { FleetBoundedWriter } from './bounded-writer.js';
import { assertFleetCapability, capabilityForEvent, capabilityForOperation } from './capabilities.js';
import { decodeFleetFrame, encodeFleetFrame } from './codec.js';
import type {
  FleetAuthenticatedConnection,
  FleetAwaitingProof,
  FleetConnectionState,
  FleetProtocolConnectionOptions,
  FleetProtocolScheduler,
  FleetScheduledTask,
} from './connection-types.js';
import { FleetProtocolError } from './errors.js';
import { FleetRequestLedger, type FleetRequestAdmission } from './request-ledger.js';
import { FleetHeartbeatLease } from './state-machine.js';
import type { FleetHelloFrame } from './types.js';

const systemScheduler: FleetProtocolScheduler = {
  now: () => Date.now(),
  schedule: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timer) };
  },
};

export class FleetProtocolConnection {
  private state: FleetConnectionState = { kind: 'awaiting_hello' };
  private readonly scheduler: FleetProtocolScheduler;
  private readonly deadline: FleetAuthDeadline;
  private readonly writer: FleetBoundedWriter;
  private readonly ledger: FleetRequestLedger;
  private authTimer: FleetScheduledTask | undefined;
  private leaseTimer: FleetScheduledTask | undefined;
  private incoming = Promise.resolve();

  constructor(private readonly options: FleetProtocolConnectionOptions) {
    this.scheduler = options.scheduler ?? systemScheduler;
    this.deadline = new FleetAuthDeadline(this.scheduler.now());
    this.writer = new FleetBoundedWriter(options.transport, options.writer);
    this.ledger = new FleetRequestLedger(options.requestCapacity);
    this.authTimer = this.scheduler.schedule(5_000, () => this.expireAuth());
  }

  receive(raw: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    this.incoming = this.incoming.then(() => this.handle(raw)).catch((error: unknown) => this.reject(error));
    return this.incoming;
  }

  publish(event: FleetEvent, eventId: string, body: JsonValue): void {
    if (this.state.kind !== 'authenticated') return;
    assertFleetCapability(this.state.capabilities, capabilityForEvent(event));
    this.send({
      kind: 'event', protocolVersion: FLEET_PROTOCOL_VERSION,
      connectionGeneration: this.state.generation, eventId, event,
      hostId: this.options.local.signer.installationId, body,
    });
  }

  stop(): void {
    const current = this.state;
    this.state = { kind: 'closed' };
    this.authTimer?.cancel();
    this.leaseTimer?.cancel();
    if (current.kind === 'authenticated') {
      this.options.registry.release(current.remoteInstallationId, current.generation);
    }
  }

  private async handle(raw: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    if (this.state.kind === 'closed') return;
    const frame = decodeFleetFrame(raw);
    switch (this.state.kind) {
      case 'awaiting_hello':
        if (frame.kind !== 'auth.hello') throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'authentication hello required');
        await this.acceptHello(frame);
        return;
      case 'awaiting_proof':
        if (frame.kind !== 'auth.proof') throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'authentication proof required');
        await this.acceptProof(frame, this.state);
        return;
      case 'authenticated':
        await this.acceptAuthenticated(frame, this.state);
        return;
    }
  }

  private async acceptHello(remoteHello: FleetHelloFrame): Promise<void> {
    this.deadline.assertOpen(this.scheduler.now());
    const pinned = await requireAuthorizedFleetPeer(this.options.trust, remoteHello.installationId);
    const localHello = this.options.createHello?.(remoteHello.connectionId)
      ?? createFleetHello({ ...this.options.local, connectionId: remoteHello.connectionId });
    const negotiation = negotiateFleetChallenge(localHello, remoteHello, pinned.installationId);
    const proof = await createFleetProof({
      signer: this.options.local.signer,
      role: this.options.local.role,
      connectionId: remoteHello.connectionId,
      challenge: negotiation.challenge,
    });
    this.state = {
      kind: 'awaiting_proof', remoteHello, pinnedPublicKey: pinned.pinnedPublicKey,
      challenge: negotiation.challenge, challengeId: negotiation.challengeId, capabilities: negotiation.capabilities,
    };
    this.send(localHello);
    this.send(proof);
  }

  private async acceptProof(proof: Extract<ReturnType<typeof decodeFleetFrame>, { readonly kind: 'auth.proof' }>, pending: FleetAwaitingProof): Promise<void> {
    this.deadline.assertOpen(this.scheduler.now());
    verifyFleetProof({ proof, remoteHello: pending.remoteHello, pinnedPublicKey: pending.pinnedPublicKey, challenge: pending.challenge });
    if (!this.options.replayGuard.reserve(pending.challengeId)) {
      throw new FleetProtocolError('AUTH_REPLAYED', 'fleet authentication replay rejected');
    }
    const generation = await this.options.registry.activate(pending.remoteHello.installationId, this.options.transport);
    const lease = new FleetHeartbeatLease(this.scheduler.now());
    this.state = { kind: 'authenticated', remoteInstallationId: pending.remoteHello.installationId, generation, capabilities: pending.capabilities, lease };
    this.authTimer?.cancel();
    this.send({ kind: 'heartbeat', connectionGeneration: generation, sentAtMs: Math.max(1, this.scheduler.now()) });
    this.options.onAuthenticated?.(this.state);
    this.scheduleLease();
  }

  private async acceptAuthenticated(frame: ReturnType<typeof decodeFleetFrame>, state: FleetAuthenticatedConnection): Promise<void> {
    if (frame.kind === 'auth.hello' || frame.kind === 'auth.proof') {
      throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'authentication is already complete');
    }
    this.options.registry.assertCurrent(state.remoteInstallationId, frame.connectionGeneration);
    switch (frame.kind) {
      case 'heartbeat': state.lease.received(this.scheduler.now()); return;
      case 'request':
        if (this.options.local.role !== 'peer') throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'hub endpoint cannot receive requests');
        this.acceptRequest(frame, state); return;
      case 'event':
        if (this.options.local.role !== 'hub') throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'peer endpoint cannot receive events');
        assertFleetCapability(state.capabilities, capabilityForEvent(frame.event));
        this.options.onEvent?.(frame);
        return;
      case 'response':
        if (this.options.local.role !== 'hub') throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'peer endpoint cannot receive responses');
        this.options.onResponse?.(frame); return;
    }
  }

  private acceptRequest(request: FleetRequestEnvelope, state: FleetAuthenticatedConnection): void {
    assertFleetCapability(state.capabilities, capabilityForOperation(request.operation));
    const admission = this.ledger.admit(request);
    switch (admission.kind) {
      case 'dispatch': this.dispatch(request, admission, state); return;
      case 'pending': void admission.response.then((response) => this.sendIfCurrent(response, state)).catch((error: unknown) => this.reject(error)); return;
      case 'replay': this.send(admission.response); return;
      case 'conflict': this.sendFailure(request, 'FLEET_DUPLICATE_REQUEST_CONFLICT'); return;
      case 'full': this.sendFailure(request, 'FLEET_REQUEST_CACHE_FULL'); return;
    }
  }

  private dispatch(request: FleetRequestEnvelope, admission: Extract<FleetRequestAdmission, { readonly kind: 'dispatch' }>, state: FleetAuthenticatedConnection): void {
    void this.options.dispatch(request).then((response) => {
      if (response.requestId !== request.requestId || response.connectionGeneration !== request.connectionGeneration) {
        throw new FleetProtocolError('PROTOCOL_FRAME_INVALID', 'dispatcher response does not match request');
      }
      admission.complete(response);
      this.sendIfCurrent(response, state);
    }).catch((error: unknown) => this.reject(error));
  }

  private sendIfCurrent(response: FleetResponseEnvelope, state: FleetAuthenticatedConnection): void {
    this.options.registry.assertCurrent(state.remoteInstallationId, state.generation);
    this.send(response);
  }

  private sendFailure(request: FleetRequestEnvelope, error: 'FLEET_DUPLICATE_REQUEST_CONFLICT' | 'FLEET_REQUEST_CACHE_FULL'): void {
    this.send({
      kind: 'response', protocolVersion: request.protocolVersion, connectionGeneration: request.connectionGeneration,
      requestId: request.requestId, target: request.target, status: 'failure', sideEffect: 'none', error, body: null,
    });
  }

  private send(frame: Parameters<typeof encodeFleetFrame>[0]): void {
    this.writer.send(encodeFleetFrame(frame));
  }

  /**
   * Ends the connection because the remote installation's grant was revoked.
   * Used by the owner's in-process revoke so reads, terminal streams and
   * events stop immediately instead of at the next lease tick.
   */
  revoke(): void {
    this.reject(new FleetProtocolError('AUTH_PEER_UNAUTHORIZED', 'fleet peer grant revoked'));
  }

  private scheduleLease(): void {
    this.leaseTimer = this.scheduler.schedule(10_000, () => {
      void this.checkLease().catch((error: unknown) => this.reject(error));
    });
  }

  private async checkLease(): Promise<void> {
    if (this.state.kind !== 'authenticated') return;
    const state = this.state;
    const result = state.lease.poll(this.scheduler.now());
    if (result.kind === 'expired') {
      this.reject(new FleetProtocolError('PROTOCOL_LEASE_EXPIRED', 'fleet heartbeat lease expired'));
      return;
    }
    // The trust store was consulted at hello; re-check it on every lease tick
    // so a grant the owner revoked (in this process or from the CLI) cuts off
    // reads, terminal streams and events within one interval, not at the next
    // reconnect. Mutations already re-check the grant per request.
    await requireAuthorizedFleetPeer(this.options.trust, state.remoteInstallationId);
    if (this.state !== state) return;
    if (result.kind === 'heartbeat_due') {
      this.send({ kind: 'heartbeat', connectionGeneration: state.generation, sentAtMs: Math.max(1, this.scheduler.now()) });
      state.lease.markSent(this.scheduler.now());
    }
    this.scheduleLease();
  }

  private expireAuth(): void {
    if (this.state.kind === 'awaiting_hello' || this.state.kind === 'awaiting_proof') {
      this.reject(new FleetProtocolError('AUTH_DEADLINE_EXCEEDED', 'fleet authentication deadline exceeded'));
    }
  }

  private reject(error: unknown): void {
    if (this.state.kind === 'closed') return;
    const code = error instanceof FleetProtocolError ? error.code : 'PROTOCOL_FRAME_INVALID';
    this.options.onError?.(code);
    const auth = this.state.kind === 'awaiting_hello' || this.state.kind === 'awaiting_proof';
    this.options.transport.close(auth ? 4003 : 4002, auth ? 'fleet authentication rejected' : 'fleet protocol rejected');
    this.stop();
  }
}
