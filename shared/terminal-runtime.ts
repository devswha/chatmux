import type { TmuxPaneIdentity } from './tmux.js';

export type TerminalRuntime = 'tmux' | 'herdr';
export type ProcessGeneration = { pid: number; startedAtMs: number };
export type TerminalTargetClass = 'local-agent' | 'attach-only';
export type RuntimeCapability = 'discovery' | 'output' | 'actions' | 'attach' | 'create';
export type RuntimeCapabilities = Readonly<Record<RuntimeCapability, boolean>>;

export type PublicTerminalRef =
  | { runtime: 'tmux'; tmux: TmuxPaneIdentity }
  | { runtime: 'herdr'; sourceId: string; targetId: string };

export type PublicTerminalTarget =
  | { runtime: 'tmux'; tmux: TmuxPaneIdentity; process: ProcessGeneration; targetClass: 'local-agent' }
  | { runtime: 'tmux'; tmux: TmuxPaneIdentity; targetClass: 'attach-only'; admissionCapability: string }
  | { runtime: 'herdr'; sourceId: string; targetId: string; targetClass: 'local-agent'; process: ProcessGeneration }
  | { runtime: 'herdr'; sourceId: string; targetId: string; targetClass: 'attach-only'; admissionCapability: string };

export type DiscoveryLane = 'external' | 'live';
export type SourceReadiness = 'disabled' | 'platform_unsupported' | 'missing' | 'offline' | 'incompatible' | 'degraded' | 'ready';
export type SourceCoverage = 'authoritative' | 'retained' | 'none';
export type SourceDescriptor = { runtime: TerminalRuntime; sourceId: string; readiness: SourceReadiness };
export type SourceLaneKey = string;
export type SourceLaneState = { lane: DiscoveryLane; sourceId: string; runtime: TerminalRuntime; readiness: SourceReadiness; capabilities: RuntimeCapabilities; sourceLaneRevision: number; lastOkGlobalRevision: number; coverage: SourceCoverage; consecutiveFailures: number };
export type LaneCoverage = { lane: DiscoveryLane; state: 'complete' | 'partial' | 'unavailable'; expectedSourceLaneKeys: SourceLaneKey[]; authoritativeSourceLaneKeys: SourceLaneKey[]; retainedSourceLaneKeys: SourceLaneKey[]; unavailableSourceLaneKeys: SourceLaneKey[] };

export type DiscoveryTerminal = { lane: DiscoveryLane; terminal: PublicTerminalTarget };
export type TmuxDiscoveryProjection = {
  key: string;
  lane: DiscoveryLane;
  tmuxName: string;
  tmux: TmuxPaneIdentity;
  process: ProcessGeneration | null;
  kind: string;
  providerSessionId: string | null;
  activity: 'running' | 'waiting_user' | 'asking_user' | 'error' | 'unknown';
  tmuxActionable?: boolean;
  cwd: string | null;
  presence: 'present' | 'stale';
};
export type DiscoveryV2 = { version: 2; epoch: string; globalRevision: number; terminals: DiscoveryTerminal[]; tmuxRows?: TmuxDiscoveryProjection[]; sourceDescriptors: SourceDescriptor[]; sourceLanes: SourceLaneState[]; coverageByLane: Record<DiscoveryLane, LaneCoverage> };
export type PaneV2 = { version: 2; lane: DiscoveryLane; terminal: PublicTerminalTarget; ansi: string; truncated: boolean };
export type RestTerminalContractV2 = { version: 2; terminal: PublicTerminalTarget; capabilities: RuntimeCapabilities };

export type ShellV3InitRequest = { type: 'terminal.init'; protocolVersion: 3; mode: 'observe' | 'control'; target: PublicTerminalTarget; cols: number; rows: number };
export type ShellV3ClientMessage =
  | ShellV3InitRequest
  | { type: 'terminal.input'; text: string }
  | { type: 'terminal.resize'; cols: number; rows: number }
  | { type: 'terminal.release' };
export type ShellV3ServerMessage =
  | { type: 'terminal.lifecycle'; state: 'acquiring' | 'ready' | 'busy' | 'identity_invalidated' | 'ownership_lost' | 'gap' | 'redraw_required' | 'source_disabled' | 'closed'; reason?: string }
  | { type: 'terminal.frame'; seq: number; encoding: 'ansi'; width: number; height: number; full: boolean; bytes: string }
  | { type: 'terminal.closed'; reason: string };
export type ShellV3Lifecycle = Extract<ShellV3ServerMessage, { type: 'terminal.lifecycle' }>['state'];

