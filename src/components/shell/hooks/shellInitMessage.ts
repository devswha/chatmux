import type {
  RemoteTerminalResume,
  ShellAttachTarget,
  ShellInitMessage,
} from '../types/types';

export type ShellInitMessageParams = Readonly<{
  readonly projectPath: string;
  readonly sessionId: string | null;
  readonly hasSession: boolean;
  readonly provider: string;
  readonly cols: number;
  readonly rows: number;
  readonly initialCommand: string | null | undefined;
  readonly isPlainShell: boolean;
  readonly forceRestart: boolean;
  readonly attachTarget: ShellAttachTarget | null | undefined;
  /** Last output seq already rendered; lets the local server resume seamlessly. */
  readonly lastSeq?: number | null;
  /** Exact peer terminal identity returned by the remote gateway. */
  readonly remoteResume?: RemoteTerminalResume | null;
}>;

export function buildShellInitMessage({
  projectPath, sessionId, hasSession, provider, cols, rows, initialCommand,
  isPlainShell, forceRestart, attachTarget, lastSeq, remoteResume,
}: ShellInitMessageParams): ShellInitMessage {
  if (attachTarget?.targetClass === 'remote-agent') {
    return {
      type: 'init', shellProtocolVersion: 2, mode: 'remote-attach',
      target: attachTarget.target, cols, rows, resume: remoteResume ?? null,
    };
  }
  const base = {
    ...(typeof lastSeq === 'number' ? { lastSeq } : {}),
    type: 'init' as const,
    shellProtocolVersion: 2 as const,
    projectPath,
    sessionId,
    hasSession,
    provider,
    cols,
    rows,
    forceRestart,
  };
  if (attachTarget?.targetClass === 'local-agent') {
    return {
      ...base, mode: 'typed-attach', targetClass: 'local-agent',
      tmux: attachTarget.tmux, process: attachTarget.process,
    };
  }
  if (attachTarget) {
    return {
      ...base, mode: 'typed-attach', targetClass: 'attach-only',
      tmux: attachTarget.tmux, capability: attachTarget.capability,
    };
  }
  return { ...base, mode: 'plain-shell', initialCommand, isPlainShell };
}
