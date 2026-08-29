import type { Dispatch, SetStateAction } from 'react';

import type { TmuxPaneTarget } from '../../../../shared/tmux';
import type {
  MarkSessionIdle,
  MarkSessionProcessing,
  SessionActivityMap,
} from '../../../hooks/useSessionProtection';
import type { AppTab, ExternalTerminalTarget, Project, ProjectSession } from '../../../types/app';
import type {
  SessionEstablishedContext,
  SessionNavigationOptions,
} from '../../chat/types/types';
import type { SettingsMainTab } from '../../settings/types/types';

export type LiveSessionActionTarget = TmuxPaneTarget & Readonly<{
  readonly hostId?: string;
  readonly localId?: string;
  readonly lane?: 'external' | 'live';
}>;

export type PrdFile = {
  name: string;
  content?: string;
  isExisting?: boolean;
  [key: string]: unknown;
};

export type MainContentProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isSessionReadOnly: boolean;
  liveSessionTarget: LiveSessionActionTarget | null;
  liveSessionModel: string | null;
  liveSessionEffort: string | null;
  liveSessionName: string | null;
  liveSessionKind: 'gjc' | 'codex' | 'claude' | 'cursor' | 'opencode' | 'omp' | 'omo' | null;
  /** True while the viewed live/external session is running a turn. */
  liveSessionProcessing?: boolean;
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onInputFocusChange: (focused: boolean) => void;
  onSessionProcessing: MarkSessionProcessing;
  onSessionIdle: MarkSessionIdle;
  processingSessions: SessionActivityMap;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings: (tab?: SettingsMainTab) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  // Indexed transcript currently backed by a native external tmux session.
  externalTranscript: ExternalTerminalTarget | null;
  // Local agents use transcript-first relay; remote SSH falls back to terminal attach.
  externalTerminal: ExternalTerminalTarget | null;
  onExternalTerminalClose: () => void;
};

export type MainContentHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  isMobile: boolean;
  onMenuClick: () => void;
};

export type MainContentStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  onMenuClick: () => void;
};

export type MobileMenuButtonProps = {
  onMenuClick: () => void;
  compact?: boolean;
};
