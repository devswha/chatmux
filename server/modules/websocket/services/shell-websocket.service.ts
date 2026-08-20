import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import { cursorCliCommandOrDefault } from '@/modules/providers/index.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';
export const SHELL_PROTOCOL_VERSION = 2;

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
  sessionId?: string;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string;
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
  const socket = shellQuote(tmux.socketPath);
  const attach = `tmux -S ${socket} select-window -t ${shellQuote(tmux.windowId)} \\; select-pane -t ${shellQuote(tmux.paneId)} \\; attach-session -t ${shellQuote(tmux.sessionId)}`;
  if (os.platform() === 'win32') {
    return `tmux -S ${socket} set-option -g allow-passthrough on *> $null; ${attach}`;
  }
  return `tmux -S ${socket} set-option -g allow-passthrough on >/dev/null 2>&1 || true; exec ${attach}`;
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
    code: 'SHELL_PROTOCOL_OUTDATED',
    message,
    reloadRequired: true,
  }));
  ws.close();
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

/**
 * Parses incoming websocket shell messages and keeps processing safe when
 * malformed payloads are received.
 */
function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  const payload = parseIncomingJsonObject(rawMessage);
  if (!payload) {
    return null;
  }

  return payload as ShellIncomingMessage;
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

  ws.on('message', async (rawMessage) => {
    try {
      const data = parseShellMessage(rawMessage);
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
