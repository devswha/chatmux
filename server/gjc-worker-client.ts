import { randomUUID } from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';

import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';
import {
  GJC_WORKER_PROTOCOL_VERSION,
  GjcWorkerNdjsonDecoder,
  GjcWorkerProtocolError,
  GjcWorkerRequestTracker,
  serializeGjcWorkerFrame,
  type GjcWorkerEventFrame,
  type GjcWorkerRequestFrame,
  type GjcWorkerRequestMethod,
  type GjcWorkerResponsePayload,
  type GjcWorkerResponseFrame,
  type JsonObject,
} from './gjc-worker-protocol.js';
import {
  createWindowsJobLaunch,
  GJC_WINDOWS_JOB_GUARD_ACK,
  GJC_WINDOWS_JOB_GUARD_READY,
} from './gjc-windows-job.js';

type RunStoppedNotification = {
  userId: string | number | null;
  provider: string;
  sessionId: string | null;
  sessionName: string | null;
  stopReason: string;
};

type RunFailedNotification = {
  userId: string | number | null;
  provider: string;
  sessionId: string | null;
  sessionName: string | null;
  error: string;
};

type RunStoppedNotifier = (notification: RunStoppedNotification) => unknown;
type RunFailedNotifier = (notification: RunFailedNotification) => unknown;
export type GjcApprovalDecision = { allow: boolean; updatedInput?: unknown; message?: string; rememberEntry?: unknown };
export type GjcWorkerOptions = Record<string, unknown> & { sessionId?: string | null; cwd?: string; projectPath?: string; sessionSummary?: string };
export type GjcWorkerWriter = { send(value: unknown): void; setSessionId?(id: string): void; getAppSessionId?(): string | undefined; userId?: string | number | null };
type Child = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdin: Writable;
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

type Spawn = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    detached?: boolean;
    env?: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
    windowsHide?: boolean;
  },
) => Child;

export type GjcWorkerSupervisorRuntime = {
  spawn?: Spawn;
  workerPath?: string;
  corePath?: string;
  compiled?: boolean;
  initializeTimeoutMs?: number;
  requestTimeoutMs?: number;
  notifyRunStopped?: RunStoppedNotifier;
  notifyRunFailed?: RunFailedNotifier;
  createScope?: () => string;
  diagnostic?: (message: string) => void;
  killTree?: (child: Child) => void | Promise<void>;
  killProcessTree?: (processId: number) => void | Promise<void>;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
};

type Run = {
  runId: string;
  appScope: string;
  writer: GjcWorkerWriter;
  options: GjcWorkerOptions;
  aborted: boolean;
  abortPromise?: Promise<boolean>;
  requestSent: boolean;
  terminal: boolean;
  terminalForwarded: boolean;
  terminalFailed: boolean;
  processId?: number;
  providerSessionId?: string;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingApproval = {
  runId: string;
  appScope: string;
  message: unknown;
  inFlight: boolean;
};

type ExpiredRequest = {
  method: GjcWorkerRequestMethod;
  sessionId?: string;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_FAILURE = 'GJC worker failed.';

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeJsonObject(value: unknown): JsonObject | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    const parsed: unknown = JSON.parse(serialized);
    return object(parsed) as JsonObject | undefined;
  } catch {
    return undefined;
  }
}

function safeOptions(options: GjcWorkerOptions): JsonObject | undefined {
  const { sessionId: _sessionId, ...rest } = options;
  return safeJsonObject(rest);
}

function taskkill(processId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = spawnChild('taskkill', [
      '/pid',
      String(processId),
      '/T',
      '/F',
    ], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      killer.kill('SIGKILL');
      finish(new Error('taskkill timed out.'));
    }, 5_000);
    killer.once('error', finish);
    killer.once('close', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(
        `taskkill failed${code === null ? '' : ` with exit code ${code}`}`
        + `${signal ? ` after signal ${signal}` : ''}.`,
      ));
    });
  });
}

