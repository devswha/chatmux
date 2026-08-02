import type { PublicTerminalRef, PublicTerminalTarget, RuntimeCapabilities, RuntimeCapability, SourceDescriptor, TerminalRuntime } from '../../../shared/terminal-runtime.js';

export type RuntimeOperation = 'discover' | 'read' | 'send' | 'interrupt' | 'escape' | 'attach';
export type RuntimeDiscoveryOutcome = Readonly<{
  runtime: TerminalRuntime;
  sourceId: string;
  ok: boolean;
  terminals: readonly PublicTerminalTarget[];
}>;
export type RuntimeDiscoveryScan = Readonly<{
  sources: readonly SourceDescriptor[];
  outcomes: readonly RuntimeDiscoveryOutcome[];
}>;
export type RuntimeOperationContext = unknown;
export type RuntimeTargetProfile = Readonly<{ targetClass: 'local-agent' | 'attach-only'; process: { pid: number; startedAtMs: number } | null }>;
export type RuntimeAdapter = {
  readonly runtime: TerminalRuntime;
  sourceDescriptors(): Promise<readonly SourceDescriptor[]>;
  capabilities?(sourceId: string): RuntimeCapabilities;
  discover(): Promise<readonly PublicTerminalTarget[]>;
  discoverOutcomes?(): Promise<readonly RuntimeDiscoveryOutcome[]>;
  scanDiscovery?(): Promise<RuntimeDiscoveryScan>;
  read?(ref: PublicTerminalRef, context?: RuntimeOperationContext): Promise<{ ansi: string; truncated: boolean } | null>;
  send?(ref: PublicTerminalRef, literal: string, context?: RuntimeOperationContext): Promise<boolean>;
  interrupt?(ref: PublicTerminalRef, context?: RuntimeOperationContext): Promise<boolean>;
  escape?(ref: PublicTerminalRef, context?: RuntimeOperationContext): Promise<boolean>;
  controllerArgv?(ref: PublicTerminalRef, cols: number, rows: number): Promise<{ command: string; args: string[]; release: () => void } | null>;
  verify?(ref: PublicTerminalRef, operation: 'output' | 'actions' | 'attach'): Promise<boolean>;
  targetProfile?(ref: PublicTerminalRef): Promise<RuntimeTargetProfile | null>;
  dispose?(): void;
};
const CAPABILITY: Record<RuntimeOperation, RuntimeCapability> = { discover: 'discovery', read: 'output', send: 'actions', interrupt: 'actions', escape: 'actions', attach: 'attach' };
const NO_CAPABILITIES: RuntimeCapabilities = { discovery: false, output: false, actions: false, attach: false, create: false };

