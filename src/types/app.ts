import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../shared/tmux';
import type { PublicTerminalTarget } from '../../shared/terminal-runtime';

export type LLMProvider = 'claude' | 'cursor' | 'codex' | 'opencode' | 'gjc' | 'omp';

export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

export type ProviderModelsCacheInfo = {
  updatedAt: string;
  expiresAt: string;
  source: 'memory' | 'disk' | 'fresh';
};


export type AppTab = 'chat';

/**
 * A discovered external CLI target. Local coding-agent sessions open their
 * structured transcript when indexed. Exact terminal attach remains available
 * without a matching ChatMux project; project context is required only for
 * transcript navigation and plain-shell flows. SSH and shell panes are
 * attach-only.
 */
export type ExternalTerminalTarget = {
  runtime: 'herdr';
  terminal: Extract<PublicTerminalTarget, { runtime: 'herdr' }>;
  kind: 'Herdr';
  cliKind: 'herdr';
  project: null;
  mode: 'observe' | 'control';
  forceAttach?: boolean;
} | {
  tmuxName: string;
  tmux: TmuxPaneIdentity;
  process: TmuxProcessGeneration | null;
  kind: string;
  cliKind: 'claude' | 'codex' | 'cursor' | 'opencode' | 'omp' | 'ssh' | 'shell';
  project: Project | null;
  projectPath?: string;
  /** Opens the structured transcript instead of attaching a terminal. */
  transcriptSessionId?: string;
  /** Transcript-derived display metadata for a running CLI session. */
  sessionName?: string;
  model?: string | null;
  effort?: string | null;
  /** Transcript stream closed (recorder died) while the pane may still run. */
  transcriptEnded?: boolean;
  /** Opaque server-issued token required for attach-only SSH and shell panes. */
  attachCapability?: string;
  /** M5b B8: forces terminal attach for this exact pane, bypassing structured transcript routing. */
  forceAttach?: boolean;
} | {
  /** A freshly opened GJC pane has no transcript id until its first message. */
  tmuxName: string;
  tmux: TmuxPaneIdentity;
  process: TmuxProcessGeneration | null;
  kind: 'GJC';
  cliKind: 'gjc';
  project: Project;
  /** M5b B8: forces terminal attach for this exact pane, bypassing structured transcript routing. */
  forceAttach?: boolean;
};

export type HerdrExternalTerminalTarget = Extract<ExternalTerminalTarget, { runtime: 'herdr' }>;
export type TmuxExternalTerminalTarget = Exclude<ExternalTerminalTarget, HerdrExternalTerminalTarget>;

export function isHerdrExternalTerminal(
  target: ExternalTerminalTarget | null | undefined,
): target is HerdrExternalTerminalTarget {
  return Boolean(target && 'runtime' in target && target.runtime === 'herdr');
}

export interface ProjectSession {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  provider?: LLMProvider;
  __provider?: LLMProvider;
  // Tags the session with the owning project's DB `projectId` so UI handlers
  // (session switching, sidebar focus, etc.) can match against selectedProject.
  __projectId?: string;
  [key: string]: unknown;
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}


// After the projectName → projectId migration the backend no longer returns a
// folder-derived `name` string. Projects are now addressed everywhere by the
// DB-assigned `projectId` (primary key in the `projects` table), and the UI
// uses the same identifier for routing, state keys and API calls.
export interface Project {
  projectId: string;
  displayName: string;
  fullPath: string;
  path?: string;
  isStarred?: boolean;
  sessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  [key: string]: unknown;
}

export interface LoadingProgress {
  kind?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
}