export function sourceLaneKey(lane: DiscoveryLane, sourceId: string): SourceLaneKey { return `${lane}\u0000${sourceId}`; }
export function publicTerminalKey(lane: DiscoveryLane, terminal: PublicTerminalRef): string {
  return terminal.runtime === 'herdr' ? `${lane}\u0000herdr\u0000${terminal.sourceId}\u0000${terminal.targetId}` : `${lane}\u0000tmux\u0000${terminal.tmux.socketPath}\u0000${terminal.tmux.sessionId}\u0000${terminal.tmux.windowId}\u0000${terminal.tmux.paneId}`;
}
const HERDR_SOURCE_ID_RE = /^hsrc_[A-Za-z0-9_-]{22}$/;
const HERDR_TARGET_ID_RE = /^htgt_[A-Za-z0-9_-]{22}$/;
export function readPublicTerminalRef(value: unknown): PublicTerminalRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as { runtime?: unknown; sourceId?: unknown; targetId?: unknown; tmux?: unknown };
  if (v.runtime === 'herdr' && typeof v.sourceId === 'string' && HERDR_SOURCE_ID_RE.test(v.sourceId) && typeof v.targetId === 'string' && HERDR_TARGET_ID_RE.test(v.targetId)) return { runtime: 'herdr', sourceId: v.sourceId, targetId: v.targetId };
  if (v.runtime === 'tmux' && v.tmux && typeof v.tmux === 'object' && !Array.isArray(v.tmux)) {
    const tmux = v.tmux as Partial<TmuxPaneIdentity>;
    if (typeof tmux.socketPath === 'string' && tmux.socketPath.startsWith('/') && tmux.socketPath.length <= 4096 && !tmux.socketPath.includes('\0') && typeof tmux.sessionId === 'string' && tmux.sessionId.length > 0 && tmux.sessionId.length <= 128 && typeof tmux.windowId === 'string' && tmux.windowId.length > 0 && tmux.windowId.length <= 128 && typeof tmux.paneId === 'string' && tmux.paneId.length > 0 && tmux.paneId.length <= 128) return { runtime: 'tmux', tmux: tmux as TmuxPaneIdentity };
  }
  return null;
}
export function readPublicTerminalTarget(value: unknown): PublicTerminalTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as { targetClass?: unknown; process?: unknown; admissionCapability?: unknown };
  const ref = readPublicTerminalRef(value);
  if (!ref) return null;
  const process = readProcessGeneration(v.process);
  if (v.targetClass === 'local-agent' && process) return { ...ref, targetClass: 'local-agent', process } as PublicTerminalTarget;
  if (v.targetClass === 'attach-only' && typeof v.admissionCapability === 'string' && v.admissionCapability.length >= 16 && v.admissionCapability.length <= 4096) return { ...ref, targetClass: 'attach-only', admissionCapability: v.admissionCapability } as PublicTerminalTarget;
  return null;
}
export function readShellV3InitRequest(value: unknown): ShellV3InitRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as { type?: unknown; protocolVersion?: unknown; mode?: unknown; target?: unknown; cols?: unknown; rows?: unknown };
  const target = readPublicTerminalTarget(v.target);
  const cols = typeof v.cols === 'number' ? v.cols : null;
  const rows = typeof v.rows === 'number' ? v.rows : null;
  if (v.type !== 'terminal.init' || v.protocolVersion !== 3 || (v.mode !== 'observe' && v.mode !== 'control') || !target || !Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols === null || cols < 1 || cols > 1000 || rows === null || rows < 1 || rows > 1000) return null;
  return { type: 'terminal.init', protocolVersion: 3, mode: v.mode, target, cols, rows };
}
export function readProcessGeneration(value: unknown): ProcessGeneration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Partial<ProcessGeneration>;
  return typeof v.pid === 'number' && Number.isSafeInteger(v.pid) && v.pid > 1 && typeof v.startedAtMs === 'number' && Number.isFinite(v.startedAtMs) && v.startedAtMs > 0 ? { pid: v.pid, startedAtMs: v.startedAtMs } : null;
}
export function readRuntimeCapabilities(value: unknown): RuntimeCapabilities | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Partial<RuntimeCapabilities>;
  return ['discovery', 'output', 'actions', 'attach', 'create'].every((key) => typeof v[key as RuntimeCapability] === 'boolean') ? v as RuntimeCapabilities : null;
}
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export function decodeFramedBase64(value: string, maxEncoded = 2 * 1024 * 1024, maxDecoded = 1024 * 1024): Uint8Array | null {
  if (value.length > maxEncoded || !BASE64_RE.test(value) || value.length % 4 !== 0) return null;
  const decodedLength = (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  if (decodedLength > maxDecoded) return null;
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
export function readTerminalFrame(value: unknown, previousSeq: number | null): Extract<ShellV3ServerMessage, { type: 'terminal.frame' }> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Partial<Extract<ShellV3ServerMessage, { type: 'terminal.frame' }>>;
  if (v.type !== 'terminal.frame' || !Number.isSafeInteger(v.seq) || v.seq! < 1 || (previousSeq !== null && v.seq !== previousSeq + 1) || v.encoding !== 'ansi' || !Number.isSafeInteger(v.width) || !Number.isSafeInteger(v.height) || v.width! < 1 || v.width! > 1000 || v.height! < 1 || v.height! > 1000 || typeof v.full !== 'boolean' || typeof v.bytes !== 'string' || !decodeFramedBase64(v.bytes)) return null;
  return v as Extract<ShellV3ServerMessage, { type: 'terminal.frame' }>;
}
