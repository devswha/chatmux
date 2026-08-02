import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import { cursorCliCommandOrDefault } from '@/modules/providers/index.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

import { readPublicTerminalTarget, readShellV3InitRequest, readTerminalFrame, type PublicTerminalTarget, type ShellV3ServerMessage } from '../../../../shared/terminal-runtime.js';
export const SHELL_PROTOCOL_VERSION = 3;

type ShellInitMode = 'plain-shell' | 'typed-attach';
type TmuxAttachTargetClass = 'local-agent' | 'attach-only';
type TmuxPaneIdentity = { socketPath: string; sessionId: string; windowId: string; paneId: string };
type CurrentTmuxPaneIdentity =
  | { state: 'unavailable' | 'not-hosted' }
  | { state: 'hosted'; tmux: TmuxPaneIdentity };
type AttachCapabilityService = { verify: (token: unknown, principal: string, tmux: TmuxPaneIdentity) => Promise<boolean> };

type ShellIncomingMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  sessionId?: string | null;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string | null;
  isPlainShell?: boolean;
  forceRestart?: boolean;
  lastSeq?: unknown;
  shellProtocolVersion?: number;
  mode?: ShellInitMode;
  targetClass?: TmuxAttachTargetClass;
  tmux?: unknown;
  process?: unknown;
  capability?: unknown;
};
type TmuxV3InitRequest = {
  type: 'terminal.init';
  protocolVersion: 3;
  mode: ShellInitMode;
  projectPath?: unknown;
  sessionId?: unknown;
  hasSession?: unknown;
  provider?: unknown;
  cols?: unknown;
  rows?: unknown;
  initialCommand?: unknown;
  isPlainShell?: unknown;
  forceRestart?: unknown;
  lastSeq?: unknown;
  target?: unknown;
};

type PtySessionEntry = {
  pty: IPty;
  ws: WebSocket | null;
  buffer: Array<{ seq: number; data: string }>;
  /** Sequence number of the newest PTY chunk ever produced for this session. */
  lastSeq: number;
  timeoutId: NodeJS.Timeout | null;
  projectPath: string;
  sessionId: string | null;
  lease?: Readonly<{ principal: string; tmux: { socketPath: string; sessionId: string; windowId: string; paneId: string } }>;
};

const ptySessionsMap = new Map<string, PtySessionEntry>();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;

export type ShellAttachDiagnostic = Readonly<{
  code: 'attach_refused_identity' | 'attach_refused_protected';
  provider: string;
  count: number;
}>;

export type HerdrControllerProcess = {
  stdin: { write: (chunk: string) => boolean; end: () => void; once?: (event: 'drain', listener: () => void) => void };
  stdout: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => void };
  stderr: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => void };
  on: (event: 'error' | 'exit', listener: (...args: unknown[]) => void) => void;
  kill: () => void;
};

export type HerdrTerminalControl = {
  acquireController: (request: {
    target: Extract<PublicTerminalTarget, { runtime: 'herdr' }>;
    principal: string;
    admissionCapability?: string;
    cols: number;
    rows: number;
  }) => Promise<{
    command: string;
    args: string[];
    release: () => void | Promise<void>;
    onRevoke?: (callback: () => void | Promise<void>) => () => void;
    assertWriteAllowed?: () => boolean;
    assertFreshIdentity: () => Promise<boolean>;
  } | null>;
  observe: (request: {
    target: Extract<PublicTerminalTarget, { runtime: 'herdr' }>;
    principal: string;
    emitFrame: (frame: ShellV3ServerMessage) => void;
  }) => Promise<{
    release: () => void | Promise<void>;
    onRevoke?: (callback: () => void | Promise<void>) => () => void;
    assertWriteAllowed?: () => boolean;
    assertFreshIdentity: () => Promise<boolean>;
  } | null>;
};

export type ShellWebSocketDependencies = {
  resolveProviderSessionId: (
    sessionId: string,
    provider: string,
  ) => string | null | undefined;
  stripAnsiSequences: (content: string) => string;
  normalizeDetectedUrl: (url: string) => string | null;
  extractUrlsFromText: (content: string) => string[];
  shouldAutoOpenUrlFromOutput: (content: string) => boolean;
  spawn?: typeof pty.spawn;
  assertFreshExternalTmuxTarget?: (
    tmux: unknown,
    process: unknown,
  ) => Promise<{ tmux: TmuxPaneIdentity; kind: string; tmuxName?: string | null }>;
  assertTmuxPaneIdentity?: (tmux: TmuxPaneIdentity) => Promise<void>;
  getCurrentTmuxPaneIdentity?: () => Promise<TmuxPaneIdentity | null>;
  getCurrentTmuxPaneIdentityState?: () => Promise<CurrentTmuxPaneIdentity>;
  readTmuxPaneIdentity?: (tmux: unknown) => TmuxPaneIdentity;
  runTmux?: (args: string[]) => Promise<{ code: number; output: string }>;
  attachCapabilities?: AttachCapabilityService;
  principal?: string;
  diagnostic?: (event: ShellAttachDiagnostic) => void;
  now?: () => number;
  readTmuxSessionName?: (tmux: { socketPath: string; paneId: string }) => Promise<string | null>;
  herdrControl?: HerdrTerminalControl;
  spawnHerdrController?: (command: string, args: string[]) => HerdrControllerProcess;
};

/**
 * Reads a string field from untyped payloads and falls back when absent.
 */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a boolean field from untyped payloads and falls back when absent.
 */
