/**
 * Surface for a fresh local pane whose provider has not created its first
 * transcript record yet: an empty conversation surface with the relay
 * composer, and the raw tmux output behind the explicit CLI output tab.
 * Split from the former `MainContent.tsx`.
 */

import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, MessageSquare, X } from 'lucide-react';

import { tmuxPaneIdentityKey } from '../../../../../shared/tmux';
import { useFleetHostCatalog } from '../../../../fleet/discovery/FleetHostCatalogContext';
import { remoteTargetState } from '../../../../fleet/terminal/remoteTargetState';
import type { ExternalTerminalTarget } from '../../../../types/app';
import LiveRelayComposer from '../../../chat/view/subcomponents/LiveRelayComposer';
import { buildTranscriptCliAttachTarget, pendingRelayCliKind } from '../externalAttachTargets';

import PendingExternalCliOutput from './PendingExternalCliOutput';
import ExternalTranscriptViewSwitcher, {
  type ExternalTranscriptView,
} from './ExternalTranscriptViewSwitcher';

const StandaloneShell = lazy(() => import('../../../standalone-shell/view/StandaloneShell'));

type PendingRelayViewProps = {
  /** MainContent only routes non-SSH/shell targets here. */
  externalTerminal: ExternalTerminalTarget;
  externalTranscriptView: ExternalTranscriptView;
  setExternalTranscriptView: (view: ExternalTranscriptView) => void;
  externalPaneOutput: string;
  isMobile: boolean;
  onMenuClick: () => void;
  onExternalTerminalClose: () => void;
};

const PROVIDER_LABELS = {
  gjc: 'GJC',
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  omp: 'Oh My Pi',
  omo: 'Oh My OpenAgent',
} as const;

export default function PendingRelayView({
  externalTerminal,
  externalTranscriptView,
  setExternalTranscriptView,
  externalPaneOutput,
  isMobile,
  onMenuClick,
  onExternalTerminalClose,
}: PendingRelayViewProps) {
  const { t } = useTranslation('chat');
  const { catalog } = useFleetHostCatalog();
  const targetState = remoteTargetState(catalog, externalTerminal);
  const relayKind = pendingRelayCliKind(externalTerminal.cliKind);
  if (relayKind === null) {
    // Unreachable through MainContent's guard; keeps the type honest.
    return null;
  }
  const process = externalTerminal.process;
  if (process === null) return null;
  const isGjc = externalTerminal.cliKind === 'gjc';
  const providerLabel = PROVIDER_LABELS[relayKind];
  const pendingCliAttachTarget = buildTranscriptCliAttachTarget(externalTerminal);
  const currentCliAttachTarget = targetState.remote && !targetState.ready
    ? null
    : pendingCliAttachTarget;
  const host = targetState.hostLabel ?? externalTerminal.hostId;
  return (
    <fieldset
      disabled={targetState.remote && !targetState.ready}
      className="m-0 flex h-full min-h-0 min-w-0 flex-col border-0 p-0"
    >
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
          <MessageSquare className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
          <span className="truncate text-sm font-semibold text-foreground">{externalTerminal.tmuxName}</span>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {t('transcript.pendingTitle', { provider: providerLabel })}
          </span>
        </div>
        <button
          type="button"
          onClick={onExternalTerminalClose}
          title={t('transcript.closeView', { provider: providerLabel })}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {targetState.remote && (
        <div
          role={targetState.ready ? 'status' : 'alert'}
          className="flex flex-wrap items-center gap-x-2 border-b border-border/40 px-3 py-1 text-[11px] text-muted-foreground"
        >
          <span>{host}</span>
          <span>PID {process.pid} · {process.startedAtMs}</span>
          <span className="capitalize">{targetState.state}</span>
          {!targetState.ready && <span>Pending relay controls are unavailable until this host is online and synchronized.</span>}
        </div>
      )}
      <ExternalTranscriptViewSwitcher
        mode={externalTranscriptView}
        providerLabel={providerLabel}
        tmuxName={externalTerminal.tmuxName}
        onChange={setExternalTranscriptView}
      />
      {externalTranscriptView === 'cli' ? (
        currentCliAttachTarget ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <Suspense fallback={null}>
              <StandaloneShell
                // Switching exact pane targets or process generations must remount.
                key={currentCliAttachTarget.targetClass === 'remote-agent'
                  ? `pending-cli-${currentCliAttachTarget.target.hostId}:${tmuxPaneIdentityKey(currentCliAttachTarget.target.tmux)}:${currentCliAttachTarget.target.process.startedAtMs}`
                  : `pending-cli-${tmuxPaneIdentityKey(currentCliAttachTarget.tmux)}:${currentCliAttachTarget.process.startedAtMs}`}
                project={externalTerminal.project}
                projectPath={'projectPath' in externalTerminal ? externalTerminal.projectPath : undefined}
                attachTarget={currentCliAttachTarget}
                isActive
                minimal
              />
            </Suspense>
          </div>
        ) : (
          <PendingExternalCliOutput providerLabel={providerLabel} output={externalPaneOutput} />
        )
      ) : (
        <PendingExternalCliOutput
          providerLabel={providerLabel}
          output=""
          emptyMessage={t('transcript.noConversationYet', { provider: providerLabel })}
        />
      )}
      {externalTranscriptView === 'conversation' && (
        <LiveRelayComposer
          key={`pending-${externalTerminal.cliKind}:${tmuxPaneIdentityKey(externalTerminal.tmux)}:${process.startedAtMs}`}
          target={{
            tmux: externalTerminal.tmux,
            process,
            ...(externalTerminal.hostId === undefined ? {} : { hostId: externalTerminal.hostId }),
            ...(externalTerminal.localId === undefined ? {} : { localId: externalTerminal.localId }),
            ...(externalTerminal.lane === undefined ? {} : { lane: externalTerminal.lane }),
          }}
          model={'model' in externalTerminal ? externalTerminal.model : null}
          effort={'effort' in externalTerminal ? externalTerminal.effort : null}
          sessionName={externalTerminal.tmuxName}
          workspacePath={isGjc
            ? null
            : (externalTerminal.project?.fullPath
              || externalTerminal.project?.path
              || externalTerminal.projectPath
              || '')}
          relayKind={relayKind}
        />
      )}
    </fieldset>
  );
}
