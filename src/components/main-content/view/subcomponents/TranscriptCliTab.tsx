/**
 * The CLI output tab of the transcript view: upgrades to an interactive
 * terminal when the pane's process generation is observable, otherwise shows
 * the read-only mirror (or its load error). Split from the former
 * `MainContent.tsx`.
 */

import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { SquareTerminal } from 'lucide-react';

import { tmuxPaneIdentityKey } from '../../../../../shared/tmux';
import type { Project } from '../../../../types/app';
import type { InteractiveShellAttachTarget } from '../../../shell/types/types';

import PendingExternalCliOutput from './PendingExternalCliOutput';

const StandaloneShell = lazy(() => import('../../../standalone-shell/view/StandaloneShell'));

type TranscriptCliTabProps = {
  transcriptCliProviderLabel: string;
  transcriptCliAttachTarget: InteractiveShellAttachTarget | null;
  externalPaneError: string;
  externalPaneOutput: string;
  selectedProject: Project;
  onBackToConversation: () => void;
};

export default function TranscriptCliTab({
  transcriptCliProviderLabel,
  transcriptCliAttachTarget,
  externalPaneError,
  externalPaneOutput,
  selectedProject,
  onBackToConversation,
}: TranscriptCliTabProps) {
  const { t } = useTranslation('chat');
  return (
    <div
      role="tabpanel"
      aria-label={`${transcriptCliProviderLabel} ${t('transcript.cliTab')}`}
      className="flex min-h-0 flex-1 flex-col"
    >
      {transcriptCliAttachTarget ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <Suspense fallback={null}>
            <StandaloneShell
              // Switching exact pane targets or process generations must remount.
              key={transcriptCliAttachTarget.targetClass === 'remote-agent'
                ? `transcript-cli-${transcriptCliAttachTarget.target.hostId}:${tmuxPaneIdentityKey(transcriptCliAttachTarget.target.tmux)}:${transcriptCliAttachTarget.target.process.startedAtMs}`
                : `transcript-cli-${tmuxPaneIdentityKey(transcriptCliAttachTarget.tmux)}:${transcriptCliAttachTarget.process.startedAtMs}`}
              project={selectedProject}
              attachTarget={transcriptCliAttachTarget}
              isActive
              minimal
              onComplete={onBackToConversation}
            />
          </Suspense>
        </div>
      ) : externalPaneError ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-950 px-6 text-center">
          <div role="alert" className="max-w-md text-sm text-zinc-300">
            <SquareTerminal className="mx-auto mb-3 h-5 w-5 text-amber-400" aria-hidden />
            {externalPaneError}
          </div>
        </div>
      ) : (
        <PendingExternalCliOutput
          providerLabel={transcriptCliProviderLabel}
          output={externalPaneOutput}
          emptyMessage={t('transcript.cliLoading')}
        />
      )}
    </div>
  );
}
