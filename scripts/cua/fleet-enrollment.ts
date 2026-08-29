import { WebSocket } from 'ws';

import type { FleetProcess } from './fleet-process-lifecycle.js';

const SIGNAL_TIMEOUT_MS = 20_000;
type Frame = Readonly<Record<string, unknown>>;
type FrameWaiter = Readonly<{
  predicate: (frame: Frame) => boolean;
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>;

export type EnrolledPeer = Readonly<{
  hostId: string;
  label: string;
  state: 'online';
  snapshotObserved: true;
}>;

export type FleetEnrollment = Readonly<{
  peers: readonly EnrolledPeer[];
  frames: () => readonly Frame[];
  close: () => Promise<void>;
}>;

async function jsonRequest(server: FleetProcess, method: string, route: string, body?: unknown): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await fetch(`${server.url}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function installationId(value: unknown): string {
  const local = object(object(value)?.local);
  if (typeof local?.installationId !== 'string') throw new Error('Fleet settings omitted the installation ID.');
  return local.installationId;
}

function pairingToken(value: unknown): string {
  const token = object(value)?.token;
  if (typeof token !== 'string') throw new Error('Pairing endpoint omitted its token.');
  return token;
}

function isState(frame: Frame, hostId: string): boolean {
  const host = object(frame.host);
  return frame.kind === 'fleet.host_state' && host?.hostId === hostId && host.state === 'online';
}

function isSnapshot(frame: Frame, hostId: string): boolean {
  return frame.kind === 'fleet.catalog.snapshot' && frame.hostId === hostId;
}

export async function enrollFleetPeers(
  hub: FleetProcess,
  peers: readonly FleetProcess[],
  label = 'studio',
): Promise<FleetEnrollment> {
  const socket = new WebSocket(`${hub.url.replace('http', 'ws')}/ws`);
  const frames: Frame[] = [];
  const waiters = new Set<FrameWaiter>();
  socket.on('message', (raw) => {
    const parsed: unknown = JSON.parse(String(raw));
    const frame = object(parsed);
    if (frame === null) return;
    frames.push(frame);
    for (const waiter of waiters) {
      if (!waiter.predicate(frame)) continue;
      clearTimeout(waiter.timeout);
      waiters.delete(waiter);
      waiter.resolve(frame);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'fleet.subscribe', protocolVersion: 'fleet/1' }));

  const waitFor = (predicate: (frame: Frame) => boolean, description: string): Promise<Frame> => (
    new Promise<Frame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${description}.`));
      }, SIGNAL_TIMEOUT_MS);
      const waiter: FrameWaiter = { predicate, resolve, reject, timeout };
      waiters.add(waiter);
    })
  );

  try {
    const enrolled: EnrolledPeer[] = [];
    for (const peer of peers) {
      const settings = await jsonRequest(peer, 'GET', '/api/fleet/settings');
      if (settings.status !== 200) throw new Error(`Peer settings returned ${settings.status}.`);
      const hostId = installationId(settings.body);
      const tokenResponse = await jsonRequest(peer, 'POST', '/api/fleet/pairing-tokens', {});
      if (tokenResponse.status !== 201) throw new Error(`Pairing token returned ${tokenResponse.status}.`);
      const online = waitFor((frame) => isState(frame, hostId), `${label} Online frame`);
      const snapshot = waitFor((frame) => isSnapshot(frame, hostId), `${label} catalog snapshot`);
      const response = await jsonRequest(hub, 'POST', '/api/fleet/peers', {
        peerUrl: `ws://127.0.0.1:${peer.port}/fleet-ws`,
        transportMode: 'ssh-loopback',
        token: pairingToken(tokenResponse.body),
        label,
      });
      if (response.status !== 201) throw new Error(`Peer enrollment returned ${response.status}: ${JSON.stringify(response.body)}`);
      await Promise.all([online, snapshot]);
      enrolled.push({ hostId, label, state: 'online', snapshotObserved: true });
    }
    return {
      peers: enrolled,
      frames: () => [...frames],
      close: () => new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
        socket.once('close', () => resolve());
        socket.close();
      }),
    };
  } catch (error) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('Enrollment stopped before the armed fleet signal arrived.'));
    }
    socket.close();
    throw error;
  }
}
