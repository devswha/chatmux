/**
 * Transcript/CLI tab target derivation for the main content surface: which pane
 * the transcript view is bound to, whether it can upgrade to an interactive
 * terminal, and the read-only mirror target when it cannot. Split from the
 * former `MainContent.tsx`.
 */

import { useEffect, useMemo, useState } from 'react';

import { tmuxPaneIdentityKey, type TmuxPaneIdentity, type TmuxProcessGeneration } from '../../../../shared/tmux';
import type { ExternalTerminalTarget } from '../../../types/app';
import type { MainContentProps } from '../types/types';
import { buildTranscriptCliAttachTarget } from '../view/externalAttachTargets';
import type { ExternalTranscriptView } from '../view/subcomponents/ExternalTranscriptViewSwitcher';

export type TranscriptCliTarget = {
  tmux: TmuxPaneIdentity;
  process: TmuxProcessGeneration;
  lane: 'external' | 'live';
  hostId?: string;
  localId?: string;
};

type TranscriptCliArgs = {
  externalTerminal: ExternalTerminalTarget | null;
  externalTranscript: ExternalTerminalTarget | null;
  liveSessionKind: MainContentProps['liveSessionKind'];
  liveSessionName: MainContentProps['liveSessionName'];
  liveSessionTarget: MainContentProps['liveSessionTarget'];
};

export function useTranscriptCliTarget({
  externalTerminal,
  externalTranscript,
  liveSessionKind,
  liveSessionName,
  liveSessionTarget,
}: TranscriptCliArgs) {
  const [externalTranscriptView, setExternalTranscriptView] = useState<ExternalTranscriptView>('conversation');
  const transcriptCliTarget = useMemo<TranscriptCliTarget | null>(() => {
    if (externalTranscript?.process) {
      return {
        tmux: externalTranscript.tmux,
        process: externalTranscript.process,
        lane: 'external' as const,
        ...(externalTranscript.hostId ? { hostId: externalTranscript.hostId } : {}),
        ...(externalTranscript.localId ? { localId: externalTranscript.localId } : {}),
      };
    }
    if (liveSessionKind === 'gjc' && liveSessionTarget) {
      return {
        ...liveSessionTarget,
        lane: 'live' as const,
      };
    }
    return null;
  }, [externalTranscript, liveSessionKind, liveSessionTarget]);
  const transcriptCliAttachTarget = useMemo(
    () => buildTranscriptCliAttachTarget(transcriptCliTarget),
    [transcriptCliTarget],
  );
  const transcriptCliProviderLabel = externalTranscript?.kind
    ?? (liveSessionKind === 'gjc' ? 'GJC' : null);
  const transcriptCliTmuxName = externalTranscript?.tmuxName
    ?? (liveSessionKind === 'gjc' ? liveSessionName : null);
  const externalOutputTarget = useMemo(() => {
    if (externalTranscriptView !== 'cli') {
      return null;
    }
    if (externalTerminal && externalTerminal.cliKind !== 'ssh' && externalTerminal.cliKind !== 'shell') {
      // Attachable panes mount the interactive terminal instead; the
      // read-only mirror stream would just duplicate the same bytes.
      return null;
    }
    // Attach-capable transcript targets also use the interactive terminal.
    return transcriptCliAttachTarget ? null : transcriptCliTarget;
  }, [externalTerminal, externalTranscriptView, transcriptCliAttachTarget, transcriptCliTarget]);

  const externalViewTargetKey = transcriptCliTarget
    ? tmuxPaneIdentityKey(transcriptCliTarget.tmux)
    : externalTerminal
      ? tmuxPaneIdentityKey(externalTerminal.tmux)
      : null;

  useEffect(() => {
    setExternalTranscriptView('conversation');
  }, [externalViewTargetKey]);

  return {
    externalTranscriptView,
    setExternalTranscriptView,
    transcriptCliTarget,
    transcriptCliAttachTarget,
    transcriptCliProviderLabel,
    transcriptCliTmuxName,
    externalOutputTarget,
  };
}
