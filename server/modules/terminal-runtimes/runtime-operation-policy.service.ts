import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { RuntimeCapabilities, RuntimeCapability } from '../../../shared/terminal-runtime.js';

import type { HerdrSourceId } from './herdr-internal.types.js';

const KEYS = ['discovery', 'output', 'actions', 'attach', 'create'] as const;
type CapabilityMap = Record<RuntimeCapability, boolean>;
type PolicyDocument = { global?: Partial<CapabilityMap>; sources?: Record<string, Partial<CapabilityMap>> };
export type RuntimePolicyReload = { generation: number; changed: boolean; errorCode: string | null };

function none(): CapabilityMap { return { discovery: false, output: false, actions: false, attach: false, create: false }; }
function intersect(a: RuntimeCapabilities, b: Partial<CapabilityMap>): CapabilityMap { const result = none(); for (const key of KEYS) result[key] = a[key] === true && b[key] !== false; return result; }
function validPartial(value: unknown): value is Partial<CapabilityMap> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => KEYS.includes(key as RuntimeCapability) && typeof (value as Record<string, unknown>)[key] === 'boolean');
}
function parsePolicy(raw: string): PolicyDocument | null {
  let value: unknown; try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const document = value as Record<string, unknown>;
  if (!Object.keys(document).every((key) => key === 'global' || key === 'sources') || (document.global !== undefined && !validPartial(document.global))) return null;
  if (document.sources !== undefined && (!document.sources || typeof document.sources !== 'object' || Array.isArray(document.sources) || !Object.entries(document.sources as Record<string, unknown>).every(([id, capabilities]) => /^hsrc_[A-Za-z0-9_-]{22}$/.test(id) && validPartial(capabilities)))) return null;
  return document as PolicyDocument;
}

/** Herdr-only reductions. A bad configured policy is fail-closed, never permissive. */
export class RuntimeOperationPolicyService {
  private generationValue = 0;
  private effective = new Map<HerdrSourceId, CapabilityMap>();
  private listeners = new Set<(generation: number) => void>();
  constructor(private readonly startup: RuntimeCapabilities, private readonly sourceIds: readonly HerdrSourceId[], private readonly policyPath: string | null = null, private readonly ownerUid = process.getuid?.() ?? -1) { this.applyDocument(null, policyPath !== null); }
  get generation(): number { return this.generationValue; }
  capabilities(sourceId: HerdrSourceId): RuntimeCapabilities { return this.effective.get(sourceId) ?? none(); }
  allows(sourceId: HerdrSourceId, operation: RuntimeCapability): boolean { return this.capabilities(sourceId)[operation]; }
  onReduction(listener: (generation: number) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private applyDocument(document: PolicyDocument | null, failClosed: boolean): boolean {
    const previous = this.effective;
    const next = new Map<HerdrSourceId, CapabilityMap>();
    for (const sourceId of this.sourceIds) next.set(sourceId, failClosed ? none() : intersect(intersect(this.startup, document?.global ?? {}), document?.sources?.[sourceId] ?? {}));
    const changed = this.sourceIds.some((id) => KEYS.some((key) => previous.get(id)?.[key] !== next.get(id)?.[key]));
    this.effective = next;
    if (changed) { this.generationValue++; for (const listener of this.listeners) listener(this.generationValue); }
    return changed;
  }
  async reload(): Promise<RuntimePolicyReload> {
    if (!this.policyPath) return { generation: this.generationValue, changed: false, errorCode: null };
    let document: PolicyDocument | null = null;
    let errorCode: string | null = null;
    try {
      const stat = await lstat(this.policyPath);
      if (!isAbsolute(this.policyPath) || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== this.ownerUid || (stat.mode & 0o022) !== 0) errorCode = 'policy_invalid';
      else { const raw = await readFile(this.policyPath, 'utf8'); document = parsePolicy(raw); if (!document) errorCode = 'policy_invalid'; }
    } catch { errorCode = 'policy_unavailable'; }
    const changed = this.applyDocument(document, errorCode !== null);
    return { generation: this.generationValue, changed, errorCode };
  }
}
