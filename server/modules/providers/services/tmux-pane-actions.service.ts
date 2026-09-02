import { isAbsolute } from 'node:path';

import { AppError } from '@/shared/utils.js';

import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../shared/tmux.js';

import { runTmux, type TmuxRunner } from './builtin-relay.service.js';
import { processStartMs } from './process-start-time.service.js';
import type { VerifiedTmuxActionTarget } from './tmux-fresh-verifier.service.js';

const SESSION_ID_RE = /^\$\d+$/;
const WINDOW_ID_RE = /^@\d+$/;
const PANE_ID_RE = /^%\d+$/;
let pasteBufferSequence = 0;
export type TmuxProcessAction = 'interrupt' | 'escape';
export type TmuxSelectionKey =
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right'
  | 'Enter'
  | 'Space'
  | 'Tab'
  | 'BTab'
  | 'Escape';

function tmuxProcessActionKey(
  target: VerifiedTmuxActionTarget,
  action: TmuxProcessAction,
): 'C-c' | 'Escape' {
  if (action === 'escape') return 'Escape';
  // Codex handles Esc as "interrupt the active turn". Ctrl+C is a process
  // signal and can terminate the CLI when its activity status is briefly stale.
  return target.kind === 'codex' ? 'Escape' : 'C-c';
}

export function readTmuxPaneIdentity(value: unknown): TmuxPaneIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('tmux pane identity is required.', {
      code: 'TMUX_PANE_IDENTITY_REQUIRED',
      statusCode: 400,
    });
  }
  const candidate = value as Partial<Record<keyof TmuxPaneIdentity, unknown>>;
  if (
    typeof candidate.socketPath !== 'string'
    || !isAbsolute(candidate.socketPath)
    || candidate.socketPath.includes('\0')
    || candidate.socketPath.length > 4096
    || typeof candidate.sessionId !== 'string'
    || !SESSION_ID_RE.test(candidate.sessionId)
    || typeof candidate.windowId !== 'string'
    || !WINDOW_ID_RE.test(candidate.windowId)
    || typeof candidate.paneId !== 'string'
    || !PANE_ID_RE.test(candidate.paneId)
  ) {
    throw new AppError('invalid tmux pane identity.', {
      code: 'INVALID_TMUX_PANE_IDENTITY',
      statusCode: 400,
    });
  }
  return {
    socketPath: candidate.socketPath,
    sessionId: candidate.sessionId,
    windowId: candidate.windowId,
    paneId: candidate.paneId,
  };
}

export function readTmuxProcessGeneration(value: unknown): TmuxProcessGeneration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('agent process generation is required.', {
      code: 'TMUX_PROCESS_GENERATION_REQUIRED',
      statusCode: 400,
    });
  }
  const candidate = value as { pid?: unknown; startedAtMs?: unknown };
  if (
    typeof candidate.pid !== 'number'
    || !Number.isSafeInteger(candidate.pid)
    || candidate.pid <= 1
    || typeof candidate.startedAtMs !== 'number'
    || !Number.isFinite(candidate.startedAtMs)
    || candidate.startedAtMs <= 0
  ) {
    throw new AppError('invalid agent process generation.', {
      code: 'INVALID_TMUX_PROCESS_GENERATION',
      statusCode: 400,
    });
  }
  return { pid: candidate.pid, startedAtMs: candidate.startedAtMs };
}

export function sameTmuxPaneIdentity(a: TmuxPaneIdentity, b: TmuxPaneIdentity): boolean {
  return a.socketPath === b.socketPath
    && a.sessionId === b.sessionId
    && a.windowId === b.windowId
    && a.paneId === b.paneId;
}

async function requireTmuxSuccess(
  identity: TmuxPaneIdentity,
  args: string[],
  run: TmuxRunner,
): Promise<void> {
  const result = await run(['-S', identity.socketPath, ...args]);
  if (result.code !== 0) {
    throw new AppError('The selected tmux pane changed; reopen it from the session list.', {
      code: 'TMUX_PANE_GENERATION_MISMATCH',
      statusCode: 409,
      details: result.output.slice(0, 500),
    });
  }
}

