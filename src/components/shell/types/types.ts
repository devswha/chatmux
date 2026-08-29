import type { MutableRefObject, RefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';
import type { FleetPaneReference } from '../../../../shared/fleet';
import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../shared/tmux';

export type RemoteTerminalResume = Readonly<{
  readonly peerProcessEpoch: string;
  readonly terminalSessionId: string;
  readonly streamEpoch: string;
  readonly lastSeq: number;
}>;

export type ShellAttachTarget =
  | Readonly<{ readonly targetClass: 'local-agent'; readonly tmux: TmuxPaneIdentity; readonly process: TmuxProcessGeneration }>
  | Readonly<{ readonly targetClass: 'attach-only'; readonly tmux: TmuxPaneIdentity; readonly capability: string }>
  | Readonly<{ readonly targetClass: 'remote-agent'; readonly target: FleetPaneReference }>;
export type InteractiveShellAttachTarget = Exclude<ShellAttachTarget, { readonly targetClass: 'attach-only' }>;

type LocalShellInitBase = Readonly<{
  readonly type: 'init';
  readonly shellProtocolVersion: 2;
  readonly projectPath: string;
  readonly sessionId: string | null;
  readonly hasSession: boolean;
  readonly provider: string;
  readonly cols: number;
  readonly rows: number;
  readonly forceRestart?: boolean;
  /** Last output seq this client rendered — enables seamless server-side resume. */
  readonly lastSeq?: number;
}>;

export type ShellInitMessage =
  | (LocalShellInitBase & Readonly<{
      readonly mode: 'plain-shell';
      readonly initialCommand: string | null | undefined;
      readonly isPlainShell: boolean;
    }>)
  | (LocalShellInitBase & Readonly<{
      readonly mode: 'typed-attach';
      readonly tmux: TmuxPaneIdentity;
    }> & (
      | Readonly<{ readonly targetClass: 'local-agent'; readonly process: TmuxProcessGeneration }>
      | Readonly<{ readonly targetClass: 'attach-only'; readonly capability: string }>
    ))
  | Readonly<{
      readonly type: 'init';
      readonly shellProtocolVersion: 2;
      readonly mode: 'remote-attach';
      readonly target: FleetPaneReference;
      readonly cols: number;
      readonly rows: number;
      readonly resume: RemoteTerminalResume | null;
    }>;

export type ShellResizeMessage = {
  type: 'resize';
  cols: number;
  rows: number;
};

export type ShellInputMessage = {
  type: 'input';
  data: string;
};

export type ShellOutgoingMessage = ShellInitMessage | ShellResizeMessage | ShellInputMessage;

export type ShellIncomingMessage =
  | { type: 'output'; data: string; seq?: number }
  | { type: 'replay_start'; mode?: 'resume' | 'redraw'; resume?: unknown }
  | { type: 'auth_url'; url?: string; autoOpen?: boolean }
  | { type: 'url_open'; url?: string }
  | { type: 'error'; code?: string; reloadRequired?: boolean; message?: string }
  | { type: string; [key: string]: unknown };

export type UseShellRuntimeOptions = {
  selectedProject: Project | null | undefined;
  projectPath?: string;
  selectedSession: ProjectSession | null | undefined;
  initialCommand: string | null | undefined;
  isPlainShell: boolean;
  attachTarget?: ShellAttachTarget | null;
  minimal: boolean;
  autoConnect: boolean;
  isRestarting: boolean;
  onProcessComplete?: ((exitCode: number) => void) | null;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

export type ShellSharedRefs = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  projectPathRef: MutableRefObject<string | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  attachTargetRef: MutableRefObject<ShellAttachTarget | null | undefined>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
};

export type UseShellRuntimeResult = {
  terminalContainerRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  isConnected: boolean;
  isInitialized: boolean;
  isConnecting: boolean;
  isProtocolOutdated: boolean;
  connectToShell: (options?: { forceRestart?: boolean; automatic?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
};
