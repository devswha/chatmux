import { isAbsolute } from 'node:path';

import { AppError } from '@/shared/utils.js';

import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../shared/tmux.js';

import { runTmux, type TmuxRunner } from './builtin-relay.service.js';

const SESSION_ID_RE = /^\$\d+$/;
const WINDOW_ID_RE = /^@\d+$/;
const PANE_ID_RE = /^%\d+$/;
let pasteBufferSequence = 0;

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

export async function sendToTmuxPane(
  identity: TmuxPaneIdentity,
  message: string,
  run: TmuxRunner = runTmux,
): Promise<void> {
  const bufferName = `chatmux-pane-${process.pid}-${++pasteBufferSequence}`;
  const load = await run(['-S', identity.socketPath, 'load-buffer', '-b', bufferName, '-'], message);
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
  await requireTmuxSuccess(identity, ['send-keys', '-t', identity.paneId, 'Enter'], run);
}

export async function captureTmuxPane(
  identity: TmuxPaneIdentity,
  run: TmuxRunner = runTmux,
): Promise<string> {
  const result = await run([
    '-S', identity.socketPath,
    'capture-pane', '-p', '-e', '-S', '-80', '-t', identity.paneId,
  ]);
  if (result.code !== 0) {
    throw new AppError('The selected tmux pane changed; reopen it from the session list.', {
      code: 'TMUX_PANE_GENERATION_MISMATCH',
      statusCode: 409,
    });
  }
  return result.output;
}

export async function killTmuxPane(
  identity: TmuxPaneIdentity,
  run: TmuxRunner = runTmux,
): Promise<void> {
  await requireTmuxSuccess(identity, ['kill-pane', '-t', identity.paneId], run);
}

export async function killTmuxSession(
  identity: TmuxPaneIdentity,
  run: TmuxRunner = runTmux,
): Promise<void> {
  await requireTmuxSuccess(identity, ['kill-session', '-t', identity.sessionId], run);
}

export async function stopAgentProcessInPane(
  identity: TmuxPaneIdentity,
  run: TmuxRunner = runTmux,
  shell = process.env.SHELL && isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/sh',
): Promise<void> {
  const inspected = await run([
    '-S', identity.socketPath,
    'display-message', '-p', '-t', identity.paneId,
    '#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_current_path}',
  ]);
  const [sessionId, windowId, paneId, cwd] = inspected.output.trim().split('\t');
  if (
    inspected.code !== 0
    || sessionId !== identity.sessionId
    || windowId !== identity.windowId
    || paneId !== identity.paneId
    || !cwd
    || !isAbsolute(cwd)
  ) {
    throw new AppError('The selected tmux pane changed; reopen it from the session list.', {
      code: 'TMUX_PANE_GENERATION_MISMATCH',
      statusCode: 409,
    });
  }
  await requireTmuxSuccess(identity, [
    'respawn-pane', '-k', '-t', identity.paneId, '-c', cwd, shell,
  ], run);
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