function killWorkerTree(child: Child): void | Promise<void> {
  if (!child.pid) {
    child.kill('SIGKILL');
    return;
  }

  if (process.platform === 'win32') {
    return taskkill(child.pid);
  }

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function killOwnedRunTree(processId: number): void | Promise<void> {
  if (process.platform !== 'win32') return;
  return taskkill(processId);
}

/** Supervises the private Protocol v1 worker while preserving app-owned lifecycle state. */
export class GjcWorkerSupervisor {
  private readonly runtime: Required<Pick<GjcWorkerSupervisorRuntime, 'spawn' | 'initializeTimeoutMs' | 'requestTimeoutMs' | 'createScope' | 'diagnostic' | 'notifyRunStopped' | 'notifyRunFailed' | 'killTree' | 'killProcessTree' | 'platform' | 'environment'>> & Pick<GjcWorkerSupervisorRuntime, 'corePath' | 'workerPath' | 'compiled'>;
  private child?: Child;
  private ready = false;
  private starting?: Promise<void>;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private terminating?: Promise<void>;
  private terminationFailure?: Error;
  private decoder?: GjcWorkerNdjsonDecoder;
  private tracker = new GjcWorkerRequestTracker();
  private readonly runs = new Map<string, Run>();
  private readonly aliases = new Map<string, string>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly expiredRequests = new Map<string, ExpiredRequest>();

  constructor(runtime: GjcWorkerSupervisorRuntime = {}) {
    this.runtime = {
      spawn: runtime.spawn ?? spawnChild as unknown as Spawn,
      corePath: runtime.corePath,
      workerPath: runtime.workerPath,
      compiled: runtime.compiled,
      initializeTimeoutMs: runtime.initializeTimeoutMs ?? 5_000,
      requestTimeoutMs: runtime.requestTimeoutMs ?? 30_000,
      createScope: runtime.createScope ?? (() => `gjc-${randomUUID()}`),
      diagnostic: runtime.diagnostic ?? (() => {}),
      notifyRunStopped: runtime.notifyRunStopped ?? notifyRunStopped as unknown as RunStoppedNotifier,
      notifyRunFailed: runtime.notifyRunFailed ?? notifyRunFailed as unknown as RunFailedNotifier,
      killTree: runtime.killTree ?? killWorkerTree,
      killProcessTree: runtime.killProcessTree ?? killOwnedRunTree,
      platform: runtime.platform ?? process.platform,
      environment: runtime.environment ?? process.env,
    };
  }

  private diagnose(message: string): void {
    try {
      this.runtime.diagnostic(message);
    } catch {
      // Diagnostics must never interfere with worker lifecycle handling.
    }
  }

  private invokeAppCallback(label: string, callback: () => unknown): void {
    try {
      void Promise.resolve(callback()).catch(() => this.diagnose(label));
    } catch {
      this.diagnose(label);
    }
  }

  spawn(message: string, options: GjcWorkerOptions = {}, writer: GjcWorkerWriter): Promise<void> & { abortHandle: string } {
    const runId = `run-${randomUUID()}`;
    if (this.shuttingDown) {
      const rejected = Promise.reject(new Error(SAFE_FAILURE)) as Promise<void> & {
        abortHandle: string;
      };
      rejected.abortHandle = runId;
      return rejected;
    }
    const appScope = safeId(writer.getAppSessionId?.()) ?? safeId(this.runtime.createScope()) ?? `gjc-${randomUUID()}`;
    let resolve!: () => void; let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; }) as Promise<void> & { abortHandle: string };
    promise.abortHandle = runId;
    const run: Run = {
      runId,
      appScope,
      writer,
      options,
      aborted: false,
      requestSent: false,
      terminal: false,
      terminalForwarded: false,
      terminalFailed: false,
      resolve,
      reject,
    };
    this.runs.set(runId, run);
    void this.startRun(run, message);
    return promise;
  }

  private async startRun(run: Run, message: string): Promise<void> {
    try {
      await this.ensureWorker();
      if (run.terminal) return;

      const providerSessionId = safeId(run.options.sessionId);
      if (providerSessionId) {
        run.providerSessionId = providerSessionId;
        this.aliases.set(providerSessionId, run.runId);
      }

      const options = safeOptions(run.options);
      if (!options) {
        this.finish(run, true);
        return;
      }

      const payload: JsonObject = {
        message,
        options,
        ...(providerSessionId ? { providerSessionId } : {}),
      };
      const method = providerSessionId ? 'session.resume' : 'session.start';
      run.requestSent = true;
      const response = await this.request(
        method,
        run.appScope,
        payload,
        null,
        run.runId,
      );
      this.finish(run, run.terminalFailed || !response.ok);
    } catch {
      this.finish(run, true);
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.terminationFailure) return Promise.reject(this.terminationFailure);
    if (this.terminating) {
      return this.terminating.then(() => this.ensureWorker());
    }
    if (this.ready && this.child) return Promise.resolve();
    if (this.starting) return this.starting;
    const compiled = this.runtime.compiled ?? !import.meta.url.endsWith('.ts');
    const workerPath = this.runtime.workerPath ?? fileURLToPath(new URL(compiled ? './gjc-worker.js' : './gjc-worker.ts', import.meta.url));
    const workerArgs = compiled ? [workerPath] : ['--import', 'tsx', workerPath];
    const coreExecutable = this.runtime.platform === 'win32'
      ? 'gajae-core.exe'
      : 'gajae-core';
    const corePath = this.runtime.corePath ?? fileURLToPath(new URL(
      compiled
        ? `../../dist-native/${coreExecutable}`
        : `../dist-native/${coreExecutable}`,
      import.meta.url,
    ));
    const coreArgs = ['--', process.execPath, ...workerArgs];
    const workerEnv = compiled
      ? this.runtime.environment
      : {
          ...this.runtime.environment,
          TSX_TSCONFIG_PATH: fileURLToPath(new URL('./tsconfig.json', import.meta.url)),
        };
    const launch = this.runtime.platform === 'win32'
      ? createWindowsJobLaunch(
          corePath,
          coreArgs,
          workerEnv,
          process.cwd(),
        )
      : {
          command: corePath,
          args: coreArgs,
          env: workerEnv,
        };
    const child = this.runtime.spawn(launch.command, launch.args, {
      detached: this.runtime.platform !== 'win32',
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child; this.ready = false; this.decoder = new GjcWorkerNdjsonDecoder();
    const usesWindowsJobGuard = this.runtime.platform === 'win32';
    let guardSettled = !usesWindowsJobGuard;
    let guardBuffer = Buffer.alloc(0);
    let resolveGuard!: () => void;
    let rejectGuard!: (error: Error) => void;
    const guardReady = usesWindowsJobGuard
      ? new Promise<void>((resolve, reject) => {
          resolveGuard = resolve;
          rejectGuard = reject;
        })
      : Promise.resolve();
    let guardTimer: NodeJS.Timeout | undefined;
    const settleGuard = (error?: Error): void => {
      if (guardSettled) return;
      guardSettled = true;
      if (guardTimer) clearTimeout(guardTimer);
      if (error) rejectGuard(error);
      else resolveGuard();
    };
    if (usesWindowsJobGuard) {
      guardTimer = setTimeout(() => {
        settleGuard(new Error(SAFE_FAILURE));
        void this.workerFailed(child);
      }, this.runtime.initializeTimeoutMs);
      guardTimer.unref?.();
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (guardSettled) {
        this.onStdout(child, chunk);
        return;
      }
      guardBuffer = Buffer.concat([guardBuffer, chunk]);
      if (guardBuffer.length > 128) {
        settleGuard(new Error(SAFE_FAILURE));
        void this.workerFailed(child);
        return;
      }
      const newline = guardBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const prelude = guardBuffer.subarray(0, newline).toString('utf8').replace(/\r$/u, '');
      const remaining = guardBuffer.subarray(newline + 1);
      guardBuffer = Buffer.alloc(0);
      if (prelude !== GJC_WINDOWS_JOB_GUARD_READY) {
        settleGuard(new Error(SAFE_FAILURE));
        void this.workerFailed(child);
        return;
      }
      try {
        child.stdin.write(`${GJC_WINDOWS_JOB_GUARD_ACK}\n`);
      } catch {
        settleGuard(new Error(SAFE_FAILURE));
        void this.workerFailed(child);
        return;
      }
      settleGuard();
      if (remaining.length > 0) this.onStdout(child, remaining);
    });
    const failWorker = (guardedProcessExited = false): void => {
      settleGuard(new Error(SAFE_FAILURE));
      void this.workerFailed(child, guardedProcessExited);
    };
    child.stdin.on('error', () => failWorker());
    child.stderr?.on('data', () => this.diagnose('GJC worker emitted diagnostics.'));
    child.on('error', () => failWorker());
    child.on('exit', () => failWorker(true));
    child.on('close', () => failWorker(true));
    const starting = guardReady
      .then(() => this.request(
        'worker.initialize',
        undefined,
        {},
        this.runtime.initializeTimeoutMs,
      ))
      .then((response) => {
        if (child !== this.child || !response.ok) throw new Error(SAFE_FAILURE);
        this.ready = true;
      })
      .catch(() => { this.workerFailed(child); throw new Error(SAFE_FAILURE); })
      .finally(() => {
        if (this.starting === starting) this.starting = undefined;
      });
    this.starting = starting;
    return starting;
  }

  private request(
    method: GjcWorkerRequestMethod,
    sessionId: string | undefined,
    payload: JsonObject,
    timeout: number | null = this.runtime.requestTimeoutMs,
    id = `req-${randomUUID()}`,
  ): Promise<GjcWorkerResponsePayload> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(SAFE_FAILURE));
    const request: GjcWorkerRequestFrame = {
      protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
      kind: 'request',
      id,
      method,
      ...(sessionId ? { sessionId } : {}),
      payload,
    } as GjcWorkerRequestFrame;
    const tracked = this.tracker.track(request);
    try { child.stdin.write(serializeGjcWorkerFrame(request)); } catch { this.workerFailed(child); }
    if (timeout === null) return tracked;
    return new Promise<GjcWorkerResponsePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.tracker.reject(
          request.id,
          new Error('GJC worker request timed out.'),
        )) {
          this.expiredRequests.set(request.id, {
            method: request.method,
            ...('sessionId' in request ? { sessionId: request.sessionId } : {}),
          });
          if (this.expiredRequests.size > 256) {
            const oldest = this.expiredRequests.keys().next().value;
            if (oldest) this.expiredRequests.delete(oldest);
          }
        }
      }, timeout);
      timer.unref?.();
      tracked.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private onStdout(child: Child, chunk: Buffer): void {
    if (child !== this.child) return;
    try {
      for (const frame of this.decoder?.push(chunk) ?? []) {
        if (frame.kind === 'response') this.handleResponse(frame);
        else if (frame.kind === 'event') this.handleEvent(frame);
        else throw new GjcWorkerProtocolError('unexpected_request', 'Worker emitted a request frame.');
      }
    } catch { this.workerFailed(child); }
  }

  private handleResponse(response: GjcWorkerResponseFrame): void {
    const expired = this.expiredRequests.get(response.id);
    if (!expired) {
      this.tracker.settle(response);
      return;
    }

    const responseSession = 'sessionId' in response ? response.sessionId : undefined;
    if (expired.method !== response.method || expired.sessionId !== responseSession) {
      throw new GjcWorkerProtocolError(
        'mismatched_response',
        'Late response does not match its expired request.',
      );
    }
    this.expiredRequests.delete(response.id);
  }

  private handleEvent(event: GjcWorkerEventFrame): void {
    const payload = object(event.payload);
    const runId = safeId(payload?.runId);
    const run = runId ? this.runs.get(runId) : undefined;
    const scope = 'sessionId' in event ? event.sessionId : undefined;
    if (!run || scope !== run.appScope) return;

    if (event.method === 'worker.status') {
      const processId = payload?.processId;
      if (processId === null) {
        run.processId = undefined;
        return;
      }
      if (
        typeof processId === 'number'
        && Number.isSafeInteger(processId)
        && processId > 0
        && processId <= 0x7fffffff
      ) {
        run.processId = processId;
      }
      return;
    }

    const message = payload?.message;
    const messageRecord = object(message);
    if (event.method === 'session.created') {
      const providerSessionId = safeId(payload?.providerSessionId);
      if (providerSessionId) {
        if (
          run.providerSessionId
          && this.aliases.get(run.providerSessionId) === run.runId
        ) {
          this.aliases.delete(run.providerSessionId);
        }
        run.providerSessionId = providerSessionId;
        this.aliases.set(providerSessionId, run.runId);
        try {
          run.writer.setSessionId?.(providerSessionId);
        } catch {
          // A disconnected writer must not break worker lifecycle handling.
        }
      }
    }

    const requestId = safeId(messageRecord?.requestId);
    if (requestId && messageRecord?.kind === 'permission_request') {
      this.approvals.set(requestId, {
        runId: run.runId,
        appScope: run.appScope,
        message,
        inFlight: false,
      });
    }
    if (requestId && messageRecord?.kind === 'permission_cancelled') {
      this.approvals.delete(requestId);
    }

    if (Object.hasOwn(event.payload, 'message')) {
      try {
        run.writer.send(message);
      } catch {
        // The run still needs deterministic terminal cleanup after disconnect.
      }
    }

    if (event.method === 'turn.failed' || event.method === 'turn.completed') {
      run.terminalForwarded = true;
      run.terminalFailed = event.method === 'turn.failed';
    }
  }

  abort(alias: string): Promise<boolean> {
    const runId = this.runs.has(alias) ? alias : this.aliases.get(alias);
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run || run.terminal) return Promise.resolve(false);
    if (run.abortPromise) return run.abortPromise;

    if (!run.requestSent) {
      run.aborted = true;
      this.finish(run, false);
      return Promise.resolve(true);
    }

    const abortPromise = this.request('turn.abort', run.appScope, {
      runId: run.runId,
    }).then((response) => {
      const result = response.ok ? object(response.result) : undefined;
      if (!response.ok || result?.aborted !== true || run.terminal) return false;
      run.aborted = true;
      return true;
    }).catch(() => false).finally(() => {
      if (run.abortPromise === abortPromise) run.abortPromise = undefined;
    });
    run.abortPromise = abortPromise;
    return abortPromise;
  }

  isActive(alias: string): boolean {
    const runId = this.runs.has(alias) ? alias : this.aliases.get(alias);
    return Boolean(runId && this.runs.has(runId));
  }

  active(): string[] {
    return [...this.runs.keys()];
  }

  resolveApproval(requestId: string, decision: GjcApprovalDecision): boolean {
    const pending = this.approvals.get(requestId);
    const serializedDecision = safeJsonObject(decision);
    if (!pending || !serializedDecision) return false;
    if (pending.inFlight) return true;
    pending.inFlight = true;
    void this.request('ask.reply', pending.appScope, {
      runId: pending.runId,
      requestId,
      decision: serializedDecision,
    }).then((response) => {
      const result = response.ok ? object(response.result) : undefined;
      if (!response.ok || result?.accepted !== true) {
        this.restoreApproval(requestId, pending);
      }
    }).catch(() => this.restoreApproval(requestId, pending));
    return true;
  }

  private restoreApproval(requestId: string, pending: PendingApproval): void {
    if (this.approvals.get(requestId) !== pending) return;
    const run = this.runs.get(pending.runId);
    if (!run || run.terminal) {
      this.approvals.delete(requestId);
      return;
    }

    pending.inFlight = false;
    try {
      run.writer.send(pending.message);
    } catch {
      // Reconnect replay still exposes the restored app-owned mirror.
    }
  }

  pendingApprovals(appSessionId: string): unknown[] {
    return [...this.approvals.values()]
      .filter((item) => item.appScope === appSessionId && !item.inFlight)
      .map((item) => item.message);
  }

  private finish(run: Run, failed: boolean): void {
    if (run.terminal) return;
    run.terminal = true;
    this.runs.delete(run.runId);
    if (
      run.providerSessionId
      && this.aliases.get(run.providerSessionId) === run.runId
    ) {
      this.aliases.delete(run.providerSessionId);
    }
    for (const [id, pending] of this.approvals) {
      if (pending.runId === run.runId) this.approvals.delete(id);
    }

    const sessionId = run.providerSessionId ?? run.appScope;
    if (failed && !run.aborted) {
      if (!run.terminalForwarded) {
        try {
          run.writer.send(createNormalizedMessage({
            kind: 'error',
            content: SAFE_FAILURE,
            provider: 'gjc',
            sessionId,
          }));
          run.writer.send(createCompleteMessage({
            provider: 'gjc',
            sessionId,
            actualSessionId: sessionId,
            exitCode: 1,
          }));
        } catch {
          // Notification and promise settlement remain authoritative.
        }
      }
      this.invokeAppCallback('GJC failure notification failed.', () => this.runtime.notifyRunFailed({
        userId: run.writer.userId ?? null,
        provider: 'gjc',
        sessionId,
        sessionName: run.options.sessionSummary ?? null,
        error: SAFE_FAILURE,
      }));
      run.reject(new Error(SAFE_FAILURE));
      return;
    }

    if (!run.aborted && !run.terminalForwarded) {
      try {
        run.writer.send(createCompleteMessage({
          provider: 'gjc',
          sessionId,
          actualSessionId: sessionId,
          exitCode: 0,
        }));
      } catch {
        // Notification and promise settlement remain authoritative.
      }
    }
    this.invokeAppCallback('GJC stop notification failed.', () => this.runtime.notifyRunStopped({
      userId: run.writer.userId ?? null,
      provider: 'gjc',
      sessionId,
      sessionName: run.options.sessionSummary ?? null,
      stopReason: run.aborted ? 'aborted' : 'completed',
    }));
    run.resolve();
  }

  private workerFailed(child: Child, guardedProcessExited = false): Promise<void> {
    if (child !== this.child) return Promise.resolve();
    this.child = undefined;
    this.ready = false;
    this.starting = undefined;
    this.decoder = undefined;

    const usesWindowsJobGuard = this.runtime.platform === 'win32';
    const terminations: Promise<void>[] = [];
    const terminate = (label: string, action: () => void | Promise<void>): void => {
      try {
        terminations.push(Promise.resolve(action()).catch((error) => {
          this.diagnose(label);
          throw error;
        }));
      } catch (error) {
        this.diagnose(label);
        terminations.push(Promise.reject(error));
      }
    };
    if (!(usesWindowsJobGuard && guardedProcessExited)) {
      terminate(
        'GJC worker tree termination failed.',
        () => this.runtime.killTree(child),
      );
    }
    if (!usesWindowsJobGuard) {
      for (const run of this.runs.values()) {
        const processId = run.processId;
        if (!processId) continue;
        terminate(
          'GJC run tree termination failed.',
          () => this.runtime.killProcessTree(processId),
        );
      }
    }
    const termination = Promise.all(terminations).then(() => {}).catch((error) => {
      this.terminationFailure = new Error(SAFE_FAILURE, { cause: error });
      throw this.terminationFailure;
    });
    this.terminating = termination;
    void termination.then(
      () => {
        if (this.terminating === termination) this.terminating = undefined;
      },
      () => {
        if (this.terminating === termination) this.terminating = undefined;
      },
    );

    this.tracker.failAll(new Error(SAFE_FAILURE));
    this.expiredRequests.clear();
    for (const run of [...this.runs.values()]) {
      const failed = run.terminalForwarded ? run.terminalFailed : true;
      this.finish(run, failed);
    }
    return termination;
  }

  private async awaitTermination(): Promise<void> {
    const termination = this.terminating;
    if (termination) await termination;
    if (this.terminationFailure) throw this.terminationFailure;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.stopWorker();
    return this.shutdownPromise;
  }

  private async stopWorker(): Promise<void> {
    const child = this.child;
    if (!child) {
      await this.awaitTermination();
      return;
    }
    for (const run of this.runs.values()) run.aborted = true;
    try {
      await this.request(
        'worker.shutdown',
        undefined,
        {},
        this.runtime.initializeTimeoutMs,
      );
    } catch {
      // Tree termination below remains the shutdown fallback.
    }
    if (child === this.child) await this.workerFailed(child);
    await this.awaitTermination();
  }
}

const supervisor = new GjcWorkerSupervisor();
export function spawnGjc(message: string, options: GjcWorkerOptions = {}, writer: GjcWorkerWriter) { return supervisor.spawn(message, options, writer); }
export function abortGjcSession(alias: string) { return supervisor.abort(alias); }
export function isGjcSessionActive(alias: string) { return supervisor.isActive(alias); }
export function getActiveGjcSessions() { return supervisor.active(); }
export function resolveGjcToolApproval(requestId: string, decision: GjcApprovalDecision) { return supervisor.resolveApproval(requestId, decision); }
export function getPendingGjcApprovalsForSession(appSessionId: string) { return supervisor.pendingApprovals(appSessionId); }
export function shutdownGjcWorker() { return supervisor.shutdown(); }
