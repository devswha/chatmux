import { createHash, randomUUID } from 'node:crypto';

import type { WebSocket } from 'ws';

import { paneSubscriptionKey, tmuxPaneIdentityKey, type TmuxPaneIdentity, type TmuxProcessGeneration } from '../../../../shared/tmux.js';
import { publicTerminalKey, readPublicTerminalTarget, type PublicTerminalTarget } from '../../../../shared/terminal-runtime.js';
import type { RuntimeRegistryService } from '../../terminal-runtimes/index.js';

import { normalizeExternalPaneOutput } from './external-cli-sessions.service.js';
import type { DiscoverySnapshot } from './discovery-collector.service.js';
import { assertFreshExternalTmuxTarget, type VerifiedTmuxActionTarget } from './tmux-fresh-verifier.service.js';
import { assertLineageTmuxTarget } from './tmux-target-guard.service.js';
import { assertTmuxPaneIdentity, captureTmuxPane } from './tmux-pane-actions.service.js';

export const C_CAPTURE_MS = 1_000;
export const PANE_REMINT_MS = 10_000;
export const PANE_OUTPUT_MAX_QUEUED = 8;
export const PANE_OUTPUT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const PANE_OUTPUT_HASH = 'sha256';
export const PANE_UNAVAILABLE_TIMEOUT_MS = 30_000;
export type PaneSubscriptionKey = string;
type Lane = 'external' | 'live';
type Sub = { id: string; ws: WebSocket; key: PaneSubscriptionKey; lane: Lane; knownHash?: string; attached: boolean };
type Entry = { key: PaneSubscriptionKey; lane: Lane; terminal: PublicTerminalTarget; tmux?: TmuxPaneIdentity; process?: TmuxProcessGeneration; target?: VerifiedTmuxActionTarget; mintedAt: number; hash: string | null; output: string | null; generation: number; subs: Map<WebSocket, Sub>; inFlight: Promise<void> | null };
type SocketQueue = { frames: Array<Record<string, unknown>>; flushing: boolean; retryTimer: ReturnType<typeof setTimeout> | null };

export type PaneOutputStreamOptions = {
  now?: () => number;
  mint?: (lane: Lane, tmux: TmuxPaneIdentity, process: TmuxProcessGeneration) => Promise<VerifiedTmuxActionTarget>;
  assertIdentity?: (tmux: TmuxPaneIdentity) => Promise<void>;
  capturePane?: (target: VerifiedTmuxActionTarget) => Promise<string>;
  normalizeOutput?: (output: string) => string;
  runtimeRegistry?: RuntimeRegistryService;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
};
type ParsedSubscription = { lane: Lane; terminal: PublicTerminalTarget; tmux?: TmuxPaneIdentity; process?: TmuxProcessGeneration };
function parseSubscription(data: Record<string, unknown>): ParsedSubscription {
  if (data.protocolVersion !== 2) throw new Error('CLIENT_RELOAD_REQUIRED');
  if (data.lane !== 'external' && data.lane !== 'live') throw new Error('invalid pane subscription');
  const terminal = readPublicTerminalTarget(data.target);
  if (!terminal) throw new Error('invalid pane subscription');
  if (terminal.runtime === 'tmux') {
    if (terminal.targetClass !== 'local-agent') throw new Error('invalid pane subscription');
    return { lane: data.lane, terminal, tmux: terminal.tmux, process: terminal.process };
  }
  if (data.lane !== 'external') throw new Error('invalid pane subscription');
  return { lane: data.lane, terminal };
}

