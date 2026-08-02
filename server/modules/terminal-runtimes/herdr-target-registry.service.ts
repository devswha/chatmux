import { randomBytes } from 'node:crypto';

import type { ProcessGeneration, PublicTerminalRef, PublicTerminalTarget } from '../../../shared/terminal-runtime.js';

import type { HerdrResolvedTerminal, HerdrSourceId, HerdrTargetId } from './herdr-internal.types.js';

export const HERDR_TARGET_REGISTRY_LIMIT = 2048;
type Entry = { sourceId: HerdrSourceId; sourceGeneration: number; terminalId: string; terminalIncarnation: string; workspaceId: string; tabId: string; paneId: string; process: ProcessGeneration | null; targetClass: 'local-agent' | 'attach-only'; admissionCapability: string | null };
export type HerdrServerTargetProfile = Readonly<{ targetClass: 'local-agent' | 'attach-only'; process: ProcessGeneration | null }>;
export type HerdrTargetLocator = Readonly<{ paneId: string }>;
function targetId(): HerdrTargetId { return `htgt_${randomBytes(16).toString('base64url')}`; }
function same(entry: Entry, target: HerdrResolvedTerminal, sourceGeneration: number): boolean {
  if (entry.sourceId !== target.source.sourceId
    || entry.sourceGeneration !== sourceGeneration
    || entry.terminalId !== target.terminalId
    || entry.terminalIncarnation !== target.terminalIncarnation
    || entry.workspaceId !== target.hierarchy.workspaceId
    || entry.tabId !== target.hierarchy.tabId
    || entry.paneId !== target.hierarchy.paneId
    || entry.targetClass !== target.targetClass) return false;
  return entry.targetClass === 'attach-only'
    || (entry.process?.pid === target.process?.pid && entry.process?.startedAtMs === target.process?.startedAtMs);
}
export class HerdrTargetRegistry {
  private readonly entries = new Map<HerdrTargetId, Entry>();
  constructor(private readonly limit = HERDR_TARGET_REGISTRY_LIMIT) {}
  mint(target: HerdrResolvedTerminal, sourceGeneration: number, admissionCapability: string | null = null): PublicTerminalTarget | null {
    if (target.targetClass === 'local-agent' && (!target.process || !isSupportedAgent(target.agent?.agentKind))) return null;
    if (target.targetClass === 'attach-only' && !admissionCapability) return null;
    for (const [id, entry] of this.entries) if (same(entry, target, sourceGeneration)) return this.public(entry, id);
    if (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value as HerdrTargetId);
    const id = targetId(); const entry: Entry = { sourceId: target.source.sourceId, sourceGeneration, terminalId: target.terminalId, terminalIncarnation: target.terminalIncarnation, workspaceId: target.hierarchy.workspaceId, tabId: target.hierarchy.tabId, paneId: target.hierarchy.paneId, process: target.process && { pid: target.process.pid, startedAtMs: target.process.startedAtMs }, targetClass: target.targetClass, admissionCapability };
    this.entries.set(id, entry); return this.public(entry, id);
  }
  private public(entry: Entry, id: HerdrTargetId): PublicTerminalTarget | null { return entry.targetClass === 'local-agent' && entry.process ? { runtime: 'herdr', sourceId: entry.sourceId, targetId: id, targetClass: 'local-agent', process: entry.process } : entry.admissionCapability ? { runtime: 'herdr', sourceId: entry.sourceId, targetId: id, targetClass: 'attach-only', admissionCapability: entry.admissionCapability } : null; }
  reference(sourceId: HerdrSourceId, id: HerdrTargetId): PublicTerminalRef { return { runtime: 'herdr', sourceId, targetId: id }; }
  resolve(sourceId: HerdrSourceId, id: HerdrTargetId, target: HerdrResolvedTerminal, sourceGeneration: number): Entry | null { const entry = this.entries.get(id); return entry && entry.sourceId === sourceId && same(entry, target, sourceGeneration) ? entry : null; }
  locate(sourceId: HerdrSourceId, id: HerdrTargetId, sourceGeneration: number): HerdrTargetLocator | null { const entry = this.entries.get(id); return entry && entry.sourceId === sourceId && entry.sourceGeneration === sourceGeneration ? { paneId: entry.paneId } : null; }
  profile(sourceId: HerdrSourceId, id: HerdrTargetId): HerdrServerTargetProfile | null { const entry = this.entries.get(id); return entry && entry.sourceId === sourceId ? { targetClass: entry.targetClass, process: entry.process && { pid: entry.process.pid, startedAtMs: entry.process.startedAtMs } } : null; }
  invalidateSource(sourceId: HerdrSourceId): void { for (const [id, entry] of this.entries) if (entry.sourceId === sourceId) this.entries.delete(id); }
  clear(): void { this.entries.clear(); }
}
export function isSupportedAgent(kind: unknown): boolean { return typeof kind === 'string' && ['claude', 'codex', 'cursor', 'opencode', 'omp'].includes(kind); }
