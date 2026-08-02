import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import type { PublicTerminalRef, PublicTerminalTarget, ShellV3ServerMessage } from '../../../shared/terminal-runtime.js';

import type { RuntimeRegistryService } from './runtime-registry.service.js';

const ADMISSION_TTL_MS = 60_000;
const ADMISSION_LIMIT = 1024;
const OBSERVE_INTERVAL_MS = 2_000;

type HerdrTarget = Extract<PublicTerminalTarget, { runtime: 'herdr' }>;
type HerdrRef = Extract<PublicTerminalRef, { runtime: 'herdr' }>;
type Clock = () => number;

type Admission = { principal: string; sourceId: string; targetId: string; expiresAt: number };

/** Single-use, principal-bound attach admission. Tokens are consumed before a controller lease is requested. */
export class HerdrAdmissionService {
  private readonly admissions = new Map<string, Admission>();

  constructor(private readonly now: Clock = Date.now, private readonly ttlMs = ADMISSION_TTL_MS) {}

  grant(token: string, principal: string, target: HerdrTarget): boolean {
    this.sweep();
    if (!token || token.length > 4096 || !principal || target.targetClass !== 'attach-only' || this.admissions.has(token) || this.admissions.size >= ADMISSION_LIMIT) return false;
    this.admissions.set(token, { principal, sourceId: target.sourceId, targetId: target.targetId, expiresAt: this.now() + this.ttlMs });
    return true;
  }

  issue(principal: string, target: HerdrTarget): string | null {
    if (!principal || target.targetClass !== 'attach-only') return null;
    const token = randomBytes(32).toString('base64url');
    return this.grant(token, principal, target) ? token : null;
  }

  consume(token: string | undefined, principal: string, target: HerdrTarget): boolean {
    this.sweep();
    if (!token) return false;
    const admission = this.admissions.get(token);
    this.admissions.delete(token);
    return !!admission && admission.principal === principal && admission.sourceId === target.sourceId && admission.targetId === target.targetId && admission.expiresAt > this.now();
  }

  private sweep(): void {
    for (const [token, admission] of this.admissions) if (admission.expiresAt <= this.now()) this.admissions.delete(token);
  }
}

export type HerdrControlBridge = {
  acquireController(request: { target: HerdrTarget; principal: string; admissionCapability?: string; cols: number; rows: number }): Promise<{ command: string; args: string[]; release: () => Promise<void>; onRevoke: (callback: () => void | Promise<void>) => () => void; assertWriteAllowed: () => boolean; assertFreshIdentity: () => Promise<boolean> } | null>;
  observe(request: { target: HerdrTarget; principal: string; emitFrame: (frame: ShellV3ServerMessage) => void }): Promise<{ release: () => Promise<void>; onRevoke: (callback: () => void | Promise<void>) => () => void; assertWriteAllowed: () => boolean; assertFreshIdentity: () => Promise<boolean> } | null>;
  releaseAll(): Promise<void>;
  dispose(): Promise<void>;
};

function ref(target: HerdrTarget): HerdrRef {
  return { runtime: 'herdr', sourceId: target.sourceId, targetId: target.targetId };
}

function encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * Terminal-runtime-only bridge for the websocket shell boundary. Every read is
 * delegated to the registry, so cached discovery can never authorize a lease.
 */
export class HerdrControlBridgeService implements HerdrControlBridge {
  constructor(private readonly runtimes: RuntimeRegistryService, private readonly admissions: HerdrAdmissionService) {}
  private readonly activeReleases = new Set<() => Promise<void>>();
  private revocationGeneration = 0;

  async releaseAll(): Promise<void> {
    this.revocationGeneration += 1;
    await Promise.all([...this.activeReleases].map((release) => release()));
  }

  dispose(): Promise<void> {
    return this.releaseAll();
  }

  private trackedRelease(release: () => void): { release: () => Promise<void>; onRevoke: (callback: () => void | Promise<void>) => () => void } {
    let released = false;
    let completion: Promise<void> | null = null;
    let revoke: (() => void | Promise<void>) | null = null;
    const tracked = (): Promise<void> => {
      if (completion) return completion;
      released = true;
      const callback = revoke;
      revoke = null;
      completion = (async () => {
        try {
          release();
        } catch {
          // The revocation callback remains responsible for terminal teardown.
        }
        try {
          await callback?.();
        } catch {
          // Lease release remains complete even when websocket teardown fails.
        } finally {
          this.activeReleases.delete(tracked);
        }
      })();
      return completion;
    };
    this.activeReleases.add(tracked);
    return {
      release: tracked,
      onRevoke: (callback) => {
        if (released) {
          void Promise.resolve(callback()).catch(() => {});
          return () => {};
        }
        revoke = callback;
        return () => {
          if (revoke === callback) revoke = null;
        };
      },
    };
  }

  private async trustedProfile(target: HerdrTarget): Promise<{ targetClass: HerdrTarget['targetClass']; process: { pid: number; startedAtMs: number } | null } | null> {
    const profile = await this.runtimes.targetProfile(ref(target));
    if (!profile || profile.targetClass !== target.targetClass) return null;
    if (profile.targetClass === 'attach-only') return profile;
    return profile.process
      && target.targetClass === 'local-agent'
      && target.process.pid === profile.process.pid
      && target.process.startedAtMs === profile.process.startedAtMs
      ? profile
      : null;
  }

  private async fresh(target: HerdrTarget, operation: 'output' | 'attach'): Promise<boolean> {
    return this.runtimes.verify(ref(target), operation);
  }

  async acquireController(request: Parameters<HerdrControlBridge['acquireController']>[0]): Promise<Awaited<ReturnType<HerdrControlBridge['acquireController']>>>
  {
    const profile = await this.trustedProfile(request.target);
    if (!profile) return null;
    if (profile.targetClass === 'attach-only' && !this.admissions.consume(request.admissionCapability, request.principal, request.target)) return null;
    // Fresh validation occurs before adapter acquisition; controllerArgv repeats it atomically while reserving its no-takeover lease.
    if (!await this.fresh(request.target, 'attach')) return null;
    const generation = this.revocationGeneration;
    const controller = await this.runtimes.controllerArgv(ref(request.target), request.cols, request.rows);
    if (!controller) return null;
    return { command: controller.command, args: controller.args, ...this.trackedRelease(controller.release), assertWriteAllowed: () => generation === this.revocationGeneration, assertFreshIdentity: async () => generation === this.revocationGeneration && this.fresh(request.target, 'attach') };
  }

  async observe(request: Parameters<HerdrControlBridge['observe']>[0]): Promise<Awaited<ReturnType<HerdrControlBridge['observe']>>>
  {
    if (!await this.trustedProfile(request.target)) return null;
    let released = false;
    let sequence = 0;
    const poll = async () => {
      if (released) return;
      const output = await this.runtimes.read(ref(request.target));
      if (!output) return;
      sequence += 1;
      request.emitFrame({ type: 'terminal.frame', seq: sequence, encoding: 'ansi', width: 80, height: 24, full: true, bytes: encode(output.ansi) });
    };
    if (!await this.fresh(request.target, 'output')) return null;
    const generation = this.revocationGeneration;
    await poll();
    const interval = setInterval(() => { void poll(); }, OBSERVE_INTERVAL_MS);
    return { ...this.trackedRelease(() => { released = true; clearInterval(interval); }), assertWriteAllowed: () => generation === this.revocationGeneration, assertFreshIdentity: async () => generation === this.revocationGeneration && this.fresh(request.target, 'output') };
  }
}

/** Verified child-process launcher for the adapter-provided external controller argv. */
export function spawnHerdrController(command: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
}
