import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_QUEUED_PATHS = 4096;
const FAILURE_MESSAGE = 'GJC session watcher failed.';
const CALLBACK_FAILURE_MESSAGE = 'GJC session watcher callback failed.';
const RESYNC_FAILURE_MESSAGE = 'GJC session watcher resync failed.';
const QUEUE_OVERFLOW_MESSAGE = 'GJC session watcher queue overflowed; rescanning transcripts.';
const STDERR_MESSAGE = 'GJC session watcher emitted diagnostics.';

/**
 * Fixed failure vocabulary. Every member is a compile-time constant that carries
 * no transcript path, frame content, or callback detail, so a reason may be
 * logged without breaking the invariant that watcher diagnostics never expose
 * session data. Without it a restart loop reports thousands of identical,
 * unactionable lines.
 */
export type GjcSessionWatcherFailureReason =
  | 'spawn-failed'
  | 'ready-timeout'
  | 'stdin-error'
  | 'child-error'
  | 'child-exit'
  | 'oversized-frame'
  | 'invalid-utf8'
  | 'malformed-json'
  | 'protocol-violation';

/** Exit status is numeric/signal-name only, so it is safe to attach to a reason. */
function exitDetail(code: unknown, signal: unknown): string {
  return `code=${typeof code === 'number' ? code : 'none'} signal=${typeof signal === 'string' ? signal : 'none'}`;
}

export type GjcSessionWatchEvent = {
  kind: 'add' | 'change';
  path: string;
};

type Child = {
  stdin: {
    end(): void;
    on?(event: string, listener: (...args: unknown[]) => void): unknown;
  };
  stdout: {
    on(event: 'data', listener: (chunk: Buffer | Uint8Array) => void): unknown;
  };
  stderr?: {
    on(event: 'data', listener: (chunk: Buffer | Uint8Array) => void): unknown;
  };
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown;
};

type Spawn = (
  command: string,
  args: string[],
  options: {
    detached: false;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
    windowsHide: boolean;
  },
) => Child;

export type GjcSessionWatcherOptions = {
  roots: readonly string[];
  onEvent: (event: GjcSessionWatchEvent, signal: AbortSignal) => unknown;
  /**
   * Individual events were lost, either because the native watcher's queue
   * overflowed (it then emits a resync frame) or because this client's own
   * queue did. The owner rescans the roots; events queued before the gap are
   * dropped because the rescan supersedes them.
   */
  onResync?: (signal: AbortSignal) => unknown;
  onFailure: (error: Error) => unknown;
  corePath?: string;
  spawn?: Spawn;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  closeDrainTimeoutMs?: number;
  closeExitTimeoutMs?: number;
  diagnostic?: (message: string) => void;
  compiled?: boolean;
};

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function safeCall(callback: () => unknown): void {
  try {
    void Promise.resolve(callback()).catch(() => {});
  } catch {
    // Callback failures must not escape process event handlers.
  }
}

/** Watches GJC transcript files through the mandatory native Protocol v1 host. */
export class GjcSessionWatcher {
  private readonly options: Required<Pick<GjcSessionWatcherOptions, 'spawn' | 'platform' | 'environment' | 'readyTimeoutMs' | 'closeDrainTimeoutMs' | 'closeExitTimeoutMs' | 'diagnostic'>> & Pick<GjcSessionWatcherOptions, 'corePath' | 'compiled' | 'roots' | 'onEvent' | 'onResync' | 'onFailure'>;
  private child?: Child;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private readonly started = deferred();
  private readonly exited = deferred();
  private ready = false;
  private closed = false;
  private failed = false;
  private enospcSeen = false;
  private exitedOnce = false;
  private input = Buffer.alloc(0);
  private readonly pending = new Map<string, GjcSessionWatchEvent>();
  private resyncRequested = false;
  private draining = false;
  private drainDone = deferred();
  private drainCancelled = false;
  private readonly drainAbort = new AbortController();

