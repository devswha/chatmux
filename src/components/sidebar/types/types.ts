import type { ExternalTerminalTarget, Project, ProjectSession } from '../../../types/app';
import type { TmuxPaneIdentity, TmuxPaneTarget } from '../../../../shared/tmux';
import type { ExternalCliSession } from '../hooks/useExternalCliSessions';
import type {
  CompletionNotificationDescriptor,
  CompletionNotificationDevice,
  CompletionNotificationStatusItem,
  CompletionNotificationTarget,
} from '../../../../shared/completion-notifications';

export type SidebarProps = {
  projects: Project[];
  selectedSession: ProjectSession | null;
  liveSessionIds: ReadonlySet<string>;
  liveSessionNames: ReadonlyMap<string, string>;
  liveSessionModels: ReadonlyMap<string, string>;
  liveSessionEfforts: ReadonlyMap<string, string>;
  liveSessionLineage: ReadonlySet<string>;
  liveSessionPanes: ReadonlyMap<string, TmuxPaneIdentity>;
  liveSessionPresence: ReadonlyMap<string, 'present' | 'stale'>;
  liveSessionTargets: ReadonlyMap<string, TmuxPaneTarget>;
  liveSessionKinds: ReadonlyMap<string, string>;
  liveSessionRunning: ReadonlySet<string>;
  liveSessionInput?: ReadonlySet<string>;
  liveSessionErrors?: ReadonlySet<string>;
  liveSessionsLoaded: boolean;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession, projectId?: string) => void;
  onRefresh: () => Promise<void> | void;
  onShowSettings: () => void;
  showSettings: boolean;
  settingsInitialTab: string;
  onCloseSettings: () => void;
  isMobile: boolean;
  onExternalTerminalOpen: (target: ExternalTerminalTarget, options?: { forceAttach?: boolean }) => void;
  onExternalSessionsChange: (sessions: ExternalCliSession[]) => void;
};

export type SettingsProject = {
  name: string;
  displayName: string;
  fullPath: string;
  path?: string;
};

export type CompletionNotificationReason =
  | 'settings_changed'
  | 'permission_denied'
  | 'permission_not_granted'
  | 'secure_context_required'
  | 'ios_install_required'
  | 'unsupported'
  | 'invalid_subscription'
  | 'target_unavailable'
  | 'request_failed'
  | 'refresh_failed'
  | 'timeout';

export type CompletionNotificationDescriptorStatus = {
  item: CompletionNotificationStatusItem | null;
  target: CompletionNotificationTarget | null;
  device: CompletionNotificationDevice | null;
  globalPaused: boolean;
  pending: boolean;
  error: CompletionNotificationReason | null;
};

export type CompletionNotificationsHookApi = {
  status: CompletionNotificationDescriptorStatus | null;
  statuses: ReadonlyMap<string, CompletionNotificationDescriptorStatus>;
  setWatch: (descriptor: CompletionNotificationDescriptor, watched: boolean) => Promise<void>;
  repairDevice: (descriptor: CompletionNotificationDescriptor) => Promise<void>;
  refresh: () => Promise<void>;
};
