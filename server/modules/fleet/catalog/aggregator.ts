import type { FleetPeerState } from '../../../../shared/fleet.js';

import { hostQualifiedCatalogKey } from './keys.js';
import { FleetCatalogParseError, parseFleetCatalogDelta, parseFleetCatalogSnapshot } from './schema.js';
import type { FleetCatalogApplyResult, FleetCatalogChange, FleetCatalogDelta, FleetCatalogHost, FleetCatalogMaterial, FleetCatalogRows, FleetCatalogSnapshot, FleetWriteAdmission } from './types.js';

type HostEntry = Readonly<{ readonly generation: number; readonly epoch: string; readonly state: FleetPeerState; readonly stale: boolean; readonly revision: number; readonly snapshot: FleetCatalogSnapshot; readonly lastDelta: string | null }>;
export type FleetCatalogHostView = HostEntry;
export type FleetCatalogNotification =
  | Readonly<{ readonly hostId: string; readonly kind: 'snapshot'; readonly snapshot: FleetCatalogSnapshot }>
  | Readonly<{ readonly hostId: string; readonly kind: 'delta'; readonly delta: FleetCatalogDelta }>;
const result = (kind: FleetCatalogApplyResult['kind']): FleetCatalogApplyResult => ({ kind });
function unreachable(value: never): never { throw new TypeError(`unsupported peer state: ${String(value)}`); }
function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('catalog canonicalization received a non-data value');
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
function rowId(change: FleetCatalogChange): string { return change.row.localId; }
function replace<T extends Readonly<{ readonly localId: string }>>(rows: readonly T[], change: Readonly<{ readonly op: 'upsert' | 'remove'; readonly row: T }>): readonly T[] {
  const current = rows.find((row) => row.localId === change.row.localId);
  if (change.op === 'remove') return rows.filter((row) => row.localId !== change.row.localId);
  return current === undefined ? [...rows, change.row] : rows.map((row) => row.localId === change.row.localId ? change.row : row);
}
function existing(material: FleetCatalogMaterial, change: FleetCatalogChange): unknown {
  switch (change.entity) {
    case 'project': return material.projects.find((row) => row.localId === rowId(change));
    case 'session': return material.sessions.find((row) => row.localId === rowId(change));
    case 'pane': return material.panes.find((row) => row.localId === rowId(change));
    case 'processing': return material.processing.find((row) => row.localId === rowId(change));
  }
}
function apply(material: FleetCatalogMaterial, delta: FleetCatalogDelta): FleetCatalogMaterial | undefined {
  for (const change of delta.changes) if (change.op === 'remove' && canonical(existing(material, change)) !== canonical(change.row)) return undefined;
  const host: FleetCatalogHost = delta.host ?? material.host;
  let projects = material.projects; let sessions = material.sessions; let panes = material.panes; let processing = material.processing;
  for (const change of delta.changes) {
    switch (change.entity) {
      case 'project': projects = replace(projects, change); break;
      case 'session': sessions = replace(sessions, change); break;
      case 'pane': panes = replace(panes, change); break;
      case 'processing': processing = replace(processing, change); break;
    }
  }
  return { host, projects, sessions, panes, processing, health: delta.health };
}

