import { useState, type ReactNode } from 'react';
import { Ban, CircleStop, PanelTopClose, Power, XCircle } from 'lucide-react';

import type { ExternalTerminalTarget } from '../../../../types/app';
import type { RemoteTargetState } from '../../../../fleet/terminal/remoteTargetState';
import {
  requestRemotePaneAction,
  type RemotePaneAction,
} from '../../../../fleet/terminal/remoteActions';

const TERMINATION_COPY = {
  'terminate-process': 'Stop only the agent process and keep this tmux pane.',
  'terminate-pane': 'Destroy this tmux pane and every process inside it.',
  'terminate-session': 'Destroy this tmux session, all panes, and all processes inside it.',
} as const;

type TerminationAction = keyof typeof TERMINATION_COPY;
type RemoteTerminalControlsProps = Readonly<{
  readonly target: ExternalTerminalTarget;
  readonly state: RemoteTargetState;
  readonly onOutcomeUnknown: () => void;
}>;

function ActionButton({
  label, disabled, onClick, children,
}: Readonly<{
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export default function RemoteTerminalControls({
  target, state, onOutcomeUnknown,
}: RemoteTerminalControlsProps) {
  const [pending, setPending] = useState<RemotePaneAction | null>(null);
  const [confirming, setConfirming] = useState<TerminationAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const host = state.hostLabel ?? target.hostId ?? 'remote host';
  const disabled = pending !== null || !state.canInput;

  const run = async (action: RemotePaneAction): Promise<void> => {
    setPending(action);
    setError(null);
    try {
      const result = await requestRemotePaneAction(target, action);
      if (!result.ok) {
        setError(result.message);
        if (result.code === 'HOST_COMMAND_OUTCOME_UNKNOWN') onOutcomeUnknown();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Remote action failed.');
    } finally {
      setPending(null);
      setConfirming(null);
    }
  };

  if (confirming !== null) {
    return (
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-1 text-xs" role="alert">
        <span className="max-w-72 text-muted-foreground">{TERMINATION_COPY[confirming]}</span>
        <button
          type="button"
          disabled={!state.canTerminate || pending !== null}
          onClick={() => void run(confirming)}
          className="rounded-md bg-destructive px-2 py-1 font-medium text-destructive-foreground hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          Confirm for {host}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(null)}
          className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0.5" aria-label={`Remote terminal actions for ${host}`}>
      <ActionButton label={`Interrupt process on ${host}`} disabled={disabled} onClick={() => void run('interrupt')}>
        <CircleStop className="h-4 w-4" aria-hidden />
      </ActionButton>
      <ActionButton label={`Send Escape to ${host}`} disabled={disabled} onClick={() => void run('escape')}>
        <Ban className="h-4 w-4" aria-hidden />
      </ActionButton>
      <ActionButton label={`Stop agent process on ${host}`} disabled={!state.canTerminate || pending !== null} onClick={() => setConfirming('terminate-process')}>
        <Power className="h-4 w-4" aria-hidden />
      </ActionButton>
      <ActionButton label={`Kill tmux pane on ${host}`} disabled={!state.canTerminate || pending !== null} onClick={() => setConfirming('terminate-pane')}>
        <PanelTopClose className="h-4 w-4" aria-hidden />
      </ActionButton>
      <ActionButton label={`Kill tmux session on ${host}`} disabled={!state.canTerminate || pending !== null} onClick={() => setConfirming('terminate-session')}>
        <XCircle className="h-4 w-4" aria-hidden />
      </ActionButton>
      {error && <span className="max-w-48 truncate text-xs text-destructive" role="alert" title={error}>{error}</span>}
    </div>
  );
}
