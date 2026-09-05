import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';

import type { TmuxPaneIdentity } from '../../../../shared/tmux.js';

export const MAX_LOCAL_TMUX_SOCKETS = 8;
export const MAX_LOCAL_TMUX_CONFIG_BYTES = 32 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export type LocalTmuxSocketSelector = Readonly<{ name: string } | { path: string }>;
export type LocalTmuxDiscoveryFailure =
  | 'configuration_invalid'
  | 'socket_unavailable'
  | 'socket_identity_changed'
  | 'capture_failed'
  | 'cancelled';

/** Closed errors deliberately exclude selectors, paths, argv and OS messages. */
export class LocalTmuxDiscoveryError extends Error {
  constructor(readonly code: LocalTmuxDiscoveryFailure) {
    super('Local tmux discovery could not verify the configured inventory.');
    this.name = 'LocalTmuxDiscoveryError';
  }
}

// Filesystem APIs cannot cancel an in-progress syscall. Time out the waiter,
// but retain its slot until completion so hung paths cannot accumulate work.
const pendingInspections = new Set<Promise<unknown>>();
const MAX_PENDING_INSPECTIONS = 16;
export function boundedLocalTmuxInspection<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 4000,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new LocalTmuxDiscoveryError('cancelled'));
  if (pendingInspections.size >= MAX_PENDING_INSPECTIONS) {
    return Promise.reject(new LocalTmuxDiscoveryError('socket_unavailable'));
  }
  const work = Promise.resolve().then(() => {
    if (signal?.aborted) throw new LocalTmuxDiscoveryError('cancelled');
    return operation();
  });
  pendingInspections.add(work);
  void work.then(() => pendingInspections.delete(work), () => pendingInspections.delete(work));
  return new Promise<T>((resolve, reject) => {
    const finish = (complete: () => void): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      complete();
    };
    const abort = (): void => finish(() => reject(new LocalTmuxDiscoveryError('cancelled')));
    const timer = setTimeout(() => finish(() => reject(new LocalTmuxDiscoveryError('socket_unavailable'))), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    void work.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    if (signal?.aborted) abort();
  });
}

export function parseLocalTmuxSocketInventory(value: string | undefined): readonly LocalTmuxSocketSelector[] | null {
  if (value === undefined || value === '') return null;
  const invalid = (): never => { throw new LocalTmuxDiscoveryError('configuration_invalid'); };
  if (Buffer.byteLength(value) > MAX_LOCAL_TMUX_CONFIG_BYTES) return invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return invalid(); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_LOCAL_TMUX_SOCKETS) return invalid();
  const seen = new Set<string>();
  return Object.freeze(parsed.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return invalid();
    const keys = Object.keys(entry);
    if (keys.length !== 1) return invalid();
    const candidate = entry as { name?: unknown; path?: unknown };
    let selector: LocalTmuxSocketSelector;
    if (keys[0] === 'name' && typeof candidate.name === 'string'
      && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(candidate.name)) {
      selector = { name: candidate.name };
    } else if (keys[0] === 'path' && typeof candidate.path === 'string'
      && isAbsolute(candidate.path) && normalize(candidate.path) === candidate.path
      && candidate.path !== '/' && !candidate.path.endsWith('/')
      && Buffer.byteLength(candidate.path) <= 4096 && !CONTROL_CHARACTERS.test(candidate.path)) {
      selector = { path: candidate.path };
    } else return invalid();
    const key = JSON.stringify(selector);
    if (seen.has(key)) return invalid();
    seen.add(key);
    return Object.freeze(selector);
  }));
}

/** Internal cache partition only; never emit this value in diagnostics. */
export function localTmuxInventoryKey(env: NodeJS.ProcessEnv = process.env): string {
  return JSON.stringify([env.CHATMUX_TMUX_SOCKETS ?? '', env.TMUX_TMPDIR ?? '', env.TMUX ?? '']);
}

export type ResolvedLocalTmuxSocket = Readonly<{
  args: readonly string[];
  socketPath: string;
}>;