/** In-memory display/routing authority. It never persists rows or mints action targets. */
export class FleetCatalogAggregator {
  private readonly hosts = new Map<string, HostEntry>();
  private readonly admissionStates = new Map<string, FleetPeerState>();
  private readonly pending = new Set<string>();
  private readonly listeners = new Set<(notification: FleetCatalogNotification) => void>();
  constructor(private readonly requestSnapshot: (hostId: string) => void) {}
  connected(hostId: string, generation: number, epoch: string): void {
    this.admissionStates.set(hostId, 'syncing');
    const previous = this.hosts.get(hostId);
    if (previous === undefined) return;
    this.hosts.set(hostId, { ...previous, generation, epoch, state: 'syncing', stale: true, lastDelta: null });
  }
  offline(hostId: string, state: Extract<FleetPeerState, 'offline' | 'revoked' | 'incompatible'> = 'offline'): void {
    this.admissionStates.set(hostId, state);
    const entry = this.hosts.get(hostId); if (entry !== undefined) this.hosts.set(hostId, { ...entry, state, stale: true });
  }
  snapshot(hostId: string, generation: number, epoch: string, body: unknown): FleetCatalogApplyResult {
    let next: FleetCatalogSnapshot;
    try { next = parseFleetCatalogSnapshot(body); } catch (error) { if (error instanceof FleetCatalogParseError) return this.resync(hostId); throw error; }
    if (next.host.hostId !== hostId || next.epoch !== epoch) return this.resync(hostId);
    const current = this.hosts.get(hostId);
    if (current !== undefined && (current.generation !== generation || current.epoch !== epoch)) return result('stale');
    const sameEpochSnapshot = current?.snapshot.epoch === epoch;
    if (current !== undefined && sameEpochSnapshot && next.revision < current.revision) return this.resync(hostId);
    if (current !== undefined && sameEpochSnapshot && next.revision === current.revision) {
      if (canonical(next) !== canonical(current.snapshot)) return this.resync(hostId);
      if (current.state !== 'syncing') return result('idempotent');
      this.pending.delete(hostId); this.admissionStates.set(hostId, 'online');
      this.hosts.set(hostId, { ...current, state: 'online', stale: false });
      return result('applied');
    }
    this.pending.delete(hostId); this.admissionStates.set(hostId, 'online');
    this.hosts.set(hostId, { generation, epoch, state: 'online', stale: false, revision: next.revision, snapshot: next, lastDelta: null });
    this.notify({ hostId, kind: 'snapshot', snapshot: next });
    return result('applied');
  }
  delta(hostId: string, generation: number, epoch: string, body: unknown): FleetCatalogApplyResult {
    const current = this.hosts.get(hostId); if (current === undefined || current.generation !== generation) return result('stale');
    if (current.epoch !== epoch) return this.resync(hostId);
    let next: FleetCatalogDelta;
    try { next = parseFleetCatalogDelta(body); } catch (error) { if (error instanceof FleetCatalogParseError) return this.resync(hostId); throw error; }
    const fingerprint = canonical(next);
    if (next.epoch !== epoch) return this.resync(hostId);
    if (next.revision === current.revision) return fingerprint === current.lastDelta ? result('idempotent') : this.resync(hostId);
    if (current.state === 'syncing' || next.prevRevision !== current.revision || next.revision !== current.revision + 1) return this.resync(hostId);
    const material = apply(current.snapshot, next); if (material === undefined || material.host.hostId !== hostId) return this.resync(hostId);
    const snapshot = { epoch, revision: next.revision, ...material };
    this.hosts.set(hostId, { ...current, revision: next.revision, snapshot, stale: false, lastDelta: fingerprint });
    this.notify({ hostId, kind: 'delta', delta: next });
    return result('applied');
  }
  host(hostId: string): FleetCatalogHostView | undefined { return this.hosts.get(hostId); }
  subscribe(listener: (notification: FleetCatalogNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  rows(): FleetCatalogRows {
    const projects = []; const sessions = []; const panes = []; const processing = [];
    for (const [hostId, entry] of this.hosts) {
      for (const row of entry.snapshot.projects) projects.push({ hostId, key: hostQualifiedCatalogKey(hostId, row.localId), row });
      for (const row of entry.snapshot.sessions) sessions.push({ hostId, key: hostQualifiedCatalogKey(hostId, row.localId), row });
      for (const row of entry.snapshot.panes) panes.push({ hostId, key: hostQualifiedCatalogKey(hostId, row.localId), row });
      for (const row of entry.snapshot.processing) processing.push({ hostId, key: hostQualifiedCatalogKey(hostId, row.localId), row });
    }
    return { projects, sessions, panes, processing };
  }
  admitWrite(hostId: string): FleetWriteAdmission {
    const state = this.admissionStates.get(hostId); if (state === undefined) return { ok: false, error: 'HOST_NOT_FOUND' };
    switch (state) { case 'online': case 'degraded': return { ok: true }; case 'syncing': case 'connecting': return { ok: false, error: 'HOST_SYNCING' }; case 'offline': return { ok: false, error: 'HOST_OFFLINE' }; case 'revoked': return { ok: false, error: 'HOST_REVOKED' }; case 'incompatible': return { ok: false, error: 'HOST_INCOMPATIBLE' }; default: return unreachable(state); }
  }
  private notify(notification: FleetCatalogNotification): void {
    for (const listener of this.listeners) listener(notification);
  }
  private resync(hostId: string): FleetCatalogApplyResult { this.admissionStates.set(hostId, 'syncing'); const current = this.hosts.get(hostId); if (current !== undefined) this.hosts.set(hostId, { ...current, state: 'syncing', stale: true }); if (!this.pending.has(hostId)) { this.pending.add(hostId); this.requestSnapshot(hostId); } return result('resync_required'); }
}