export async function assertTmuxPaneIdentity(
  identity: TmuxPaneIdentity,
  run: TmuxRunner = runTmux,
): Promise<void> {
  const result = await run([
    '-S', identity.socketPath,
    'display-message', '-p', '-t', identity.paneId,
    '#{session_id}\t#{window_id}\t#{pane_id}',
  ]);
  const expected = `${identity.sessionId}\t${identity.windowId}\t${identity.paneId}`;
  if (result.code !== 0 || result.output.trim() !== expected) {
    throw new AppError('The selected tmux pane changed; reopen it from the session list.', {
      code: 'TMUX_PANE_GENERATION_MISMATCH',
      statusCode: 409,
    });
  }
}

/**
 * Text pasted into a pane travels inside a bracketed paste (`paste-buffer -p`),
 * which the application reads as literal input only until it sees the end
 * marker ESC [ 201 ~. A message carrying that sequence would end the paste
 * early and turn the remainder into key input. No chat message needs terminal
 * control characters, so every C0 control except tab and newline, DEL, and the
 * C1 range (0x9B is an 8-bit CSI) are removed; CR and CRLF become LF.
 */
export function sanitizeTmuxPasteText(message: string): string {
  return message
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g, '');
}

export async function pasteToTmuxPane(
  target: VerifiedTmuxActionTarget,
  message: string,
  run: TmuxRunner = runTmux,
): Promise<void> {
  const text = sanitizeTmuxPasteText(message);
  if (!text.trim()) {
    throw new AppError('message is required.', { code: 'EMPTY_MESSAGE', statusCode: 400 });
  }
  const identity = target.tmux;
  const bufferName = `chatmux-pane-${process.pid}-${++pasteBufferSequence}`;
  // Recheck before the first write so a stale pane receives no bytes. tmux cannot
  // make load/paste/Enter atomic, so replacement after this point is accepted TOCTOU.
  await assertTmuxPaneIdentity(identity, run);
  const load = await run(['-S', identity.socketPath, 'load-buffer', '-b', bufferName, '-'], text);
  if (load.code !== 0) {
    throw new AppError('tmux could not stage the message.', {
      code: 'TMUX_PANE_SEND_FAILED',
      statusCode: 409,
      details: load.output.slice(0, 500),
    });
  }
  await requireTmuxSuccess(identity, [
    'paste-buffer', '-d', '-p', '-b', bufferName, '-t', identity.paneId,
  ], run);
}

export async function sendToTmuxPane(
  target: VerifiedTmuxActionTarget,
  message: string,
  run: TmuxRunner = runTmux,
): Promise<void> {
  await pasteToTmuxPane(target, message, run);
  const identity = target.tmux;
  await requireTmuxSuccess(identity, ['send-keys', '-t', identity.paneId, 'Enter'], run);
}
/**
 * Sends only a typed process action. The caller never supplies a tmux key token.
 * Rechecking the pane coordinate immediately before send-keys rejects replacement
 * panes before any key bytes reach them.
 */
export async function sendTmuxProcessAction(
  target: VerifiedTmuxActionTarget,
  action: TmuxProcessAction,
  run: TmuxRunner = runTmux,
): Promise<void> {
  const identity = target.tmux;
  await assertTmuxPaneIdentity(identity, run);
  await requireTmuxSuccess(identity, [
    'send-keys', '-t', identity.paneId, tmuxProcessActionKey(target, action),
  ], run);
}

/**
 * Sends an internally constructed, allowlisted selector key sequence.
 * User input is converted to these tokens by the ask service and can never
 * become an arbitrary tmux key name.
 */