export async function resolveLocalTmuxSocket(
  selector: LocalTmuxSocketSelector,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<ResolvedLocalTmuxSocket> {
  if ('path' in selector) return { args: ['-S', selector.path], socketPath: selector.path };
  const uid = process.getuid?.();
  const root = env.TMUX_TMPDIR || '/tmp';
  // Do not emulate tmux's path-list/tilde expansion or guess a custom build's
  // socket directory. Such configurations can use an exact absolute -S path.
  if (uid === undefined || !isAbsolute(root) || root.includes(':') || CONTROL_CHARACTERS.test(root)) {
    throw new LocalTmuxDiscoveryError('socket_unavailable');
  }
  try {
    return {
      args: ['-L', selector.name],
      socketPath: join(await boundedLocalTmuxInspection(() => realpath(root), signal), `tmux-${uid}`, selector.name),
    };
  } catch (error) {
    if (error instanceof LocalTmuxDiscoveryError) throw error;
    throw new LocalTmuxDiscoveryError('socket_unavailable');
  }
}

export type LocalTmuxSocketEvidence = Readonly<{ socketPath: string; generation: string }>;
export type LocalTmuxSocketInspector = (socketPath: string) => Promise<LocalTmuxSocketEvidence>;

/** Direct filesystem inspection, never the display/context cache. */
export async function inspectLocalTmuxSocket(
  socketPath: string,
  uid: number | undefined = process.getuid?.(),
  signal?: AbortSignal,
): Promise<LocalTmuxSocketEvidence> {
  return boundedLocalTmuxInspection(async () => {
    try {
      const stat = await lstat(socketPath, { bigint: true });
      if (uid === undefined || !stat.isSocket() || stat.uid !== BigInt(uid)
        || await realpath(socketPath) !== socketPath) {
        throw new LocalTmuxDiscoveryError('socket_unavailable');
      }
      return Object.freeze({
        socketPath,
        generation: `${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}:${stat.ctimeNs}`,
      });
    } catch {
      throw new LocalTmuxDiscoveryError('socket_unavailable');
    }
  }, signal);
}

/** Browser-visible synthetic IDs use length-prefixed UTF-8 identity fields. */
export function localTmuxPaneDigest(identity: TmuxPaneIdentity): string {
  const digest = createHash('sha256');
  for (const field of [identity.socketPath, identity.sessionId, identity.windowId, identity.paneId]) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    digest.update(length).update(bytes);
  }
  return digest.digest('hex');
}

export function sameLocalTmuxSocket(a: LocalTmuxSocketEvidence, b: LocalTmuxSocketEvidence): boolean {
  return a.socketPath === b.socketPath && a.generation === b.generation;
}

// Private, lifetime-bounded evidence follows the exact identity object through
// discovery and verified-target cloning. It is never serialized to the browser.
const paneEvidence = new WeakMap<TmuxPaneIdentity, LocalTmuxSocketEvidence>();

export function rememberLocalTmuxSocket(identity: TmuxPaneIdentity, evidence: LocalTmuxSocketEvidence): void {
  paneEvidence.set(identity, evidence);
}

export function copyLocalTmuxSocketEvidence(from: TmuxPaneIdentity, to: TmuxPaneIdentity): void {
  const evidence = paneEvidence.get(from);
  if (evidence) paneEvidence.set(to, evidence);
}

/** Membership is reevaluated at use time, including after an inventory change. */
export async function assertLocalTmuxSocket(
  identity: TmuxPaneIdentity,
  env: NodeJS.ProcessEnv = process.env,
  inspect: LocalTmuxSocketInspector = inspectLocalTmuxSocket,
): Promise<LocalTmuxSocketEvidence | null> {
  const environment = { ...env };
  const inventoryKey = localTmuxInventoryKey(environment);
  const inventory = parseLocalTmuxSocketInventory(environment.CHATMUX_TMUX_SOCKETS);
  const expected = paneEvidence.get(identity);
  if (!inventory) {
    if (expected) throw new LocalTmuxDiscoveryError('socket_identity_changed');
    return null;
  }
  // Resolution is bounded and failures in unrelated entries do not authorize a
  // fallback. Only a currently configured, exact resolved path can match.
  const sockets = await Promise.all(inventory.map((selector) => resolveLocalTmuxSocket(selector, environment).catch(() => null)));
  const paths = sockets.flatMap((socket) => socket ? [socket.socketPath] : []);
  if (new Set(paths).size !== paths.length) throw new LocalTmuxDiscoveryError('configuration_invalid');
  if (!sockets.some((socket) => socket?.socketPath === identity.socketPath)) {
    throw new LocalTmuxDiscoveryError('socket_identity_changed');
  }
  const observed = await (inspect === inspectLocalTmuxSocket
    ? inspect(identity.socketPath)
    : boundedLocalTmuxInspection(() => inspect(identity.socketPath)));
  if (inventoryKey !== localTmuxInventoryKey(env)) {
    throw new LocalTmuxDiscoveryError('configuration_invalid');
  }
  if (expected && !sameLocalTmuxSocket(expected, observed)) {
    throw new LocalTmuxDiscoveryError('socket_identity_changed');
  }
  return observed;
}