/** Verified pane capture registry. Discovery snapshots may revoke subscriptions but never mint or extend them. */
export function createPaneOutputStream(options: PaneOutputStreamOptions = {}) {
  const now = options.now ?? Date.now;
  const mintTarget = options.mint ?? ((lane: Lane, tmux: TmuxPaneIdentity, process: TmuxProcessGeneration) => (
    lane === 'external' ? assertFreshExternalTmuxTarget(tmux, process) : assertLineageTmuxTarget(tmux, process)
  ));
  const assertIdentity = options.assertIdentity ?? assertTmuxPaneIdentity;
  const capturePane = options.capturePane ?? captureTmuxPane;
  const normalizeOutput = options.normalizeOutput ?? normalizeExternalPaneOutput;
  const setTimer = options.setTimer ?? setInterval;
  const clearTimer = options.clearTimer ?? clearInterval;
  const runtimeRegistry = options.runtimeRegistry;
  const entries = new Map<PaneSubscriptionKey, Entry>();
  const subscriptions = new Map<string, Sub>();
  const bySocket = new Map<WebSocket, Map<PaneSubscriptionKey, string>>();
  const queues = new Map<WebSocket, SocketQueue>();
  const unavailableSince = new Map<Lane, number>();

  function flush(ws: WebSocket, queue: SocketQueue): void {
    if (queues.get(ws) !== queue || queue.flushing || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > PANE_OUTPUT_MAX_BUFFERED_BYTES) {
      queue.retryTimer ??= setTimeout(() => {
        queue.retryTimer = null;
        flush(ws, queue);
      }, 50);
      return;
    }
    const event = queue.frames.shift();
    if (!event) return;
    queue.flushing = true;
    try {
      ws.send(JSON.stringify(event), () => {
        queue.flushing = false;
        flush(ws, queue);
      });
    } catch {
      queue.flushing = false;
    }
  }
  function emit(ws: WebSocket, event: Record<string, unknown>): void {
    if (ws.readyState !== ws.OPEN) return;
    const queue = queues.get(ws) ?? { frames: [], flushing: false, retryTimer: null };
    queues.set(ws, queue);
    const index = event.kind === 'pane.output'
      ? queue.frames.findIndex((frame) => frame.kind === 'pane.output' && frame.subscriptionId === event.subscriptionId)
      : -1;
    if (index >= 0) queue.frames[index] = event;
    else if (queue.frames.length < PANE_OUTPUT_MAX_QUEUED) queue.frames.push(event);
    else if (event.kind === 'pane.output') {
      const outputIndex = queue.frames.findIndex((frame) => frame.kind === 'pane.output');
      if (outputIndex >= 0) queue.frames.splice(outputIndex, 1, event);
    } else {
      const outputIndex = queue.frames.findIndex((frame) => frame.kind === 'pane.output');
      if (outputIndex >= 0) queue.frames.splice(outputIndex, 1, event);
      else {
        queue.frames.shift();
        queue.frames.push(event);
      }
    }
    flush(ws, queue);
  }
  function discardQueuedFrames(ws: WebSocket, subscriptionId: string): void {
    const queue = queues.get(ws);
    if (queue) queue.frames = queue.frames.filter((frame) => frame.subscriptionId !== subscriptionId);
  }
  function current(entry: Entry, generation: number): boolean { return entries.get(entry.key) === entry && entry.generation === generation; }
  function removeSub(sub: Sub): void {
    subscriptions.delete(sub.id);
    const socketKeys = bySocket.get(sub.ws);
    socketKeys?.delete(sub.key);
    if (socketKeys?.size === 0) bySocket.delete(sub.ws);
  }
  function invalidate(entry: Entry, reason: string): void {
    if (!current(entry, entry.generation)) return;
    entry.generation += 1;
    entries.delete(entry.key);
    for (const sub of entry.subs.values()) { removeSub(sub); emit(sub.ws, { kind: 'pane.invalidated', subscriptionId: sub.id, key: sub.key, reason }); }
    entry.subs.clear();
  }
  async function ensureTarget(entry: Entry, generation: number): Promise<boolean> {
    if (entry.terminal.runtime === 'herdr') return !!runtimeRegistry;
    if (!entry.tmux || !entry.process) return false;
    if (entry.target && now() - entry.mintedAt < PANE_REMINT_MS) return true;
    try {
      const target = await mintTarget(entry.lane, entry.tmux, entry.process);
      if (!current(entry, generation)) return false;
      entry.target = target; entry.mintedAt = now();
      return true;
    } catch {
      if (current(entry, generation)) invalidate(entry, entry.target ? 'remint_failed' : 'unauthorized');
      return false;
    }
  }
  function attach(sub: Sub, entry: Entry): void {
    if (entry.output === null || entry.hash === null) return;
    emit(sub.ws, { kind: 'pane.attached', protocolVersion: 2, subscriptionId: sub.id, key: sub.key, lane: sub.lane, terminal: entry.terminal, capturedAtMs: now(), outputHash: entry.hash, ...(sub.knownHash === entry.hash ? {} : { output: entry.output }), ...(entry.terminal.runtime === 'tmux' ? { verifiedUntilMs: entry.mintedAt + PANE_REMINT_MS } : {}) });
    sub.attached = true;
  }
  function capture(entry: Entry): Promise<void> {
    if (entry.inFlight) return entry.inFlight;
    const generation = entry.generation;
    entry.inFlight = (async () => {
      if (!await ensureTarget(entry, generation) || !current(entry, generation)) return;
      let output: string;
      if (entry.terminal.runtime === 'herdr') {
        const result = await runtimeRegistry?.read({ runtime: 'herdr', sourceId: entry.terminal.sourceId, targetId: entry.terminal.targetId });
        if (!result) { if (current(entry, generation)) invalidate(entry, 'unauthorized'); return; }
        output = normalizeOutput(result.ansi);
      } else {
        try { await assertIdentity(entry.tmux!); } catch { if (current(entry, generation)) invalidate(entry, 'pane_identity_changed'); return; }
        if (!await ensureTarget(entry, generation) || !current(entry, generation) || !entry.target) return;
        try { output = normalizeOutput(await capturePane(entry.target)); } catch { if (current(entry, generation)) invalidate(entry, now() - entry.mintedAt >= PANE_REMINT_MS ? 'remint_failed' : 'pane_identity_changed'); return; }
      }
      if (!current(entry, generation)) return;
      const outputHash = createHash(PANE_OUTPUT_HASH).update(output).digest('hex');
      const changed = entry.hash !== outputHash;
      entry.output = output; entry.hash = outputHash;
      for (const sub of entry.subs.values()) {
        if (!sub.attached) attach(sub, entry);
        else if (changed) emit(sub.ws, { kind: 'pane.output', protocolVersion: 2, subscriptionId: sub.id, key: sub.key, terminal: entry.terminal, capturedAtMs: now(), outputHash, output });
      }
    })().finally(() => { if (entry.inFlight) entry.inFlight = null; });
    return entry.inFlight;
  }
  async function subscribe(ws: WebSocket, data: Record<string, unknown>): Promise<void> {
    const { lane, terminal, tmux, process } = parseSubscription(data);
    const key = terminal.runtime === 'herdr'
      ? publicTerminalKey(lane, { runtime: 'herdr', sourceId: terminal.sourceId, targetId: terminal.targetId })
      : paneSubscriptionKey(lane, terminal.tmux, process!);
    const prior = bySocket.get(ws)?.get(key);
    if (prior) {
      const old = subscriptions.get(prior);
      if (old) {
        discardQueuedFrames(ws, old.id);
        emit(ws, { kind: 'pane.invalidated', protocolVersion: 2, subscriptionId: old.id, key: old.key, reason: 'superseded' });
        entries.get(old.key)?.subs.delete(ws);
        removeSub(old);
      }
    }
    let entry = entries.get(key);
    if (!entry) { entry = { key, lane, terminal, tmux, process, mintedAt: 0, hash: null, output: null, generation: 0, subs: new Map(), inFlight: null }; entries.set(key, entry); }
    const sub: Sub = { id: `s-${randomUUID()}`, ws, key, lane, attached: false, ...(typeof data.knownOutputHash === 'string' ? { knownHash: data.knownOutputHash } : {}) };
    subscriptions.set(sub.id, sub); entry.subs.set(ws, sub); const socketKeys = bySocket.get(ws) ?? new Map(); socketKeys.set(key, sub.id); bySocket.set(ws, socketKeys);
    if (entry.output !== null) attach(sub, entry); else await capture(entry);
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  function start(): void { timer ??= setTimer(() => { for (const entry of entries.values()) void capture(entry); }, C_CAPTURE_MS); }
  function reconcile(snapshot: DiscoverySnapshot): void {
    for (const lane of ['external', 'live'] as const) { if (snapshot.health[lane].ok) unavailableSince.delete(lane); else unavailableSince.set(lane, unavailableSince.get(lane) ?? now()); }
    for (const entry of entries.values()) {
      if (now() - (unavailableSince.get(entry.lane) ?? now()) >= PANE_UNAVAILABLE_TIMEOUT_MS) { invalidate(entry, 'lane_unavailable_timeout'); continue; }
      // Discovery never authorizes Herdr; every capture invokes its fresh pane.read path.
      if (entry.terminal.runtime === 'herdr') continue;
      const row = snapshot.rows.find((candidate) => candidate.key === `${entry.lane}\0${tmuxPaneIdentityKey(entry.tmux!)}`);
      if (!row) invalidate(entry, 'row_removed');
      else if (row.process?.pid !== entry.process!.pid || row.process?.startedAtMs !== entry.process!.startedAtMs) invalidate(entry, 'process_generation_changed');
    }
  }
  function close(ws: WebSocket): void { for (const id of bySocket.get(ws)?.values() ?? []) { const sub = subscriptions.get(id); const entry = sub && entries.get(sub.key); if (sub && entry) { entry.subs.delete(ws); removeSub(sub); if (entry.subs.size === 0) invalidate(entry, 'connection_closed'); } } const queue = queues.get(ws); if (queue?.retryTimer) clearTimeout(queue.retryTimer); queues.delete(ws); }
  return { subscribe, validateSubscription(data: Record<string, unknown>) { parseSubscription(data); }, unsubscribe(ws: WebSocket, id: string) { const sub = subscriptions.get(id); const entry = sub && entries.get(sub.key); if (sub?.ws === ws && entry) { entry.subs.delete(ws); removeSub(sub); if (entry.subs.size === 0) invalidate(entry, 'superseded'); } }, close, start, reconcile, dispose() { if (timer) clearTimer(timer); for (const queue of queues.values()) if (queue.retryTimer) clearTimeout(queue.retryTimer); queues.clear(); for (const entry of [...entries.values()]) invalidate(entry, 'server_closing'); } };
}