function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads a finite number field from untyped payloads and falls back when absent.
 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function readTerminalDimension(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
const ATTACH_DIAGNOSTIC_INTERVAL_MS = 60_000;

const attachDiagnosticCounts = new Map<string, number>();
const attachDiagnosticLastReportedAt = new Map<string, number>();
const attachDiagnosticSinkIds = new WeakMap<object, number>();
let nextAttachDiagnosticSinkId = 1;
const defaultAttachDiagnostic = (event: ShellAttachDiagnostic): void => {
  console.warn('Shell attach diagnostic:', event);
};

function createAttachDiagnosticEmitter(
  diagnostic: ((event: ShellAttachDiagnostic) => void) | undefined,
  now: () => number,
): (code: ShellAttachDiagnostic['code'], provider: string) => void {
  const sink = diagnostic ?? defaultAttachDiagnostic;
  const sinkId = attachDiagnosticSinkIds.get(sink) ?? nextAttachDiagnosticSinkId++;
  attachDiagnosticSinkIds.set(sink, sinkId);
  return (code, provider) => {
    const key = `${sinkId}\u0000${code}\u0000${provider}`;
    const count = (attachDiagnosticCounts.get(key) ?? 0) + 1;
    attachDiagnosticCounts.set(key, count);
    const reportedAt = now();
    if ((attachDiagnosticLastReportedAt.get(key) ?? -ATTACH_DIAGNOSTIC_INTERVAL_MS) + ATTACH_DIAGNOSTIC_INTERVAL_MS > reportedAt) return;
    attachDiagnosticLastReportedAt.set(key, reportedAt);
    sink({ code, provider, count });
  };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function shellQuote(value: string): string {
  if (os.platform() === 'win32') return `'${value.replaceAll("'", "''")}'`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildTypedAttachCommand(tmux: {
  socketPath: string;
  sessionId: string;
  windowId: string;
  paneId: string;
}): string {
  return `tmux -S ${shellQuote(tmux.socketPath)} select-window -t ${shellQuote(tmux.windowId)} \\; select-pane -t ${shellQuote(tmux.paneId)} \\; attach-session -t ${shellQuote(tmux.sessionId)}`;
}
async function readTmuxSessionName(
  tmux: { socketPath: string; paneId: string },
  runTmux: NonNullable<ShellWebSocketDependencies['runTmux']>,
): Promise<string | null> {
  const result = await runTmux([
    '-S', tmux.socketPath,
    'display-message', '-p', '-t', tmux.paneId,
    '#{session_name}',
  ]);
  return result.code === 0 && result.output.trim() ? result.output.trim() : null;
}

async function assertNotProtectedAttachTarget(
  tmux: { socketPath: string; paneId: string },
  provider: string,
  dependencies: ShellWebSocketDependencies,
  emitDiagnostic: (code: ShellAttachDiagnostic['code'], provider: string) => void,
  tmuxName?: string | null,
): Promise<void> {
  const readSessionName = dependencies.readTmuxSessionName
    ?? (dependencies.runTmux ? (target) => readTmuxSessionName(target, dependencies.runTmux!) : undefined);
  const name = tmuxName === undefined ? await readSessionName?.(tmux) : tmuxName;
  const normalizedName = name?.trim();
  if (!normalizedName) {
    emitDiagnostic('attach_refused_protected', provider);
    throw new Error('The tmux target protection status could not be verified.');
  }
  if (normalizedName.toLowerCase().startsWith('company')) {
    emitDiagnostic('attach_refused_protected', provider);
    throw new Error('This tmux target is protected.');
  }
  let current: CurrentTmuxPaneIdentity;
  if (dependencies.getCurrentTmuxPaneIdentityState) {
    current = await dependencies.getCurrentTmuxPaneIdentityState();
  } else if (dependencies.getCurrentTmuxPaneIdentity) {
    const identity = await dependencies.getCurrentTmuxPaneIdentity();
    current = identity ? { state: 'hosted', tmux: identity } : { state: 'unavailable' };
  } else {
    current = { state: 'unavailable' };
  }
  if (current.state === 'unavailable') {
    emitDiagnostic('attach_refused_protected', provider);
    throw new Error('The ChatMux tmux pane protection status could not be verified.');
  }
  if (
    current.state === 'hosted'
    && current.tmux.socketPath === tmux.socketPath
    && current.tmux.paneId === tmux.paneId
  ) {
    emitDiagnostic('attach_refused_protected', provider);
    throw new Error('The tmux target hosting ChatMux is protected.');
  }
}

function protocolError(ws: WebSocket, message: string): void {
  ws.send(JSON.stringify({
    type: 'error',
    code: 'CLIENT_RELOAD_REQUIRED',
    message,
    reloadRequired: true,
  }));
  ws.close();
}
function readTmuxV3InitRequest(value: unknown): ShellIncomingMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const init = value as TmuxV3InitRequest;
  if (
    init.type !== 'terminal.init'
    || init.protocolVersion !== SHELL_PROTOCOL_VERSION
    || (init.mode !== 'plain-shell' && init.mode !== 'typed-attach')
  ) return null;
  if (
    typeof init.projectPath !== 'string'
    || (init.sessionId !== null && typeof init.sessionId !== 'string')
    || typeof init.hasSession !== 'boolean'
    || typeof init.provider !== 'string'
    || typeof init.cols !== 'number'
    || !Number.isSafeInteger(init.cols)
    || init.cols < 1
    || init.cols > 1000
    || typeof init.rows !== 'number'
    || !Number.isSafeInteger(init.rows)
    || init.rows < 1
    || init.rows > 1000
    || (init.forceRestart !== undefined && typeof init.forceRestart !== 'boolean')
    || (init.lastSeq !== undefined && (typeof init.lastSeq !== 'number' || !Number.isSafeInteger(init.lastSeq) || init.lastSeq < 0))
  ) return null;

  const common = {
    type: 'init',
    shellProtocolVersion: SHELL_PROTOCOL_VERSION,
    projectPath: init.projectPath,
    sessionId: init.sessionId,
    hasSession: init.hasSession,
    provider: init.provider,
    cols: init.cols,
    rows: init.rows,
    forceRestart: init.forceRestart,
    lastSeq: init.lastSeq,
    mode: init.mode,
  } satisfies ShellIncomingMessage;

  if (init.mode === 'plain-shell') {
    if (
      'target' in init
      || hasOwn(init, 'targetClass')
      || hasOwn(init, 'tmux')
      || hasOwn(init, 'process')
      || hasOwn(init, 'capability')
      || (init.initialCommand !== undefined && init.initialCommand !== null && typeof init.initialCommand !== 'string')
      || typeof init.isPlainShell !== 'boolean'
    ) return null;
    return { ...common, initialCommand: init.initialCommand, isPlainShell: init.isPlainShell };
  }
  if (hasOwn(init, 'initialCommand')) return null;

  const target = readPublicTerminalTarget(init.target);
  if (!target || target.runtime !== 'tmux') return null;
  if (target.targetClass === 'local-agent') {
    return { ...common, targetClass: 'local-agent', tmux: target.tmux, process: target.process };
  }
  return { ...common, targetClass: 'attach-only', tmux: target.tmux, capability: target.admissionCapability };
}

async function assertAttachTarget(
  data: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies,
  emitDiagnostic: (code: ShellAttachDiagnostic['code'], provider: string) => void,
): Promise<{ command: string; provider: string; attachOnlyTmux?: { socketPath: string; sessionId: string; windowId: string; paneId: string } }> {
  if (data.targetClass !== 'local-agent' && data.targetClass !== 'attach-only') {
    throw new Error('Invalid typed attach target class.');
  }

  try {
    if (data.targetClass === 'local-agent') {
      const assertFresh = dependencies.assertFreshExternalTmuxTarget;
      if (!assertFresh) throw new Error('The tmux target identity verifier is unavailable.');
      const target = await assertFresh(data.tmux, data.process);
      await assertNotProtectedAttachTarget(
        target.tmux,
        target.kind,
        dependencies,
        emitDiagnostic,
        target.tmuxName,
      );
      return { command: buildTypedAttachCommand(target.tmux), provider: target.kind };
    }

    const readIdentity = dependencies.readTmuxPaneIdentity;
    const assertIdentity = dependencies.assertTmuxPaneIdentity;
    if (!readIdentity || !assertIdentity) throw new Error('The tmux target identity verifier is unavailable.');
    const tmux = readIdentity(data.tmux);
    await assertIdentity(tmux);
    await assertNotProtectedAttachTarget(tmux, 'attach-only', dependencies, emitDiagnostic);
    return { command: buildTypedAttachCommand(tmux), provider: 'attach-only', attachOnlyTmux: tmux };
  } catch (error) {
    if (error instanceof Error && error.message.includes('protected')) throw error;
    emitDiagnostic('attach_refused_identity', data.targetClass);
    throw error;
  }
}


// Sequence-acknowledged resume (EternalTerminal-style backed writer): the
// client reports the last output seq it rendered, and reconnects replay only
// the gap. Anything unparseable disables seamless resume (full redraw).
function readClientLastSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

const REDRAW_TERMINAL_QUERY_PATTERN = /\x1b\[(?:(?:[=>?])?[0-9;]*c|\??(?:5|6)n|>[0-9;]*q)/g;

/**
 * A full redraw replays historical PTY output into a new xterm instance.
 * Terminal capability/status queries in that history are stale: replaying them
 * makes xterm answer again and the running CLI can mistake the response for
 * typed input. Live output and seamless gap resumes remain byte-exact.
 */
export function stripTerminalQueriesForRedraw(output: string): string {
  return output.replace(REDRAW_TERMINAL_QUERY_PATTERN, '');
}

const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_.\-:]+$/;

function resolveResumeSessionId(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const sessionId = readString(message.sessionId);
  const provider = readString(message.provider, 'claude');

  if (!hasSession || !sessionId) {
    return '';
  }

  let resumeSessionId: string | null | undefined;
  try {
    resumeSessionId = dependencies.resolveProviderSessionId(sessionId, provider);
  } catch (error) {
    console.error('Failed to resolve provider session ID:', error);
    resumeSessionId = undefined;
  }

  const resolvedSessionId = resumeSessionId === undefined ? sessionId : resumeSessionId;
  if (!resolvedSessionId || !SAFE_SESSION_ID_PATTERN.test(resolvedSessionId)) {
    return '';
  }

  return resolvedSessionId;
}

/**
 * Resolves provider command line for plain shell and agent-backed shell modes.
 */
function buildShellCommand(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const initialCommand = readString(message.initialCommand);
  const provider = readString(message.provider, 'claude');
  const resumeSessionId = resolveResumeSessionId(message, dependencies);
  const isPlainShell =
    readBoolean(message.isPlainShell) ||
    (!!initialCommand && !hasSession) ||
    provider === 'plain-shell';

  if (isPlainShell) {
    return initialCommand;
  }

  if (provider === 'cursor') {
    const cursorCommand = cursorCliCommandOrDefault();
    if (resumeSessionId) {
      return `${cursorCommand} --resume="${resumeSessionId}"`;
    }
    return cursorCommand;
  }

  if (provider === 'codex') {
    if (resumeSessionId) {
      if (os.platform() === 'win32') {
        return `codex resume "${resumeSessionId}"; if ($LASTEXITCODE -ne 0) { codex }`;
      }
      return `codex resume "${resumeSessionId}" || codex`;
    }
    return 'codex';
  }

  if (provider === 'opencode') {
    if (resumeSessionId) {
      return `opencode --session "${resumeSessionId}"`;
    }
    return initialCommand || 'opencode';
  }

  const command = initialCommand || 'claude';
  if (resumeSessionId) {
    if (os.platform() === 'win32') {
      return `claude --resume "${resumeSessionId}"; if ($LASTEXITCODE -ne 0) { claude }`;
    }
    return `claude --resume "${resumeSessionId}" || claude`;
  }
  return command;
}

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const resolvedKey = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
  return resolvedKey ? env[resolvedKey] : undefined;
}

function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

function prioritizeUserNpmGlobalBin(env: NodeJS.ProcessEnv): { key: string; value: string | undefined } {
  const pathKey = getPathEnvKey(env);
  const currentPath = env[pathKey];
  if (!currentPath) {
    return { key: pathKey, value: currentPath };
  }

  const delimiter = path.delimiter;
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  const npmPrefix = readEnvValue(env, 'npm_config_prefix');
  const appData = readEnvValue(env, 'APPDATA');
  const candidates = [
    npmPrefix || '',
    npmPrefix ? path.join(npmPrefix, 'bin') : '',
    appData ? path.join(appData, 'npm') : '',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ].filter(Boolean);

  const normalizedPathEntries = pathEntries.map((entry) => os.platform() === 'win32' ? entry.toLowerCase() : entry);
  const preferredEntries = candidates.filter((candidate, index) => {
    const normalizedCandidate = os.platform() === 'win32' ? candidate.toLowerCase() : candidate;
    return (
      candidates.indexOf(candidate) === index &&
      normalizedPathEntries.includes(normalizedCandidate)
    );
  });

  if (preferredEntries.length === 0) {
    return { key: pathKey, value: currentPath };
  }

  const normalizedPreferredEntries = preferredEntries.map((entry) =>
    os.platform() === 'win32' ? entry.toLowerCase() : entry
  );

  const value = [
    ...preferredEntries,
    ...pathEntries.filter((entry) => {
      const normalizedEntry = os.platform() === 'win32' ? entry.toLowerCase() : entry;
      return !normalizedPreferredEntries.includes(normalizedEntry);
    }),
  ].join(delimiter);

  return { key: pathKey, value };
}

/**
 * Handles websocket connections used by the standalone shell terminal UI.
 */
const HERDR_INPUT_MAX_BYTES = 64 * 1024;
const HERDR_INPUT_QUEUE_MAX_MESSAGES = 256;
const HERDR_INPUT_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
const HERDR_NDJSON_MAX_BYTES = 2 * 1024 * 1024;
const HERDR_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;
const HERDR_IDENTITY_INTERVAL_MS = 2_000;
const HERDR_WS_QUEUE_MAX_FRAMES = 256;
const HERDR_WS_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
const HERDR_RELEASE_DEADLINE_MS = 1_000;

function isHerdrAuthority(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as { provider?: unknown; runtime?: unknown; target?: { runtime?: unknown } };
  return record.provider === 'herdr' || record.runtime === 'herdr' || record.target?.runtime === 'herdr';
}

function sendShellV3(ws: WebSocket, message: ShellV3ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function startHerdrShellConnection(ws: WebSocket, dependencies: ShellWebSocketDependencies, principal: string, init: ReturnType<typeof readShellV3InitRequest>): (raw: RawData) => Promise<void> {
  let closed = false;
  let released = false;
  let releaseStarted = false;
  let ready = false;
  let resource: { release: () => void | Promise<void>; onRevoke?: (callback: () => void | Promise<void>) => () => void; assertWriteAllowed?: () => boolean; assertFreshIdentity: () => Promise<boolean> } | null = null;
  let unregisterRevocation: (() => void) | null = null;
  let controller: HerdrControllerProcess | null = null;
  let controllerExited = false;
  let resolveControllerExit: (() => void) | null = null;
  let releasePromise: Promise<void> | null = null;
  let previousSeq: number | null = null;
  let ndjson = '';
  let identityCheckRunning = false;
  let queuedInputBytes = 0;
  let processingInput = false;
  let queuedFrames = 0;
  let queuedFrameBytes = 0;
  const inputQueue: Array<{ message: { type: 'terminal.input'; text: string } | { type: 'terminal.resize'; cols: number; rows: number }; bytes: number }> = [];
  const decoder = new TextDecoder();
  const controllerExit = new Promise<void>((resolve) => { resolveControllerExit = resolve; });

  const release = (reason: string, bridgeOwnsResourceRelease = false): Promise<void> => {
    if (releaseStarted) return releasePromise ?? Promise.resolve();
    releaseStarted = true;
    released = true;
    ready = false;
    unregisterRevocation?.();
    unregisterRevocation = null;
    const current = resource;
    resource = null;
    const currentController = controller;
    releasePromise = (async () => {
      try {
        if (currentController) currentController.stdin.write(`${JSON.stringify({ type: 'terminal.release' })}\n`);
      } catch {
        // A controller stdin failure is terminal; the lease release below remains mandatory.
      }
      const releasedResource = bridgeOwnsResourceRelease ? Promise.resolve() : Promise.resolve(current?.release()).catch(() => {});
      if (currentController) {
        let deadline: ReturnType<typeof setTimeout> | null = null;
        try {
          await Promise.race([
            Promise.all([controllerExit, releasedResource]).then(() => undefined),
            new Promise<void>((resolve) => { deadline = setTimeout(resolve, HERDR_RELEASE_DEADLINE_MS); }),
          ]);
        } finally {
          if (deadline) clearTimeout(deadline);
        }
      } else {
        await releasedResource;
      }
      if (currentController && !controllerExited) currentController.kill();
      controller = null;
      decoder.decode();
      sendShellV3(ws, { type: 'terminal.lifecycle', state: 'closed', reason });
      sendShellV3(ws, { type: 'terminal.closed', reason });
    })();
    return releasePromise;
  };
  const fail = (reason: string, state: Extract<ShellV3ServerMessage, { type: 'terminal.lifecycle' }>['state'] = 'closed') => {
    if (closed) return;
    closed = true;
    ready = false;
    clearInterval(identityTimer);
    clearTimeout(lifetimeTimer);
    sendShellV3(ws, { type: 'terminal.lifecycle', state, reason });
    void release(reason);
    if (ws.readyState === WebSocket.OPEN) ws.close();
  };
  const confirmReady = () => {
    if (ready || closed || !resource) return;
    void resource.assertFreshIdentity().then((valid) => {
      if (!valid) return fail('Target identity or policy is no longer valid.', 'identity_invalidated');
      if (closed || released) return;
      ready = true;
      sendShellV3(ws, { type: 'terminal.lifecycle', state: 'ready' });
    }).catch(() => fail('Target identity or policy is no longer valid.', 'identity_invalidated'));
  };
  const emitFrame = (message: ShellV3ServerMessage) => {
    if (closed || message.type !== 'terminal.frame') return;
    const frame = readTerminalFrame(message, previousSeq);
    if (!frame || (previousSeq === null && frame.seq !== 1)) return fail('Invalid controller frame.');
    const bytes = Buffer.from(frame.bytes, 'base64').length;
    if (queuedFrames + 1 > HERDR_WS_QUEUE_MAX_FRAMES || queuedFrameBytes + bytes > HERDR_WS_QUEUE_MAX_BYTES) return fail('Terminal output queue exceeded limit.');
    previousSeq = frame.seq;
    queuedFrames += 1;
    queuedFrameBytes += bytes;
    try {
      ws.send(JSON.stringify(frame), () => {
        queuedFrames -= 1;
        queuedFrameBytes -= bytes;
      });
    } catch {
      queuedFrames -= 1;
      queuedFrameBytes -= bytes;
      return fail('Terminal output write failed.');
    }
    confirmReady();
  };
  const waitForDrain = (stdin: HerdrControllerProcess['stdin']): Promise<void> => new Promise((resolve, reject) => {
    if (!stdin.once) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(new Error('controller_input_backpressure_timeout')), HERDR_RELEASE_DEADLINE_MS);
    stdin.once('drain', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  const processInput = () => {
    if (processingInput) return;
    processingInput = true;
    void (async () => {
      while (!closed && !released && inputQueue.length) {
        const item = inputQueue.shift()!;
        queuedInputBytes -= item.bytes;
        const current = resource;
        const currentController = controller;
        if (!ready || !current || !currentController) continue;
        const writeAllowed = current.assertWriteAllowed?.();
        if (writeAllowed === false || (writeAllowed === undefined && !await current.assertFreshIdentity())) {
          fail('Target identity or policy is no longer valid.', 'identity_invalidated');
          return;
        }
        if (!ready || closed || released || controller !== currentController) continue;
        try {
          if (!currentController.stdin.write(`${JSON.stringify(item.message)}\n`)) await waitForDrain(currentController.stdin);
        } catch {
          fail('Controller input write failed.');
          return;
        }
      }
    })().catch(() => fail('Controller input write failed.')).finally(() => {
      processingInput = false;
      if (!closed && !released && inputQueue.length) processInput();
    });
  };
  const enqueueInput = (message: { type: 'terminal.input'; text: string } | { type: 'terminal.resize'; cols: number; rows: number }) => {
    const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (inputQueue.length + 1 > HERDR_INPUT_QUEUE_MAX_MESSAGES || queuedInputBytes + bytes > HERDR_INPUT_QUEUE_MAX_BYTES) return fail('Terminal input queue exceeded limit.');
    inputQueue.push({ message, bytes });
    queuedInputBytes += bytes;
    processInput();
  };
  const identityTimer = setInterval(() => {
    if (closed || identityCheckRunning || !resource) return;
    identityCheckRunning = true;
    void resource.assertFreshIdentity().then((valid) => {
      if (!valid) fail('Target identity or policy is no longer valid.', 'identity_invalidated');
    }).catch(() => fail('Target identity or policy is no longer valid.', 'identity_invalidated')).finally(() => { identityCheckRunning = false; });
  }, HERDR_IDENTITY_INTERVAL_MS);
  identityTimer.unref();
  const lifetimeTimer = setTimeout(() => fail('Controller lease expired.', 'ownership_lost'), HERDR_MAX_LIFETIME_MS);
  lifetimeTimer.unref();
  const cleanup = (
    reason: string,
    bridgeOwnsResourceRelease = false,
    state: Extract<ShellV3ServerMessage, { type: 'terminal.lifecycle' }>['state'] = 'closed',
  ): Promise<void> => {
    if (closed) return releasePromise ?? Promise.resolve();
    closed = true;
    ready = false;
    clearInterval(identityTimer);
    clearTimeout(lifetimeTimer);
    sendShellV3(ws, { type: 'terminal.lifecycle', state, reason });
    const completion = release(reason, bridgeOwnsResourceRelease);
    if (ws.readyState === WebSocket.OPEN) ws.close();
    return completion;
  };
  ws.once('close', () => cleanup('Socket disconnected.'));
  ws.once('error', () => cleanup('Socket error.'));

  void (async () => {
    if (!init || init.target.runtime !== 'herdr' || !dependencies.herdrControl) return fail('Herdr control is unavailable.', 'source_disabled');
    sendShellV3(ws, { type: 'terminal.lifecycle', state: 'acquiring' });
    if (init.mode === 'observe') {
      resource = await dependencies.herdrControl.observe({ target: init.target, principal, emitFrame });
      if (!resource) return fail('Herdr observation is unavailable.', 'source_disabled');
      unregisterRevocation = resource.onRevoke?.(() => cleanup('Controller revoked.', true, 'ownership_lost')) ?? null;
      if (released) void Promise.resolve(resource.release()).catch(() => {});
      return;
    }
    const acquired = await dependencies.herdrControl.acquireController({
      target: init.target,
      principal,
      admissionCapability: 'admissionCapability' in init.target ? init.target.admissionCapability : undefined,
      cols: init.cols,
      rows: init.rows,
    });
    if (!acquired) return fail('Herdr terminal is busy or unavailable.', 'busy');
    resource = acquired;
    unregisterRevocation = acquired.onRevoke?.(() => cleanup('Controller revoked.', true, 'ownership_lost')) ?? null;
    if (released) {
      void Promise.resolve(acquired.release()).catch(() => {});
      return;
    }
    if (!dependencies.spawnHerdrController) return fail('Herdr controller launcher is unavailable.', 'source_disabled');
    controller = dependencies.spawnHerdrController(acquired.command, acquired.args);
    controller.stdout.on('data', (chunk) => {
      ndjson += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(ndjson, 'utf8') > HERDR_NDJSON_MAX_BYTES) return fail('Controller output exceeded limit.');
      let newline: number;
      while ((newline = ndjson.indexOf('\n')) >= 0) {
        const line = ndjson.slice(0, newline);
        ndjson = ndjson.slice(newline + 1);
        if (!line) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!readTerminalFrame(parsed, previousSeq)) return fail('Invalid controller frame.');
          emitFrame(parsed as ShellV3ServerMessage);
        } catch {
          return fail('Invalid controller frame.');
        }
      }
    });
    controller.stderr.on('data', (chunk) => {
      if (Buffer.byteLength(chunk) > 0) fail('Controller wrote to stderr.');
    });
    controller.on('error', () => fail('Controller error.'));
    controller.on('exit', () => {
      controllerExited = true;
      resolveControllerExit?.();
      if (!released) fail('Controller exited.');
    });
  })().catch(() => fail('Herdr control is unavailable.', 'source_disabled'));

  return async (raw: RawData) => {
    if (closed) return;
    const message = parseIncomingJsonObject(raw);
    if (!message || typeof message.type !== 'string') return fail('Invalid shell v3 message.');
    if (message.type === 'terminal.release') return cleanup('Released by client.');
    if (message.type === 'terminal.input') {
      if (!ready || !controller || !resource || typeof message.text !== 'string' || Buffer.byteLength(message.text, 'utf8') > HERDR_INPUT_MAX_BYTES) return;
      enqueueInput({ type: 'terminal.input', text: message.text });
      return;
    }
    if (message.type === 'terminal.resize') {
      if (!ready || !controller || !resource || !Number.isSafeInteger(message.cols) || !Number.isSafeInteger(message.rows) || message.cols < 1 || message.cols > 1000 || message.rows < 1 || message.rows > 1000) return;
      enqueueInput({ type: 'terminal.resize', cols: message.cols, rows: message.rows });
      return;
    }
    fail('Invalid shell v3 message.');
  };
}
export function handleShellConnection(
  ws: WebSocket,
  dependencies: ShellWebSocketDependencies,
  principal?: string,
): void {
  console.log('[INFO] Shell websocket connected');
  const connectionDependencies = principal === undefined ? dependencies : { ...dependencies, principal };

  let shellProcess: IPty | null = null;
  let ptySessionKey: string | null = null;
  let urlDetectionBuffer = '';
  const announcedAuthUrls = new Set<string>();
  const emitAttachDiagnostic = createAttachDiagnosticEmitter(connectionDependencies.diagnostic, connectionDependencies.now ?? Date.now);
  let herdrMessageHandler: ((raw: RawData) => Promise<void>) | null = null;

  ws.on('message', async (rawMessage) => {
    try {
      const rawData = parseIncomingJsonObject(rawMessage);
      if (herdrMessageHandler) {
        await herdrMessageHandler(rawMessage);
        return;
      }
      const v3Init = readShellV3InitRequest(rawData);
      if (v3Init?.target.runtime === 'herdr') {
        herdrMessageHandler = startHerdrShellConnection(
          ws,
          connectionDependencies,
          connectionDependencies.principal ?? '',
          v3Init,
        );
        return;
      }
      const tmuxV3Init = readTmuxV3InitRequest(rawData);
      if (
        !tmuxV3Init
        && (
          isHerdrAuthority(rawData)
          || (rawData && typeof rawData === 'object' && !Array.isArray(rawData)
            && ((rawData as { type?: unknown }).type === 'init' || (rawData as { type?: unknown }).type === 'terminal.init'))
        )
      ) {
        protocolError(ws, 'CLIENT_RELOAD_REQUIRED');
        return;
      }
      const data = tmuxV3Init ?? rawData as ShellIncomingMessage | null;
      if (!data?.type) {
        throw new Error('Invalid websocket payload');
      }

      if (data.type === 'init') {
        if (data.shellProtocolVersion !== SHELL_PROTOCOL_VERSION) {
          protocolError(ws, 'Shell protocol is outdated. Reload ChatMux and try again.');
          return;
        }
        if (data.mode !== 'plain-shell' && data.mode !== 'typed-attach') {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid shell init mode.' }));
          ws.close();
          return;
        }
        if (data.mode === 'typed-attach' && hasOwn(data, 'initialCommand')) {
          ws.send(JSON.stringify({ type: 'error', message: 'typed-attach init must not include initialCommand.' }));
          ws.close();
          return;
        }
        if (
          data.mode === 'plain-shell'
          && (hasOwn(data, 'targetClass') || hasOwn(data, 'tmux') || hasOwn(data, 'process') || hasOwn(data, 'capability'))
        ) {
          ws.send(JSON.stringify({ type: 'error', message: 'plain-shell init must not include typed attach fields.' }));
          ws.close();
          return;
        }
        const typedAttach = data.mode === 'typed-attach'
          ? await assertAttachTarget(data, connectionDependencies, emitAttachDiagnostic)
          : null;

        const projectPath = readString(data.projectPath, process.cwd());
        const sessionId = readString(data.sessionId) || null;
        const hasSession = readBoolean(data.hasSession);
        const provider = readString(data.provider, 'claude');
        const initialCommand = readString(data.initialCommand);
        const forceRestart = readBoolean(data.forceRestart);
        const clientLastSeq = readClientLastSeq(data.lastSeq);
        // Plain-shell commands are for a terminal only; never use this mode to attach tmux.
        const isPlainShell = data.mode === 'plain-shell';

        urlDetectionBuffer = '';
        announcedAuthUrls.clear();

        const isLoginCommand =
          !!initialCommand &&
          (initialCommand.includes('setup-token') ||
            /(?:^|\s)(?:agent|cursor-agent) login(?:\s|$)/.test(initialCommand) ||
            initialCommand.includes('auth login'));

        // Key by a hash of the complete server-selected command so reconnects
        // cannot cross a capability or plain-shell command boundary.
        const commandSuffix =
          typedAttach || (isPlainShell && initialCommand)
            ? `_cmd_${createHash('sha256').update(typedAttach?.command ?? initialCommand).digest('hex').slice(0, 16)}`
            : '';
        ptySessionKey = `${projectPath}_${sessionId ?? 'default'}${commandSuffix}`;

        const currentSession = ptySessionsMap.get(ptySessionKey);
        if (typedAttach?.attachOnlyTmux && currentSession) {
          const lease = currentSession.lease;
          const principal = connectionDependencies.principal ?? '';
          const target = typedAttach.attachOnlyTmux;
          if (
            !lease
            || lease.principal !== principal
            || lease.tmux.socketPath !== target.socketPath
            || lease.tmux.sessionId !== target.sessionId
            || lease.tmux.windowId !== target.windowId
            || lease.tmux.paneId !== target.paneId
          ) {
            throw new Error('The existing typed attach session is not leased to this target.');
          }
        }
        if (
          typedAttach?.attachOnlyTmux
          && (!currentSession || isLoginCommand || forceRestart)
          && !await connectionDependencies.attachCapabilities?.verify(
            data.capability,
            connectionDependencies.principal ?? '',
            typedAttach.attachOnlyTmux,
          )
        ) {
          throw new Error('The typed attach capability is invalid or expired.');
        }
        const existingSession =
          isLoginCommand || forceRestart ? null : currentSession;
        if (existingSession) {
          shellProcess = existingSession.pty;
          if (existingSession.timeoutId) {
            clearTimeout(existingSession.timeoutId);
          }

          // Seamless resume replays only the chunks the client has not seen.
          // Any doubt (legacy client, trimmed buffer, restarted PTY) falls
          // back to a full redraw so the terminal is never corrupted.
          const oldestBufferedSeq = existingSession.buffer[0]?.seq ?? existingSession.lastSeq + 1;
          const resume = clientLastSeq !== null
            && clientLastSeq <= existingSession.lastSeq
            && clientLastSeq >= oldestBufferedSeq - 1;
          ws.send(JSON.stringify({ type: 'replay_start', mode: resume ? 'resume' : 'redraw' }));
          if (!resume) {
            ws.send(
              JSON.stringify({
                type: 'output',
                data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n',
              })
            );
          }
          for (const entry of existingSession.buffer) {
            if (resume && entry.seq <= (clientLastSeq as number)) {
              continue;
            }
            const replayData = resume ? entry.data : stripTerminalQueriesForRedraw(entry.data);
            ws.send(JSON.stringify({ type: 'output', data: replayData, seq: entry.seq }));
          }

          existingSession.ws = ws;
          return;
        }

        const resolvedProjectPath = path.resolve(projectPath);
        try {
          const stats = fs.statSync(resolvedProjectPath);
          if (!stats.isDirectory()) {
            throw new Error('Not a directory');
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
          return;
        }

        const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
        if (sessionId && !safeSessionIdPattern.test(sessionId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
          return;
        }

        const shellCommand = typedAttach?.command ?? buildShellCommand(data, connectionDependencies);
        const resumeSessionId = isPlainShell ? '' : resolveResumeSessionId(data, connectionDependencies);
        const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        const shellArgs =
          os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand];
        const termCols = readTerminalDimension(data.cols, 80);
        const termRows = readTerminalDimension(data.rows, 24);
        if (termCols === null || termRows === null) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid terminal dimensions' }));
          return;
        }
        const prioritizedPath = prioritizeUserNpmGlobalBin(process.env);

        shellProcess = (connectionDependencies.spawn ?? pty.spawn)(shell, shellArgs, {
          name: 'xterm-256color',
          cols: termCols,
          rows: termRows,
          cwd: resolvedProjectPath,
          env: {
            ...process.env,
            [prioritizedPath.key]: prioritizedPath.value,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            FORCE_COLOR: '3',
          },
        });

        const replacement = ptySessionsMap.get(ptySessionKey);
        const newSession: PtySessionEntry = {
          pty: shellProcess,
          ws,
          buffer: [],
          lastSeq: 0,
          timeoutId: null,
          projectPath,
          sessionId,
          lease: typedAttach?.attachOnlyTmux
            ? Object.freeze({
              principal: connectionDependencies.principal ?? '',
              tmux: Object.freeze({ ...typedAttach.attachOnlyTmux }),
            })
            : undefined,
        };
        ptySessionsMap.set(ptySessionKey, newSession);
        if (replacement && replacement !== newSession) {
          if (replacement.timeoutId) {
            clearTimeout(replacement.timeoutId);
          }
          replacement.pty.kill();
        }

        shellProcess.onData((chunk) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (!session) {
            return;
          }

          session.lastSeq += 1;
          const seq = session.lastSeq;
          if (session.buffer.length >= 5000) {
            session.buffer.shift();
          }
          session.buffer.push({ seq, data: chunk });

          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            let outputData = chunk;
            const cleanChunk = dependencies.stripAnsiSequences(chunk);
            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

            outputData = outputData.replace(
              /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
              '[INFO] Opening in browser: $1'
            );

            const emitAuthUrl = (detectedUrl: string, autoOpen = false) => {
              const normalizedUrl = dependencies.normalizeDetectedUrl(detectedUrl);
              if (!normalizedUrl) {
                return;
              }

              const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
              if (isNewUrl) {
                announcedAuthUrls.add(normalizedUrl);
                session.ws?.send(
                  JSON.stringify({
                    type: 'auth_url',
                    url: normalizedUrl,
                    autoOpen,
                  })
                );
              }
            };

            const normalizedDetectedUrls = dependencies.extractUrlsFromText(urlDetectionBuffer)
              .map((url) => dependencies.normalizeDetectedUrl(url))
              .filter((url): url is string => Boolean(url));

            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter(
              (url, _, urls) =>
                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
            );

            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

            if (
              dependencies.shouldAutoOpenUrlFromOutput(cleanChunk) &&
              dedupedDetectedUrls.length > 0
            ) {
              const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                current.length > longest.length ? current : longest
              );
              emitAuthUrl(bestUrl, true);
            }

            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: outputData,
                seq,
              })
            );
          }
        });

        shellProcess.onExit((exitCode) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (session && session.pty !== shellProcess) {
            return;
          }

          if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${
                  exitCode.signal != null ? ` (${exitCode.signal})` : ''
                }\x1b[0m\r\n`,
              })
            );
          }

          if (session?.timeoutId) {
            clearTimeout(session.timeoutId);
          }

          ptySessionsMap.delete(ptySessionKey);
          shellProcess = null;
        });

        let welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
        if (!isPlainShell) {
          const providerName =
            provider === 'cursor'
              ? 'Cursor'
              : provider === 'codex'
                ? 'Codex'
                : provider === 'opencode'
                    ? 'OpenCode'
                  : 'Claude';
          welcomeMsg = hasSession && resumeSessionId
            ? `\x1b[36mResuming ${providerName} session ${resumeSessionId} in: ${projectPath}\x1b[0m\r\n`
            : `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
        }

        ws.send(JSON.stringify({ type: 'replay_start', mode: 'redraw' }));
        ws.send(
          JSON.stringify({
            type: 'output',
            data: welcomeMsg,
          })
        );
        return;
      }

      if (data.type === 'input') {
        if (shellProcess) {
          shellProcess.write(readString(data.data));
        }
        return;
      }

      if (data.type === 'resize') {
        if (shellProcess) {
          shellProcess.resize(readNumber(data.cols, 80), readNumber(data.rows, 24));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Shell WebSocket error:', message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'output',
            data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n`,
          })
        );
      }
    }
  });

  ws.on('close', () => {
    if (!ptySessionKey) {
      return;
    }

    const session = ptySessionsMap.get(ptySessionKey);
    if (!session || session.ws !== ws) {
      return;
    }

    session.ws = null;
    session.timeoutId = setTimeout(() => {
      if (ptySessionsMap.get(ptySessionKey as string) !== session) {
        return;
      }

      session.pty.kill();
      ptySessionsMap.delete(ptySessionKey as string);
    }, PTY_SESSION_TIMEOUT);
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}
