/**
 * Attach-target builders and pane-stream frame parsing for the main content
 * surface. The builders are the only path to an attach target: attach-only
 * rows must carry a server-issued capability, and the absence of one yields
 * no target at all. Split from the former `MainContent.tsx` — the names stay
 * importable from there (facade re-export).
 */

import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../shared/tmux';
import type { ExternalTerminalTarget } from '../../../types/app';
import type { InteractiveShellAttachTarget, ShellAttachTarget } from '../../shell/types/types';


export function paneStreamFrame(
  event: { kind?: unknown; key?: unknown; subscriptionId?: unknown; output?: unknown },
  targetKey: string,
  subscriptionId: string | null,
): { subscriptionId: string; output?: string; invalidated: boolean } | null {
  if (event.kind === 'pane.attached') {
    if (event.key !== targetKey || typeof event.subscriptionId !== 'string') return null;
    return {
      subscriptionId: event.subscriptionId,
      ...(typeof event.output === 'string' ? { output: event.output } : {}),
      invalidated: false,
    };
  }
  if ((event.kind !== 'pane.output' && event.kind !== 'pane.invalidated') || event.subscriptionId !== subscriptionId || subscriptionId === null) return null;
  return {
    subscriptionId,
    ...(typeof event.output === 'string' ? { output: event.output } : {}),
    invalidated: event.kind === 'pane.invalidated',
  };
}
export function paneStreamFallbackNeeded(isConnected: boolean, streamSubscribed: boolean): boolean {
  return !isConnected || !streamSubscribed;
}
export function shouldShowPendingRelay(externalTerminal: ExternalTerminalTarget | null): boolean {
  // B8: a forced attach (from the asking_user badge) always skips the
  // pending relay surface and goes straight to terminal attach below, even
  // for a session whose process is still observable.
  return Boolean(
    externalTerminal
    && externalTerminal.cliKind !== 'ssh'
    && externalTerminal.cliKind !== 'shell'
    && externalTerminal.process
    && !externalTerminal.forceAttach,
  );
}
export function buildExternalAttachTarget(externalTerminal: ExternalTerminalTarget): ShellAttachTarget | null {
  if (
    externalTerminal.hostId
    && externalTerminal.localId
    && externalTerminal.lane
    && externalTerminal.process
  ) {
    return {
      targetClass: 'remote-agent',
      target: {
        kind: 'pane',
        hostId: externalTerminal.hostId,
        localId: externalTerminal.localId,
        lane: externalTerminal.lane,
        tmux: externalTerminal.tmux,
        process: externalTerminal.process,
      },
    };
  }
  const isAttachOnly = externalTerminal.cliKind === 'ssh'
    || externalTerminal.cliKind === 'shell'
    || !externalTerminal.process;
  const attachCapability = 'attachCapability' in externalTerminal
    ? externalTerminal.attachCapability
    : undefined;
  if (isAttachOnly) {
    return typeof attachCapability === 'string' && attachCapability
      ? { targetClass: 'attach-only', tmux: externalTerminal.tmux, capability: attachCapability }
      : null;
  }
  return { targetClass: 'local-agent', tmux: externalTerminal.tmux, process: externalTerminal.process! };
}

/**
 * The CLI output tab upgrades from a read-only pane mirror to a fully
 * interactive terminal whenever the pane's process generation is observable:
 * the same exact-4-tuple typed-attach protocol as the terminal route, so all
 * server-side identity checks apply unchanged. Without a process identity the
 * tab stays read-only (never attach by tmux name alone).
 */
export function buildTranscriptCliAttachTarget(
  target: {
    tmux: TmuxPaneIdentity;
    process?: TmuxProcessGeneration | null;
    hostId?: string;
    localId?: string;
    lane?: 'external' | 'live';
  } | null | undefined,
): InteractiveShellAttachTarget | null {
  if (!target?.process) {
    return null;
  }
  if (target.hostId && target.localId && target.lane) {
    return {
      targetClass: 'remote-agent',
      target: {
        kind: 'pane', hostId: target.hostId, localId: target.localId,
        lane: target.lane, tmux: target.tmux, process: target.process,
      },
    };
  }
  return { targetClass: 'local-agent', tmux: target.tmux, process: target.process };
}

export type PendingRelayCliKind = 'claude' | 'cursor' | 'codex' | 'opencode' | 'gjc' | 'omp' | 'omo';

/** CLI kinds that can own a pending relay: SSH and shell panes are attach-only. */
export function pendingRelayCliKind(
  cliKind: ExternalTerminalTarget['cliKind'],
): PendingRelayCliKind | null {
  return cliKind === 'ssh' || cliKind === 'shell' ? null : cliKind;
}