  constructor(options: GjcSessionWatcherOptions) {
    this.options = {
      roots: options.roots,
      onEvent: options.onEvent,
      onResync: options.onResync,
      onFailure: options.onFailure,
      corePath: options.corePath,
      compiled: options.compiled,
      spawn: options.spawn ?? spawnChild as unknown as Spawn,
      platform: options.platform ?? process.platform,
      environment: options.environment ?? process.env,
      readyTimeoutMs: options.readyTimeoutMs ?? 5_000,
      closeDrainTimeoutMs: options.closeDrainTimeoutMs ?? 5_000,
      closeExitTimeoutMs: options.closeExitTimeoutMs ?? 5_000,
      diagnostic: options.diagnostic ?? (() => {}),
    };
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error(FAILURE_MESSAGE));
    if (this.starting) return this.starting;
    const executable = this.options.platform === 'win32' ? 'chatmux-core.exe' : 'chatmux-core';
    const compiled = this.options.compiled ?? !import.meta.url.endsWith('.ts');
    const corePath = this.options.corePath ?? fileURLToPath(new URL(
      compiled ? `../../../../../dist-native/${executable}` : `../../../../dist-native/${executable}`,
      import.meta.url,
    ));
    const args = ['watch', ...this.options.roots.flatMap((root) => ['--root', root])];
    this.starting = this.waitForReady();
    try {
      const child = this.options.spawn(corePath, args, {
        detached: false,
        env: this.options.environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      child.stdout.on('data', (chunk) => this.onStdout(chunk));
      // stderr content is never forwarded (it may name transcript paths), but
      // the fixed ENOSPC token is safe and is the one diagnosis an operator
      // can act on: inotify watch exhaustion needs a sysctl, not a restart.
      child.stderr?.on('data', (chunk) => {
        if (!this.enospcSeen && String(chunk).includes('ENOSPC')) this.enospcSeen = true;
        this.diagnose(STDERR_MESSAGE);
      });
      child.stdin.on?.('error', () => this.fail('stdin-error'));
      child.on('error', () => this.fail('child-error'));
      child.on('exit', (code, signal) => this.onExit(code, signal));
      child.on('close', (code, signal) => this.onExit(code, signal));
    } catch {
      this.fail('spawn-failed');
    }
    return this.starting;
  }

  private async waitForReady(): Promise<void> {
    await Promise.race([this.started.promise, timeout(this.options.readyTimeoutMs).then(() => {
      if (!this.ready) {
        this.fail('ready-timeout');
        throw new Error(FAILURE_MESSAGE, { cause: 'ready-timeout' });
      }
    })]);
  }

  private onStdout(chunk: Buffer | Uint8Array): void {
    if (this.failed || this.closed) return;
    this.input = Buffer.concat([this.input, Buffer.from(chunk)]);
    for (;;) {
      const newline = this.input.indexOf(0x0a);
      if (newline < 0) break;
      const frame = this.input.subarray(0, newline);
      this.input = this.input.subarray(newline + 1);
      if (frame.length > MAX_FRAME_BYTES) {
        this.fail('oversized-frame');
        return;
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(frame).replace(/\r$/u, '');
      } catch {
        this.fail('invalid-utf8');
        return;
      }
      this.decode(text);
      if (this.failed) return;
    }
    if (this.input.length > MAX_FRAME_BYTES) this.fail('oversized-frame');
  }

  private decode(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.fail('malformed-json');
      return;
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return this.fail('protocol-violation');
    const record = frame as Record<string, unknown>;
    const keys = Object.keys(record);
    if (record.protocolVersion !== 1 || typeof record.kind !== 'string') return this.fail('protocol-violation');
    if (record.kind === 'ready') {
      if (this.ready || keys.length !== 2 || !keys.includes('protocolVersion') || !keys.includes('kind')) return this.fail('protocol-violation');
      this.ready = true;
      this.started.resolve();
      return;
    }
    if (record.kind === 'resync') {
      if (!this.ready || keys.length !== 2 || !keys.includes('protocolVersion') || !keys.includes('kind')) return this.fail('protocol-violation');
      this.requestResync();
      return;
    }
    if (
      record.kind !== 'event' ||
      (record.event !== 'add' && record.event !== 'change') ||
      !this.ready ||
      keys.length !== 4 ||
      !keys.includes('protocolVersion') ||
      !keys.includes('kind') ||
      !keys.includes('event') ||
      !keys.includes('path') ||
      typeof record.path !== 'string' ||
      record.path.length === 0 ||
      record.path.includes('\0')
    ) {
      return this.fail('protocol-violation');
    }
    if (!this.pending.has(record.path) && this.pending.size >= MAX_QUEUED_PATHS) {
      // Same shape as the native side's overflow: a burst is a gap for the
      // owner to reconcile, not a reason to restart and lose live tracking.
      this.diagnose(QUEUE_OVERFLOW_MESSAGE);
      this.requestResync();
      return;
    }
    this.pending.set(record.path, { kind: record.event, path: record.path });
    void this.drain();
  }

  private requestResync(): void {
    this.pending.clear();
    this.resyncRequested = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.drainDone = deferred();
    this.draining = true;
    try {
      while (!this.failed && !this.drainCancelled && (this.resyncRequested || this.pending.size > 0)) {
        if (this.resyncRequested) {
          this.resyncRequested = false;
          try {
            await this.options.onResync?.(this.drainAbort.signal);
          } catch {
            if (!this.drainCancelled) this.diagnose(RESYNC_FAILURE_MESSAGE);
          }
          continue;
        }
        const event = this.pending.values().next().value as GjcSessionWatchEvent;
        this.pending.delete(event.path);
        try {
          await this.options.onEvent(event, this.drainAbort.signal);
        } catch {
          if (!this.drainCancelled) this.diagnose(CALLBACK_FAILURE_MESSAGE);
        }
      }
    } finally {
      this.draining = false;
      if ((this.pending.size === 0 && !this.resyncRequested) || this.drainCancelled) this.drainDone.resolve();
    }
  }

  private diagnose(message: string): void {
    safeCall(() => this.options.diagnostic(message));
  }

  /** True when the child's stderr named inotify watch exhaustion (ENOSPC). */
  get enospcObserved(): boolean {
    return this.enospcSeen;
  }

  private fail(reason: GjcSessionWatcherFailureReason, detail?: string): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.drainCancelled = true;
    this.pending.clear();
    this.resyncRequested = false;
    this.drainAbort.abort();
    this.drainDone.resolve();
    const cause = detail === undefined ? reason : `${reason} ${detail}`;
    this.started.reject(new Error(FAILURE_MESSAGE, { cause }));
    this.diagnose(`${FAILURE_MESSAGE} (${cause})`);
    safeCall(() => this.options.onFailure(new Error(FAILURE_MESSAGE, { cause })));
    try {
      this.child?.kill('SIGKILL');
    } catch {
      // The process may already be gone.
    }
  }