export async function sendTmuxSelectionKeys(
  target: VerifiedTmuxActionTarget,
  keys: readonly TmuxSelectionKey[],
  run: TmuxRunner = runTmux,
  delay: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  if (keys.length === 0 || keys.length > 160) {
    throw new AppError('invalid selector key sequence.', {
      code: 'INVALID_TMUX_SELECTION',
      statusCode: 400,
    });
  }
  const identity = target.tmux;
  await assertTmuxPaneIdentity(identity, run);
  for (let index = 0; index < keys.length; index += 1) {
    await requireTmuxSuccess(identity, [
      'send-keys', '-t', identity.paneId, keys[index],
    ], run);
    if (index < keys.length - 1) {
      // OMP can drop adjacent cursor events delivered in a single UI frame.
      await delay(60);
    }
  }
}

export async function captureTmuxPane(
  target: VerifiedTmuxActionTarget,
  run: TmuxRunner = runTmux,
): Promise<string> {
  const identity = target.tmux;
  const result = await run([
    '-S', identity.socketPath,
    'capture-pane', '-p', '-e', '-N', '-S', '-80', '-t', identity.paneId,
  ]);
  if (result.code !== 0) {
    throw new AppError('The selected tmux pane changed; reopen it from the session list.', {
      code: 'TMUX_PANE_GENERATION_MISMATCH',
      statusCode: 409,
    });
  }
  return result.output;
}

/**
 * Pane ids never repeat within a tmux server, so `%N` cannot name a different
 * pane later; it can only have moved (join-pane, break-pane) out of the
 * verified window or session. Recheck all four coordinates right before the
 * kill, as the send path does, so a moved pane is refused rather than killed.
 */
export async function killTmuxPane(
  target: VerifiedTmuxActionTarget,
  run: TmuxRunner = runTmux,
): Promise<void> {
  const identity = target.tmux;
  await assertTmuxPaneIdentity(identity, run);
  await requireTmuxSuccess(identity, ['kill-pane', '-t', identity.paneId], run);
}

export type KillTmuxSessionOptions = Readonly<{
  /** The caller has shown the user the other panes and they chose to close them too. */
  readonly allowOtherPanes?: boolean;
}>;

/**
 * Ends the whole tmux session that hosts the verified pane. Only that one pane
 * was verified, so when the session holds other panes (other agents, editors,
 * shells) the caller must have confirmed the wider blast radius explicitly.
 */
export async function killTmuxSession(
  target: VerifiedTmuxActionTarget,
  run: TmuxRunner = runTmux,
  options: KillTmuxSessionOptions = {},
): Promise<void> {
  const identity = target.tmux;
  // The verified pane must still live in this session before the session dies.
  await assertTmuxPaneIdentity(identity, run);
  const listed = await run(['-S', identity.socketPath, 'list-panes', '-s', '-t', identity.sessionId, '-F', '#{pane_id}']);
  if (listed.code !== 0) {
    throw new AppError('The selected tmux pane changed; reopen it from the session list.', {
      code: 'TMUX_PANE_GENERATION_MISMATCH',
      statusCode: 409,
      details: listed.output.slice(0, 500),
    });
  }
  const otherPanes = listed.output.split('\n').map((line) => line.trim()).filter((line) => line && line !== identity.paneId);
  if (otherPanes.length > 0 && options.allowOtherPanes !== true) {
    throw new AppError(`The tmux session holds ${otherPanes.length} other pane(s). Confirm closing them too, or terminate only this pane.`, {
      code: 'TMUX_SESSION_HAS_OTHER_PANES',
      statusCode: 409,
      details: { otherPanes: otherPanes.length },
    });
  }
  await requireTmuxSuccess(identity, ['kill-session', '-t', identity.sessionId], run);
}

export type StopAgentProcessDeps = Readonly<{
  /** Sends a signal to a pid; defaults to process.kill. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Reads a pid's start time; defaults to the /proc-backed processStartMs. */
  readonly startedAtMs?: (pid: number) => Promise<number | null>;
  readonly sleep?: (ms: number) => Promise<void>;
}>;

