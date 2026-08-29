import pty from 'node-pty';

import {
  assertFreshExternalTmuxTarget,
  assertLineageTmuxTarget,
  type VerifiedTmuxActionTarget,
} from '@/modules/providers/index.js';

import type { FleetPaneReference } from '../../../../shared/fleet.js';
import type { TmuxPaneIdentity } from '../../../../shared/tmux.js';

import type { RemoteTerminalProcess } from './peer.js';

async function verify(target: FleetPaneReference): Promise<VerifiedTmuxActionTarget> {
  switch (target.lane) {
    case 'external': return assertFreshExternalTmuxTarget(target.tmux, target.process);
    case 'live': return assertLineageTmuxTarget(target.tmux, target.process);
    default: throw new TypeError('remote terminal lane is invalid');
  }
}

export async function verifyLocalRemoteTerminalTarget(target: FleetPaneReference): Promise<FleetPaneReference> {
  await verify(target);
  return target;
}

export function attachVerifiedLocalTmuxTerminal(verified: Readonly<{ readonly tmux: Readonly<TmuxPaneIdentity> }>, cols: number, rows: number): RemoteTerminalProcess {
  const terminal = pty.spawn('tmux', [
    '-S', verified.tmux.socketPath,
    'select-window', '-t', verified.tmux.windowId, ';',
    'select-pane', '-t', verified.tmux.paneId, ';',
    'attach-session', '-t', verified.tmux.sessionId,
  ], {
    name: 'xterm-256color', cols, rows, cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  return {
    onData: (listener) => { terminal.onData(listener); },
    onExit: (listener) => { terminal.onExit(() => listener()); },
    write: (data) => terminal.write(data), resize: (nextCols, nextRows) => terminal.resize(nextCols, nextRows),
    close: () => terminal.kill(),
  };
}

export async function spawnLocalRemoteTerminal(target: FleetPaneReference, cols: number, rows: number): Promise<RemoteTerminalProcess> {
  return attachVerifiedLocalTmuxTerminal(await verify(target), cols, rows);
}
