import type { MutableRefObject, RefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';
import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../shared/tmux';
import type { PublicTerminalTarget, ShellV3ClientMessage, ShellV3InitRequest, ShellV3ServerMessage } from '../../../../shared/terminal-runtime';
export const CLIENT_RELOAD_REQUIRED = 'CLIENT_RELOAD_REQUIRED';

export type ShellAttachTarget = {
  runtime: 'herdr';
  target: Extract<PublicTerminalTarget, { runtime: 'herdr' }>;
  mode: 'observe' | 'control';
} | ({
  runtime?: 'tmux';
  tmux: TmuxPaneIdentity;
} & ({
  targetClass: 'local-agent';
  process: TmuxProcessGeneration;
} | {
  targetClass: 'attach-only';
  capability: string;
}));

type TmuxShellV3InitBase = {
  type: 'terminal.init';
  protocolVersion: 3;
  projectPath: string;
  sessionId: string | null;
  hasSession: boolean;
  provider: string;
  cols: number;
  rows: number;
  forceRestart?: boolean;
  lastSeq?: number;
};

export type ShellInitMessage = ShellV3InitRequest | (TmuxShellV3InitBase & (
  | {
      mode: 'plain-shell';
      initialCommand: string | null | undefined;
      isPlainShell: boolean;
    }
  | {
      mode: 'typed-attach';
      target: Extract<PublicTerminalTarget, { runtime: 'tmux' }>;
    }
));

export type ShellResizeMessage = {
  type: 'resize';
  cols: number;
  rows: number;
};

export type ShellInputMessage = {
  type: 'input';
  data: string;
};

export type ShellOutgoingMessage = ShellInitMessage | ShellV3ClientMessage | ShellResizeMessage | ShellInputMessage;

export type ShellIncomingMessage = ShellV3ServerMessage
  | { type: 'output'; data: string; seq?: number }
  | { type: 'replay_start'; mode?: 'resume' | 'redraw' }
  | { type: 'auth_url'; url?: string }
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
  isAttachCapabilityUnavailable: boolean;
  connectToShell: (options?: { forceRestart?: boolean; automatic?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
};