  private onExit(code?: unknown, signal?: unknown): void {
    if (this.exitedOnce) return;
    this.exitedOnce = true;
    this.exited.resolve();
    if (!this.closed) this.fail('child-exit', exitDetail(code, signal));
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.ready && !this.failed) this.started.reject(new Error(FAILURE_MESSAGE));
    this.closed = true;
    this.closing = (async () => {
      try {
        this.child?.stdin.end();
      } catch {
        // Closing an already-closed stdin still permits bounded shutdown.
      }
      if (this.pending.size > 0 || this.draining) {
        const drained = await Promise.race([
          this.drainDone.promise.then(() => true),
          timeout(this.options.closeDrainTimeoutMs).then(() => false),
        ]);
        if (!drained) {
          this.drainCancelled = true;
          this.pending.clear();
          this.drainAbort.abort();
          this.drainDone.resolve();
        }
      }
      if (this.child && !this.exitedOnce) {
        await Promise.race([this.exited.promise, timeout(this.options.closeExitTimeoutMs)]);
        if (!this.exitedOnce) {
          try {
            this.child.kill('SIGKILL');
          } catch {
            // A concurrently exited child needs no further action.
          }
          await Promise.race([this.exited.promise, timeout(this.options.closeExitTimeoutMs)]);
        }
      }
    })();
    return this.closing;
  }
}