const STOP_TERM_GRACE_MS = 3_000;
const STOP_KILL_GRACE_MS = 2_000;
const STOP_POLL_MS = 100;

/**
 * Stops the verified agent process and confirms that it is gone.
 *
 * When the agent is a child of the pane's shell it is signalled directly
 * (SIGTERM, then SIGKILL) and its exit is confirmed against the verified
 * start time, so the user's shell, history, and virtualenv survive. Only when
 * the agent *is* the pane's root process, where its exit would close the
 * pane, is the pane respawned with a shell as before. A pid whose start time
 * no longer matches the verified generation is never signalled.
 */
export async function stopAgentProcessInPane(
  target: VerifiedTmuxActionTarget,
  run: TmuxRunner = runTmux,
  shell = process.env.SHELL && isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/sh',
  deps: StopAgentProcessDeps = {},
): Promise<void> {
  const identity = target.tmux;
  const inspected = await run([
    '-S', identity.socketPath,
    'display-message', '-p', '-t', identity.paneId,
    '#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_current_path}\t#{pane_pid}',
  ]);
  const [sessionId, windowId, paneId, cwd, panePidText] = inspected.output.trim().split('\t');
  const panePid = Number(panePidText);
  if (
    inspected.code !== 0
    || sessionId !== identity.sessionId
    || windowId !== identity.windowId
    || paneId !== identity.paneId
    || !cwd
    || !isAbsolute(cwd)
    || !Number.isSafeInteger(panePid)
    || panePid <= 1
  ) {
    throw new AppError('The selected tmux pane changed; reopen it from the session list.', {
      code: 'TMUX_PANE_GENERATION_MISMATCH',
      statusCode: 409,
    });
  }

  if (panePid === target.process.pid) {
    await requireTmuxSuccess(identity, [
      'respawn-pane', '-k', '-t', identity.paneId, '-c', cwd, shell,
    ], run);
  } else {
    await signalVerifiedProcess(target.process, deps);
  }

  for (const option of [
    '@chatmux_cli_kind',
    '@chatmux_provider_session_id',
    '@chatmux_codex_thread_id',
  ]) {
    await requireTmuxSuccess(identity, [
      'set-option', '-p', '-t', identity.paneId, option, '',
    ], run);
  }
}

async function signalVerifiedProcess(
  generation: Readonly<TmuxProcessGeneration>,
  deps: StopAgentProcessDeps,
): Promise<void> {
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const startedAtMs = deps.startedAtMs ?? processStartMs;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stillVerified = async (): Promise<boolean> => (await startedAtMs(generation.pid)) === generation.startedAtMs;
  const waitForExit = async (graceMs: number): Promise<boolean> => {
    for (let waited = 0; waited < graceMs; waited += STOP_POLL_MS) {
      await sleep(STOP_POLL_MS);
      if (!await stillVerified()) return true;
    }
    return !await stillVerified();
  };

  if (!await stillVerified()) {
    throw new AppError('The tmux pane now belongs to a different agent process. Reopen it from the session list.', {
      code: 'TMUX_PROCESS_GENERATION_MISMATCH',
      statusCode: 409,
    });
  }
  const signal = (name: NodeJS.Signals): void => {
    try { kill(generation.pid, name); } catch (error) {
      // ESRCH means it exited between the check and the signal; anything else is a real refusal.
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  };
  signal('SIGTERM');
  if (await waitForExit(STOP_TERM_GRACE_MS)) return;
  signal('SIGKILL');
  if (await waitForExit(STOP_KILL_GRACE_MS)) return;
  throw new AppError('The agent process ignored SIGTERM and SIGKILL; terminate the pane instead.', {
    code: 'AGENT_PROCESS_STILL_RUNNING',
    statusCode: 409,
  });
}
