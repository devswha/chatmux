import type { FleetCapability, FleetPeerState } from '../../../shared/fleet';
import type { ExternalTerminalTarget } from '../../types/app';
import type { FleetHostCatalog, FleetHostEntry } from '../discovery/hostCatalog';

export type RemoteTargetState = Readonly<{
  readonly remote: boolean;
  readonly ready: boolean;
  readonly hostLabel: string | null;
  readonly state: FleetPeerState | 'stale' | 'local';
  readonly canAttach: boolean;
  readonly canInput: boolean;
  readonly canRespond: boolean;
  readonly canTerminate: boolean;
}>;

function capable(entry: FleetHostEntry, capability: FleetCapability): boolean {
  return entry.descriptor.capabilities.includes(capability);
}

function generationCurrent(entry: FleetHostEntry, target: ExternalTerminalTarget): boolean {
  const targetProcess = target.process;
  if (targetProcess === null || target.localId === undefined || target.lane === undefined) return false;
  return entry.rows.panes.some((pane) => {
    const paneProcess = pane.process;
    return pane.localId === target.localId
    && pane.lane === target.lane
    && pane.presence === 'present'
    && pane.tmux.socketPath === target.tmux.socketPath
    && pane.tmux.sessionId === target.tmux.sessionId
    && pane.tmux.windowId === target.tmux.windowId
    && pane.tmux.paneId === target.tmux.paneId
    && paneProcess !== null
    && paneProcess.pid === targetProcess.pid
    && paneProcess.startedAtMs === targetProcess.startedAtMs;
  });
}

export function remoteTargetState(
  catalog: FleetHostCatalog,
  target: ExternalTerminalTarget,
): RemoteTargetState {
  if (target.hostId === undefined) {
    return {
      remote: false, ready: true, hostLabel: null, state: 'local',
      canAttach: true, canInput: true, canRespond: true, canTerminate: true,
    };
  }
  const entry = catalog.hosts.get(target.hostId);
  const hostLabel = entry?.descriptor.displayLabel || target.hostLabel || target.hostId;
  if (entry === undefined) {
    return {
      remote: true, ready: false, hostLabel, state: 'offline',
      canAttach: false, canInput: false, canRespond: false, canTerminate: false,
    };
  }
  const available = entry.descriptor.state === 'online' && entry.sync === 'synced';
  const current = generationCurrent(entry, target);
  const state = available && !current ? 'stale' : entry.descriptor.state;
  return {
    remote: true,
    ready: available && current,
    hostLabel,
    state,
    canAttach: available && current && capable(entry, 'terminal.attach'),
    canInput: available && current && capable(entry, 'terminal.input'),
    canRespond: available && current && capable(entry, 'prompt.respond'),
    canTerminate: available && current && capable(entry, 'session.terminate'),
  };
}
