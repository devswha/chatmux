import * as nodeFs from 'node:fs';
import path from 'node:path';

import {
  isOpaqueUpdateJobId,
  isTerminalUpdatePhase,
  isUpdatePhase,
  parseStrictSemVer,
  sanitizePublicUpdateError,
  type ImmutableUpdateJobDescriptor,
  type ReleaseUpdatePhase,
  type SanitizedUpdateJobStatus,
  validateImmutableUpdateJobDescriptor,
} from './release-update-contract.js';

export const UPDATE_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const UPDATE_STATE_TERMINAL_CAP = 32;

export type ReleaseCutoverState = 'prepared' | 'live_link_swapped';
export type ReleaseRollbackState = 'not_started' | 'in_progress' | 'completed' | 'failed';

export interface PersistedUpdateRecoveryDescriptor {
  priorRelease: { path: string; version: string };
  targetRelease: { path: string; version: string };
  cutoverState: ReleaseCutoverState;
  rollbackState: ReleaseRollbackState;
}

export interface PersistedUpdateProgress {
  downloadedBytes: number;
  totalBytes?: number;
}

export interface PersistedUpdateJob {
  descriptor: ImmutableUpdateJobDescriptor;
  phase: ReleaseUpdatePhase;
  updatedAt: number;
  completedAt?: number;
  completionOrdinal?: number;
  locked: boolean;
  error?: string;
  recovery?: PersistedUpdateRecoveryDescriptor;
}

interface PersistedState {
  schemaVersion: 1;
  jobs: Record<string, PersistedUpdateJob>;
}

export interface StateFileSystem {
  mkdirSync(path: string, options: { recursive: boolean; mode: number }): void;
  lstatSync(path: string): nodeFs.Stats;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string, options: { encoding: 'utf8'; mode: number; flag: 'wx' | 'w' }): void;
  openSync(path: string, flags: string): number;
  closeSync(fd: number): void;
  fsyncSync(fd: number): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  existsSync(path: string): boolean;
}

const fs: StateFileSystem = nodeFs;

export interface ReleaseUpdateStateStoreOptions {
  fs?: StateFileSystem;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

export class ReleaseUpdateStateError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function validInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validReleasePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 1 && value.length <= 4096 && !/[\0\r\n]/.test(value) && path.isAbsolute(value) && path.normalize(value) === value && !value.split(path.sep).includes('..');
}

function validateRecoveryDescriptor(value: unknown): value is PersistedUpdateRecoveryDescriptor {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !['priorRelease', 'targetRelease', 'cutoverState', 'rollbackState'].includes(key)) || !isPlainObject(value.priorRelease) || !isPlainObject(value.targetRelease) || Object.keys(value.priorRelease).some((key) => !['path', 'version'].includes(key)) || Object.keys(value.targetRelease).some((key) => !['path', 'version'].includes(key))) return false;
  return validReleasePath(value.priorRelease.path) && !!parseStrictSemVer(value.priorRelease.version) && validReleasePath(value.targetRelease.path) && !!parseStrictSemVer(value.targetRelease.version) && value.priorRelease.path !== value.targetRelease.path && value.priorRelease.version !== value.targetRelease.version && (value.cutoverState === 'prepared' || value.cutoverState === 'live_link_swapped') && (value.rollbackState === 'not_started' || value.rollbackState === 'in_progress' || value.rollbackState === 'completed' || value.rollbackState === 'failed');
}

function validateProgress(value: unknown): value is PersistedUpdateProgress {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !['downloadedBytes', 'totalBytes'].includes(key)) || !validInteger(value.downloadedBytes)) return false;
  return value.totalBytes === undefined || (validInteger(value.totalBytes) && value.totalBytes > 0);
}