/** Dependency-free coordinator. Discovery is presentation only; operations delegate fresh verification. */
export class RuntimeRegistryService {
  private readonly adapters = new Map<TerminalRuntime, RuntimeAdapter>();
  private disposed = false;
  register(adapter: RuntimeAdapter): () => void { if (this.disposed || this.adapters.has(adapter.runtime)) throw new Error('runtime_registry_invalid'); this.adapters.set(adapter.runtime, adapter); return () => { if (this.adapters.get(adapter.runtime) === adapter) this.adapters.delete(adapter.runtime); }; }
  capabilities(runtime: TerminalRuntime, sourceId: string): RuntimeCapabilities { return this.adapters.get(runtime)?.capabilities?.(sourceId) ?? NO_CAPABILITIES; }
  async sources(): Promise<SourceDescriptor[]> { if (this.disposed) return []; const descriptors = await Promise.all([...this.adapters.values()].map((adapter) => adapter.sourceDescriptors())); return descriptors.flat().map(({ runtime, sourceId, readiness }) => ({ runtime, sourceId, readiness })); }
  async discoverOutcomes(): Promise<RuntimeDiscoveryOutcome[]> {
    if (this.disposed) return [];
    return (await Promise.all([...this.adapters.values()].map(async (adapter) => {
      let descriptors: readonly SourceDescriptor[];
      try {
        descriptors = await adapter.sourceDescriptors();
      } catch {
        return [];
      }
      try {
        if (adapter.discoverOutcomes) return await adapter.discoverOutcomes();
        const terminals = await adapter.discover();
        return descriptors.map(({ runtime, sourceId }) => ({
          runtime,
          sourceId,
          ok: true,
          terminals: terminals.filter((terminal) => terminal.runtime !== 'herdr' || terminal.sourceId === sourceId),
        }));
      } catch {
        return descriptors.map(({ runtime, sourceId }) => ({ runtime, sourceId, ok: false, terminals: [] }));
      }
    }))).flat();
  }
  async scanDiscovery(): Promise<RuntimeDiscoveryScan> {
    if (this.disposed) return { sources: [], outcomes: [] };
    const scans = await Promise.all([...this.adapters.values()].map(async (adapter): Promise<RuntimeDiscoveryScan> => {
      if (adapter.scanDiscovery) return adapter.scanDiscovery();
      let sources: readonly SourceDescriptor[];
      try {
        sources = await adapter.sourceDescriptors();
      } catch {
        return { sources: [], outcomes: [] };
      }
      try {
        const outcomes = adapter.discoverOutcomes
          ? await adapter.discoverOutcomes()
          : sources.map(({ runtime, sourceId }) => ({ runtime, sourceId, ok: true, terminals: [] }));
        return { sources, outcomes };
      } catch {
        return {
          sources,
          outcomes: sources.map(({ runtime, sourceId }) => ({ runtime, sourceId, ok: false, terminals: [] })),
        };
      }
    }));
    return {
      sources: scans.flatMap((scan) => [...scan.sources]),
      outcomes: scans.flatMap((scan) => [...scan.outcomes]),
    };
  }
  private adapter(ref: PublicTerminalRef, operation: RuntimeOperation): RuntimeAdapter | null { const adapter = this.adapters.get(ref.runtime); return adapter && (ref.runtime !== 'herdr' || adapter.capabilities?.(ref.sourceId)[CAPABILITY[operation]]) ? adapter : null; }
  async read(ref: PublicTerminalRef, context?: RuntimeOperationContext): Promise<{ ansi: string; truncated: boolean } | null> { const adapter = this.adapter(ref, 'read'); return adapter?.read ? adapter.read(ref, context) : null; }
  async send(ref: PublicTerminalRef, literal: string, context?: RuntimeOperationContext): Promise<boolean> { const adapter = this.adapter(ref, 'send'); return adapter?.send ? adapter.send(ref, literal, context) : false; }
  async interrupt(ref: PublicTerminalRef, context?: RuntimeOperationContext): Promise<boolean> { const adapter = this.adapter(ref, 'interrupt'); return adapter?.interrupt ? adapter.interrupt(ref, context) : false; }
  async escape(ref: PublicTerminalRef, context?: RuntimeOperationContext): Promise<boolean> { const adapter = this.adapter(ref, 'escape'); return adapter?.escape ? adapter.escape(ref, context) : false; }
  async verify(ref: PublicTerminalRef, operation: 'output' | 'actions' | 'attach'): Promise<boolean> { const adapter = this.adapter(ref, operation === 'output' ? 'read' : operation === 'actions' ? 'send' : 'attach'); return adapter?.verify ? adapter.verify(ref, operation) : false; }
  async controllerArgv(ref: PublicTerminalRef, cols: number, rows: number): Promise<{ command: string; args: string[]; release: () => void } | null> { const adapter = this.adapter(ref, 'attach'); return adapter?.controllerArgv ? adapter.controllerArgv(ref, cols, rows) : null; }
  async targetProfile(ref: PublicTerminalRef): Promise<RuntimeTargetProfile | null> { if (this.disposed) return null; const adapter = this.adapters.get(ref.runtime); const profile = await adapter?.targetProfile?.(ref); return profile && (!adapter?.verify || await adapter.verify(ref, 'attach')) ? profile : null; }
  dispose(): void { if (this.disposed) return; this.disposed = true; for (const adapter of this.adapters.values()) adapter.dispose?.(); this.adapters.clear(); }
}
