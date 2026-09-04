import pty from 'node-pty';

import {
  assertFreshExternalTmuxTarget,
  assertLineageTmuxTarget,
  type VerifiedTmuxActionTarget,
} from '@/modules/providers/index.js';

import type { FleetPaneReference } from '../../../../shared/fleet.js';
import type { TmuxPaneIdentity } from '../../../../shared/tmux.js';

import { RemoteTerminalPeerError, type RemoteTerminalProcess } from './peer.js';

export type LocalTerminalVerifiers = Readonly<{
  readonly external?: typeof assertFreshExternalTmuxTarget;
  readonly live?: typeof assertLineageTmuxTarget;
}>;

/**
 * Attach plus input is a raw keyboard, so the same `company*` protection that
 * local attach and fleet mutations enforce applies here; otherwise a hub could
 * Ctrl-C a protected agent the interrupt path refuses to touch.
 */
export function assertNotProtectedTerminalTarget(target: VerifiedTmuxActionTarget): VerifiedTmuxActionTarget {
  if ((target.tmuxName ?? '').toLowerCase().startsWith('company')) {
    throw new RemoteTerminalPeerError('FLEET_UNAUTHORIZED', 'tmux target is protected');
  }
  return target;
}

async function verify(target: FleetPaneReference, verifiers: LocalTerminalVerifiers = {}): Promise<VerifiedTmuxActionTarget> {
  switch (target.lane) {
    case 'external': return assertNotProtectedTerminalTarget(await (verifiers.external ?? assertFreshExternalTmuxTarget)(target.tmux, target.process));
    case 'live': return assertNotProtectedTerminalTarget(await (verifiers.live ?? assertLineageTmuxTarget)(target.tmux, target.process));
    default: throw new TypeError('remote terminal lane is invalid');
  }
}

export async function verifyLocalRemoteTerminalTarget(target: FleetPaneReference, verifiers: LocalTerminalVerifiers = {}): Promise<FleetPaneReference> {
  await verify(target, verifiers);
  return target;
}

export function attachVerifiedLocalTmuxTerminal(verified: Readonly<{ readonly tmux: Readonly<TmuxPaneIdentity> }>, cols: number, rows: number): RemoteTerminalProcess {
  const environment: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete environment.TMUX;
  delete environment.TMUX_PANE;
  const terminal = pty.spawn('tmux', [
    '-S', verified.tmux.socketPath,
    'select-window', '-t', verified.tmux.windowId, ';',
    'select-pane', '-t', verified.tmux.paneId, ';',
    'attach-session', '-t', verified.tmux.sessionId,
  ], {
    name: 'xterm-256color', cols, rows, cwd: process.cwd(),
    env: environment,
  });
  return {
    onData: (listener) => { terminal.onData(listener); },
    onExit: (listener) => { terminal.onExit(() => listener()); },
    write: (data) => terminal.write(data), resize: (nextCols, nextRows) => terminal.resize(nextCols, nextRows),
    close: () => terminal.kill(),
  };
}

export async function spawnLocalRemoteTerminal(target: FleetPaneReference, cols: number, rows: number, verifiers: LocalTerminalVerifiers = {}): Promise<RemoteTerminalProcess> {
  return attachVerifiedLocalTmuxTerminal(await verify(target, verifiers), cols, rows);
}