function validateJob(value: unknown): value is PersistedUpdateJob {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !['descriptor', 'phase', 'updatedAt', 'completedAt', 'completionOrdinal', 'locked', 'error', 'recovery'].includes(key)) || !validateImmutableUpdateJobDescriptor(value.descriptor) || !isUpdatePhase(value.phase) || !validInteger(value.updatedAt) || typeof value.locked !== 'boolean') return false;
  const descriptor = value.descriptor as ImmutableUpdateJobDescriptor;
  if (value.completedAt !== undefined && !validInteger(value.completedAt)) return false;
  if (value.completionOrdinal !== undefined && (!validInteger(value.completionOrdinal) || value.completionOrdinal === 0)) return false;
  if (value.error !== undefined && typeof value.error !== 'string') return false;
  if (value.recovery !== undefined && (!validateRecoveryDescriptor(value.recovery) || value.recovery.priorRelease.version !== descriptor.sourceVersion || value.recovery.targetRelease.version !== descriptor.release.version)) return false;
  if (isTerminalUpdatePhase(value.phase) !== (value.completedAt !== undefined && value.completionOrdinal !== undefined)) return false;
  return true;
}

function parseState(text: string): PersistedState {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ReleaseUpdateStateError('Update state is corrupt.'); }
  if (!isPlainObject(raw) || Object.keys(raw).some((key) => key !== 'schemaVersion' && key !== 'jobs') || raw.schemaVersion !== 1 || !isPlainObject(raw.jobs)) throw new ReleaseUpdateStateError('Update state is corrupt.');

  const jobs: Record<string, PersistedUpdateJob> = {};
  for (const [id, job] of Object.entries(raw.jobs)) {
    if (!isOpaqueUpdateJobId(id) || !validateJob(job) || job.descriptor.id !== id) throw new ReleaseUpdateStateError('Update state is corrupt.');
    jobs[id] = job;
  }
  return { schemaVersion: 1, jobs };
}

/** A small synchronous store: every externally visible mutation is a durable atomic replace. */
export class ReleaseUpdateStateStore {
  private readonly fs: StateFileSystem;
  private readonly now: () => number;
  private readonly statePath: string;
  private readonly allocatorPath: string;
  private readonly lockPath: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly progressPath: string;

