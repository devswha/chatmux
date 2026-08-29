/**
 * Terminal-only takeover surface for an external target without a locally
 * observable process: attaches the interactive shell when the target carries a
 * usable identity, otherwise explains why no attach is possible. Split from
 * the former `MainContent.tsx`.
 */

import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, SquareTerminal, X } from 'lucide-react';

import { tmuxPaneIdentityKey } from '../../../../../shared/tmux';
import { useFleetHostCatalog } from '../../../../fleet/discovery/FleetHostCatalogContext';
import { remoteTargetState } from '../../../../fleet/terminal/remoteTargetState';
import type { ExternalTerminalTarget } from '../../../../types/app';
import { buildExternalAttachTarget } from '../externalAttachTargets';

import RemoteTerminalControls from './RemoteTerminalControls';

const StandaloneShell = lazy(() => import('../../../standalone-shell/view/StandaloneShell'));

type ExternalTerminalShellViewProps = {
  externalTerminal: ExternalTerminalTarget;
  isMobile: boolean;
  onMenuClick: () => void;
  onExternalTerminalClose: () => void;
};

export default function ExternalTerminalShellView({
  externalTerminal,
  isMobile,
  onMenuClick,
  onExternalTerminalClose,
}: ExternalTerminalShellViewProps) {
  const { t } = useTranslation('chat');
  const { catalog } = useFleetHostCatalog();
  const targetState = remoteTargetState(catalog, externalTerminal);
  const targetKey = tmuxPaneIdentityKey(externalTerminal.tmux);
  const attachTarget = targetState.remote && !targetState.canAttach
    ? null
    : buildExternalAttachTarget(externalTerminal);
  const generation = externalTerminal.process
    ? `PID ${externalTerminal.process.pid} · ${externalTerminal.process.startedAtMs}`
    : null;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {isMobile && (
            <button
              type="button"
              onClick={onMenuClick}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              aria-label="Open sidebar"
            >
              <Menu className="h-4 w-4" />
            </button>
          )}
          <SquareTerminal className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
          <span className="truncate text-sm font-semibold text-foreground">tmux: {externalTerminal.tmuxName}</span>
          {targetState.remote ? (
            <span className="hidden min-w-0 text-[11px] leading-tight text-muted-foreground sm:flex sm:flex-row sm:items-center sm:gap-1.5">
              <span className="truncate">{targetState.hostLabel}</span>
              {generation && <span className="truncate">{generation}</span>}
              <span className="capitalize">{targetState.state}</span>
            </span>
          ) : (
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
              {t('transcript.detachHint', { kind: externalTerminal.kind })}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {targetState.remote && (
            <RemoteTerminalControls
              target={externalTerminal}
              state={targetState}
              onOutcomeUnknown={onExternalTerminalClose}
            />
          )}
        <button
          type="button"
          onClick={onExternalTerminalClose}
          title={t('transcript.closeTerminal')}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
        </div>
      </div>
      {targetState.remote && (
        <div className="flex flex-wrap items-center gap-x-2 border-b border-border/40 px-3 py-1 text-[11px] text-muted-foreground sm:hidden">
          <span>{targetState.hostLabel}</span>
          {generation && <span>{generation}</span>}
          <span className="capitalize">{targetState.state}</span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {attachTarget ? (
          <Suspense fallback={null}>
            <StandaloneShell
              // Switching exact pane targets must remount the Shell.
              key={targetKey}
              project={externalTerminal.project}
              projectPath={'projectPath' in externalTerminal ? externalTerminal.projectPath : undefined}
              attachTarget={attachTarget}
              isActive
              minimal
              onComplete={() => onExternalTerminalClose()}
            />
          </Suspense>
        ) : (
          <div role="alert" className="m-3 rounded-md border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
            {targetState.remote
              ? `Remote terminal unavailable: ${targetState.state}. Reopen it after the host is online and synchronized.`
              : t('shell.attachCapabilityUnavailable')}
          </div>
        )}
      </div>
    </div>
  );
}
