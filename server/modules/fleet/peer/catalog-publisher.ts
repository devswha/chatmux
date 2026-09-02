import { randomUUID } from 'node:crypto';

import type { FleetEvent, JsonValue } from '../../../../shared/fleet.js';
import { boundCatalogMaterial, CATALOG_BODY_BUDGET_BYTES, measureCatalogBody } from '../catalog/bounds.js';
import type { FleetCatalogChange, FleetCatalogDelta, FleetCatalogSnapshot, FleetCatalogSourceMaterial } from '../catalog/types.js';

type PublisherOptions = Readonly<{
  readonly epoch: string;
  readonly read: () => Promise<FleetCatalogSourceMaterial>;
  readonly subscribe: (listener: () => void) => () => void;
  /** Largest catalog body put on the wire; tests lower it to exercise the bound. */
  readonly budgetBytes?: number;
}>;
export type CatalogPublish = (event: Extract<FleetEvent, 'catalog.snapshot' | 'catalog.delta'>, body: JsonValue, eventId: string) => void;
function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('catalog contains a non-finite number'); return value; }
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value !== 'object') throw new TypeError('catalog contains a non-JSON value');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(item)]));
}
function objectId(value: unknown): string { if (typeof value !== 'object' || value === null || !('localId' in value) || typeof value.localId !== 'string') throw new TypeError('catalog row lacks localId'); return value.localId; }
function changed<T>(previous: readonly T[], next: readonly T[], create: (op: 'upsert' | 'remove', row: T) => FleetCatalogChange): FleetCatalogChange[] {
  const before = new Map(previous.map((row) => [objectId(row), row])); const changes: FleetCatalogChange[] = [];
  for (const row of next) { const old = before.get(objectId(row)); before.delete(objectId(row)); if (JSON.stringify(old) !== JSON.stringify(row)) changes.push(create('upsert', row)); }
  for (const row of before.values()) changes.push(create('remove', row));
  return changes;
}
export class PeerCatalogPublisher {
  private readonly sinks = new Set<CatalogPublish>(); private revision = 0; private snapshot: FleetCatalogSnapshot | undefined;
  private unsubscribe: (() => void) | undefined; private pending = false; private running: Promise<void> | undefined; private refreshError: Error | undefined;
  constructor(private readonly options: PublisherOptions) {}
  async accept(sink: CatalogPublish): Promise<() => void> { if (this.unsubscribe === undefined) this.unsubscribe = this.options.subscribe(() => { void this.refresh().catch((error: unknown) => { if (error instanceof Error) { this.refreshError = error; return; } throw error; }); }); await this.refresh(); const current = this.snapshot; if (current === undefined) throw new TypeError('catalog snapshot unavailable'); this.sinks.add(sink); sink('catalog.snapshot', toJson(current), randomUUID()); return () => this.sinks.delete(sink); }
  async snapshotBody(): Promise<JsonValue> { await this.refresh(); const current = this.snapshot; if (current === undefined) throw new TypeError('catalog snapshot unavailable'); return toJson(current); }
  refresh(): Promise<void> { this.pending = true; if (this.running !== undefined) return this.running; const work = this.drain(); this.running = work.finally(() => { this.running = undefined; }); return this.running; }
  whenIdle(): Promise<void> { return this.running ?? Promise.resolve(); }
  currentSnapshot(): FleetCatalogSnapshot | undefined { return this.snapshot; }
  stop(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.sinks.clear(); }
  private async drain(): Promise<void> { while (this.pending) { this.pending = false; await this.update(await this.options.read()); } }
  private update(source: FleetCatalogSourceMaterial): void {
    this.refreshError = undefined;
    const budget = this.options.budgetBytes ?? CATALOG_BODY_BUDGET_BYTES;
    // RFC rev.2: the catalog is bounded to one frame before anything else looks at it.
    const { material, omitted } = boundCatalogMaterial(source, { budgetBytes: budget });
    const compose = (revision: number): FleetCatalogSnapshot => ({ epoch: this.options.epoch, revision, ...material, ...(omitted === undefined ? {} : { omitted }) });
    const previous = this.snapshot;
    if (previous === undefined) { this.revision = 1; this.snapshot = compose(this.revision); return; }
    const changes = [
      ...changed(previous.projects, material.projects, (op, row) => ({ op, entity: 'project', row })),
      ...changed(previous.sessions, material.sessions, (op, row) => ({ op, entity: 'session', row })),
      ...changed(previous.panes, material.panes, (op, row) => ({ op, entity: 'pane', row })),
      ...changed(previous.processing, material.processing, (op, row) => ({ op, entity: 'processing', row })),
    ];
    const hostChanged = JSON.stringify(previous.host) !== JSON.stringify(material.host);
    const healthChanged = JSON.stringify(previous.health) !== JSON.stringify(material.health);
    if (changes.length === 0 && !hostChanged && !healthChanged) return;
    const prevRevision = this.revision; this.revision += 1;
    this.snapshot = compose(this.revision);
    const delta: FleetCatalogDelta = { epoch: this.options.epoch, prevRevision, revision: this.revision, ...(hostChanged ? { host: material.host } : {}), changes, health: material.health };
    const deltaBody = toJson(delta);
    if (measureCatalogBody(deltaBody) > budget) {
      // A delta that cannot fit is replaced by a full snapshot at the same
      // epoch and this revision; the hub applies it as a replacement.
      const snapshotBody = toJson(this.snapshot);
      for (const sink of this.sinks) sink('catalog.snapshot', snapshotBody, randomUUID());
      return;
    }
    for (const sink of this.sinks) sink('catalog.delta', deltaBody, randomUUID());
  }
}