  constructor(private readonly root: string, options: ReleaseUpdateStateStoreOptions = {}) {
    this.fs = options.fs ?? fs;
    this.now = options.now ?? Date.now;
    this.isProcessAlive = options.isProcessAlive ?? ((pid) => {
      try { process.kill(pid, 0); return true; } catch (error) { return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'); }
    });
    this.statePath = path.join(root, 'release-update-state.json');
    this.allocatorPath = path.join(root, 'release-update-completion-ordinal.json');
    this.lockPath = path.join(root, 'release-update-state.lock');
    // Sidecar keeps cosmetic progress out of the closed schemaVersion-1 job
    // record so a rolled-back prior release can still parse the state file.
    this.progressPath = path.join(root, 'release-update-progress.json');
  }

  initialize(): void {
    this.withExclusiveLock(() => {
      const state = this.readState();
      const ordinal = this.repairAllocator(state);
      let changed = false;
      for (const job of Object.values(state.jobs)) {
        if (isTerminalUpdatePhase(job.phase) && job.locked) {
          job.locked = false;
          job.updatedAt = this.now();
          changed = true;
        }
      }
      if (changed) this.writeState(state);
      this.prune(state, ordinal);
    });
  }

  create(descriptor: ImmutableUpdateJobDescriptor): PersistedUpdateJob {
    if (!validateImmutableUpdateJobDescriptor(descriptor)) throw new ReleaseUpdateStateError('Invalid immutable update descriptor.');
    return this.withExclusiveLock(() => {
      const state = this.readState();
      const ordinal = this.repairAllocator(state);
      this.prune(state, ordinal);
      if (state.jobs[descriptor.id]) throw new ReleaseUpdateStateError('Update job already exists.');
      const job: PersistedUpdateJob = { descriptor, phase: 'queued', updatedAt: this.now(), locked: true };
      state.jobs[descriptor.id] = job;
      this.writeState(state);
      return job;
    });
  }
  /** Atomically reserves the sole durable active update slot. */
  createIfNoActive(descriptor: ImmutableUpdateJobDescriptor): PersistedUpdateJob | null {
    if (!validateImmutableUpdateJobDescriptor(descriptor)) throw new ReleaseUpdateStateError('Invalid immutable update descriptor.');
    return this.withExclusiveLock(() => {
      const state = this.readState();
      const ordinal = this.repairAllocator(state);
      this.prune(state, ordinal);
      if (Object.values(state.jobs).some((job) => !isTerminalUpdatePhase(job.phase))) return null;
      if (state.jobs[descriptor.id]) throw new ReleaseUpdateStateError('Update job already exists.');
      const job: PersistedUpdateJob = { descriptor, phase: 'queued', updatedAt: this.now(), locked: true };
      state.jobs[descriptor.id] = job;
      this.writeState(state);
      return job;
    });
  }

  transition(id: string, phase: ReleaseUpdatePhase, error?: string): PersistedUpdateJob {
    if (!isOpaqueUpdateJobId(id) || !isUpdatePhase(phase)) throw new ReleaseUpdateStateError('Invalid update job transition.');
    return this.withExclusiveLock(() => {
      const state = this.readState();
      let allocator = this.repairAllocator(state);
      this.prune(state, allocator);
      const job = state.jobs[id];
      if (!job) throw new ReleaseUpdateStateError('Update job not found.');
      if (isTerminalUpdatePhase(job.phase)) throw new ReleaseUpdateStateError('Terminal update job cannot transition.');
      job.phase = phase;
      job.updatedAt = this.now();
      const safeError = sanitizePublicUpdateError(error);
      if (safeError) job.error = safeError; else delete job.error;
      if (!isTerminalUpdatePhase(phase)) {
        this.writeState(state);
        return job;
      }
      // Terminal outcome: the sidecar progress no longer describes live work.
      this.removeProgressSidecar();
      // High-water durability precedes the terminal record, so a crash cannot reuse an ordinal.
      allocator += 1;
      this.writeAllocator(allocator);
      job.completedAt = job.updatedAt;
      job.completionOrdinal = allocator;
      job.locked = true;
      this.writeState(state);
      job.locked = false;
      this.writeState(state);
      this.prune(state, allocator);
      return job;
    });
  }
  /** Durable download progress for the nonterminal job; display-only, never authority. */
  recordDownloadProgress(id: string, progress: PersistedUpdateProgress): PersistedUpdateJob {
    if (!isOpaqueUpdateJobId(id) || !validateProgress(progress) || (progress.totalBytes !== undefined && progress.downloadedBytes > progress.totalBytes)) throw new ReleaseUpdateStateError('Invalid update download progress.');
    return this.withExclusiveLock(() => {
      const state = this.readState();
      const ordinal = this.repairAllocator(state);
      this.prune(state, ordinal);
      const job = state.jobs[id];
      if (!job) throw new ReleaseUpdateStateError('Update job not found.');
      if (isTerminalUpdatePhase(job.phase)) throw new ReleaseUpdateStateError('Terminal update job cannot record progress.');
      this.atomicWrite(this.progressPath, JSON.stringify({ jobId: id, downloadedBytes: progress.downloadedBytes, ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }) }) + '\n');
      return job;
    });
  }
  /** Best-effort sidecar read: corruption or absence only hides the cosmetic bar. */
  private readProgressSidecar(jobId: string): PersistedUpdateProgress | null {
    try {
      if (!this.fs.existsSync(this.progressPath)) return null;
      const raw: unknown = JSON.parse(this.fs.readFileSync(this.progressPath, 'utf8'));
      if (!isPlainObject(raw) || raw.jobId !== jobId) return null;
      const { jobId: _jobId, ...progress } = raw;
      return validateProgress(progress) ? progress : null;
    } catch {
      return null;
    }
  }
  private removeProgressSidecar(): void {
    try { if (this.fs.existsSync(this.progressPath)) this.fs.unlinkSync(this.progressPath); } catch { /* Cosmetic only. */ }
  }
  /** Persists the release-link recovery authority before any live-link mutation. */
  persistRecoveryCheckpoint(id: string, recovery: PersistedUpdateRecoveryDescriptor): PersistedUpdateJob {
    if (!isOpaqueUpdateJobId(id) || !validateRecoveryDescriptor(recovery)) throw new ReleaseUpdateStateError('Invalid update recovery checkpoint.');
    return this.withExclusiveLock(() => {
      const state = this.readState();
      const ordinal = this.repairAllocator(state);
      this.prune(state, ordinal);
      const job = state.jobs[id];
      if (!job || isTerminalUpdatePhase(job.phase) || recovery.priorRelease.version !== job.descriptor.sourceVersion || recovery.targetRelease.version !== job.descriptor.release.version) throw new ReleaseUpdateStateError('Invalid update recovery checkpoint.');
      const previous = job.recovery;
      if (!previous && (recovery.cutoverState !== 'prepared' || recovery.rollbackState !== 'not_started')) throw new ReleaseUpdateStateError('Initial recovery checkpoint is ambiguous.');
      if (previous && !this.isRecoveryAdvance(previous, recovery)) throw new ReleaseUpdateStateError('Recovery checkpoint cannot regress.');
      job.recovery = this.copyRecovery(recovery);
      job.updatedAt = this.now();
      this.writeState(state);
      return job;
    });
  }

  /** Reads recovery authority for startup recovery without exposing it publicly. */
  recoveryCheckpoint(id: string): PersistedUpdateRecoveryDescriptor | null {
    const job = this.get(id);
    return job?.recovery ? this.copyRecovery(job.recovery) : null;
  }
  /** Terminalizes precisely one nonterminal job only when its deterministic worker is proven inactive. */
  failIfInactive(id: string, isLive: () => boolean): PersistedUpdateJob | null {
    if (!isOpaqueUpdateJobId(id)) return null;
    return this.withExclusiveLock(() => {
      const state = this.readState();
      let allocator = this.repairAllocator(state);
      this.prune(state, allocator);
      const job = state.jobs[id];
      if (!job || isTerminalUpdatePhase(job.phase) || isLive()) return null;
      const postCutover = ['cutting_over', 'restarting', 'verifying_health', 'rolling_back'].includes(job.phase);
      if (postCutover && !job.recovery) throw new ReleaseUpdateStateError('Post-cutover update lacks recovery authority.');
      if (!postCutover) {
        job.phase = 'failed';
        job.error = 'Updater stopped before completion';
      } else if (job.recovery!.rollbackState === 'completed') {
        job.phase = 'failed_rolled_back';
        job.error = 'Update failed; verified rollback restored the previous release';
      } else if (job.phase === 'rolling_back' || job.recovery!.rollbackState !== 'not_started') {
        job.phase = 'failed_rollback';
        job.error = 'Updater stopped during rollback; manual recovery is required';
      } else {
        job.phase = 'manual_required';
        job.error = 'Updater stopped; manual recovery is required';
      }
      job.updatedAt = this.now();
      allocator += 1;
      this.writeAllocator(allocator);
      job.completedAt = job.updatedAt;
      job.completionOrdinal = allocator;
      job.locked = true;
      this.writeState(state);
      job.locked = false;
      this.writeState(state);
      this.prune(state, allocator);
      return job;
    });
  }


  get(id: string): PersistedUpdateJob | null {
    if (!isOpaqueUpdateJobId(id)) return null;
    return this.withExclusiveLock(() => {
      const state = this.readState();
      const ordinal = this.repairAllocator(state);
      this.prune(state, ordinal);
      return state.jobs[id] ?? null;
    });
  }

  publicStatus(id: string): SanitizedUpdateJobStatus | null {
    const job = this.get(id);
    if (!job) return null;
    return {
      id: job.descriptor.id,
      phase: job.phase,
      createdAt: job.descriptor.createdAt,
      updatedAt: job.updatedAt,
      ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
      targetVersion: job.descriptor.release.version,
      ...(isTerminalUpdatePhase(job.phase) ? {} : (() => { const progress = this.readProgressSidecar(job.descriptor.id); return progress ? { progress } : {}; })()),
      ...(job.error ? { error: job.error } : {}),
    };
  }
  /** Returns the sole nonterminal job without disclosing immutable worker inputs. */
  publicActiveStatus(): SanitizedUpdateJobStatus | null {
    return this.withExclusiveLock(() => {
      const state = this.readState();
      const ordinal = this.repairAllocator(state);
      this.prune(state, ordinal);
      const active = Object.values(state.jobs).find((job) => !isTerminalUpdatePhase(job.phase));
      if (!active) return null;
      return {
        id: active.descriptor.id,
        phase: active.phase,
        createdAt: active.descriptor.createdAt,
        updatedAt: active.updatedAt,
        targetVersion: active.descriptor.release.version,
        ...((() => { const progress = this.readProgressSidecar(active.descriptor.id); return progress ? { progress } : {}; })()),
        ...(active.error ? { error: active.error } : {}),
      };
    });
  }

  /** Unlock terminal commit gaps and active work only after its persisted worker is not live. */
  reconcileLocks(isLive: (job: PersistedUpdateJob) => boolean): void {
    this.withExclusiveLock(() => {
      const state = this.readState();
      const ordinal = this.repairAllocator(state);
      this.prune(state, ordinal);
      let changed = false;
      for (const job of Object.values(state.jobs)) {
        if (job.locked && (isTerminalUpdatePhase(job.phase) || !isLive(job))) {
          job.locked = false;
          job.updatedAt = this.now();
          changed = true;
        }
      }
      if (changed) this.writeState(state);
    });
  }

  private withExclusiveLock<T>(operation: () => T): T {
    this.ensureSafeRoot();
    let fd: number;
    try {
      fd = this.fs.openSync(this.lockPath, 'wx');
    } catch {
      if (!this.recoverDeadLock()) throw new ReleaseUpdateStateError('Update state is locked or unavailable.');
      try { fd = this.fs.openSync(this.lockPath, 'wx'); }
      catch { throw new ReleaseUpdateStateError('Update state is locked or unavailable.'); }
    }
    try {
      try { this.fs.writeFileSync(this.lockPath, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' }); }
      catch (error) { throw new ReleaseUpdateStateError(`Unable to persist update state lock: ${error instanceof Error ? error.message : 'unknown error'}`); }
      return operation();
    } finally {
      try { this.fs.closeSync(fd!); } finally { this.fs.unlinkSync(this.lockPath); }
    }
  }

  private recoverDeadLock(): boolean {
    let text: string;
    try { text = this.fs.readFileSync(this.lockPath, 'utf8'); } catch { return false; }
    const match = /^([1-9]\d*)\n$/.exec(text);
    if (!match) return false;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || this.isProcessAlive(pid)) return false;
    try { this.fs.unlinkSync(this.lockPath); return true; } catch { return false; }
  }

  private ensureSafeRoot(): void {
    this.fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = this.fs.lstatSync(this.root);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (uid !== undefined && stat.uid !== uid)) throw new ReleaseUpdateStateError('Unsafe update state root.');
  }

  private readState(): PersistedState {
    if (!this.fs.existsSync(this.statePath)) return { schemaVersion: 1, jobs: {} };
    return parseState(this.fs.readFileSync(this.statePath, 'utf8'));
  }

  private repairAllocator(state: PersistedState): number {
    const ordinals = Object.values(state.jobs).filter((job) => isTerminalUpdatePhase(job.phase)).map((job) => job.completionOrdinal!);
    if (new Set(ordinals).size !== ordinals.length) throw new ReleaseUpdateStateError('Update state has ambiguous completion ordering.');
    const recovered = Math.max(0, ...ordinals);
    let stored = 0;
    if (this.fs.existsSync(this.allocatorPath)) {
      let raw: unknown;
      try { raw = JSON.parse(this.fs.readFileSync(this.allocatorPath, 'utf8')); } catch { throw new ReleaseUpdateStateError('Completion allocator is corrupt.'); }
      if (!isPlainObject(raw) || !validInteger(raw.nextCompletionOrdinal)) throw new ReleaseUpdateStateError('Completion allocator is corrupt.');
      stored = raw.nextCompletionOrdinal;
    }
    if (stored < recovered) {
      this.writeAllocator(recovered);
      return recovered;
    }
    return stored;
  }

  private prune(state: PersistedState, allocator: number): void {
    const now = this.now();
    const candidates = Object.values(state.jobs).filter((job) => isTerminalUpdatePhase(job.phase) && !job.locked && job.phase !== 'manual_required' && job.phase !== 'failed_rollback');
    const doomed = new Set<string>();
    for (const job of candidates) if (job.completedAt! < now - UPDATE_STATE_RETENTION_MS) doomed.add(job.descriptor.id);
    const retained = candidates.filter((job) => !doomed.has(job.descriptor.id)).sort((a, b) => a.completionOrdinal! - b.completionOrdinal!);
    for (const job of retained.slice(0, Math.max(0, retained.length - UPDATE_STATE_TERMINAL_CAP))) doomed.add(job.descriptor.id);
    if (!doomed.size) return;
    // The allocator was validated/repaired before selection; only now is deletion persisted.
    for (const id of doomed) delete state.jobs[id];
    this.writeState(state);
    void allocator;
  }

  private writeAllocator(nextCompletionOrdinal: number): void {
    this.atomicWrite(this.allocatorPath, JSON.stringify({ nextCompletionOrdinal }) + '\n');
  }

  private writeState(state: PersistedState): void {
    this.atomicWrite(this.statePath, JSON.stringify(state) + '\n');
  }
  private isRecoveryAdvance(previous: PersistedUpdateRecoveryDescriptor, next: PersistedUpdateRecoveryDescriptor): boolean {
    if (previous.priorRelease.path !== next.priorRelease.path || previous.priorRelease.version !== next.priorRelease.version || previous.targetRelease.path !== next.targetRelease.path || previous.targetRelease.version !== next.targetRelease.version) return false;
    const cutover = { prepared: 0, live_link_swapped: 1 };
    const rollback = { not_started: 0, in_progress: 1, completed: 2, failed: 2 };
    return cutover[next.cutoverState] >= cutover[previous.cutoverState] && rollback[next.rollbackState] >= rollback[previous.rollbackState] && !(previous.rollbackState === 'completed' || previous.rollbackState === 'failed');
  }

  private copyRecovery(recovery: PersistedUpdateRecoveryDescriptor): PersistedUpdateRecoveryDescriptor {
    return { priorRelease: { ...recovery.priorRelease }, targetRelease: { ...recovery.targetRelease }, cutoverState: recovery.cutoverState, rollbackState: recovery.rollbackState };
  }

  private atomicWrite(destination: string, contents: string): void {
    const temporary = `${destination}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    let fd: number | undefined;
    try {
      this.fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fd = this.fs.openSync(temporary, 'r');
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      this.fs.renameSync(temporary, destination);
      const parent = this.fs.openSync(path.dirname(destination), 'r');
      try { this.fs.fsyncSync(parent); } finally { this.fs.closeSync(parent); }
    } catch (error) {
      if (fd !== undefined) this.fs.closeSync(fd);
      if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary);
      throw new ReleaseUpdateStateError(`Unable to persist update state: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}
