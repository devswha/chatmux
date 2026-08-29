import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import '@xterm/xterm/css/xterm.css';
import type { Project, ProjectSession } from '../../../types/app';
import { useCliPromptOptions } from '../hooks/useCliPromptOptions';
import { useRestartableShellRuntime } from '../hooks/useRestartableShellRuntime';
import type { ShellAttachTarget } from '../types/types';
import { getSessionDisplayName } from '../utils/auth';
import { sendSocketMessage } from '../utils/socket';

import { CliPromptShortcuts } from './subcomponents/CliPromptShortcuts';
import ShellConnectionOverlay from './subcomponents/ShellConnectionOverlay';
import ShellEmptyState from './subcomponents/ShellEmptyState';
import ShellHeader from './subcomponents/ShellHeader';
import ShellMinimalView from './subcomponents/ShellMinimalView';
import TerminalShortcutsPanel from './subcomponents/TerminalShortcutsPanel';

type ShellProps = Readonly<{
  readonly selectedProject?: Project | null;
  readonly projectPath?: string;
  readonly selectedSession?: ProjectSession | null;
  readonly initialCommand?: string | null;
  readonly isPlainShell?: boolean;
  readonly attachTarget?: ShellAttachTarget | null;
  readonly onProcessComplete?: ((exitCode: number) => void) | null;
  readonly minimal?: boolean;
  readonly autoConnect?: boolean;
  readonly isActive?: boolean;
}>;

export default function Shell({
  selectedProject = null,
  projectPath,
  selectedSession = null,
  initialCommand = null,
  isPlainShell = false,
  attachTarget = null,
  onProcessComplete = null,
  minimal = false,
  autoConnect = false,
  isActive = true,
}: ShellProps) {
  const { t } = useTranslation('chat');
  const onOutputRef = useRef<(() => void) | null>(null);
  const {
    terminalContainerRef,
    terminalRef,
    wsRef,
    isConnected,
    isInitialized,
    isConnecting,
    isProtocolOutdated,
    isRestarting,
    restartShell,
    disconnectShell,
  } = useRestartableShellRuntime({
    selectedProject,
    projectPath,
    selectedSession,
    initialCommand,
    isPlainShell,
    attachTarget,
    minimal,
    autoConnect,
    onProcessComplete,
    onOutputRef,
  });
  const { options, dismiss } = useCliPromptOptions({ terminalRef, isConnected, onOutputRef });
  const sendPromptInput = useCallback((data: string) => {
    sendSocketMessage(wsRef.current, { type: 'input', data });
    dismiss();
  }, [dismiss, wsRef]);

  useEffect(() => {
    if (!isActive || !isInitialized || !isConnected) {
      return;
    }

    const focusTerminal = () => {
      terminalRef.current?.focus();
    };
    const animationFrameId = window.requestAnimationFrame(focusTerminal);
    const timeoutId = window.setTimeout(focusTerminal, 0);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.clearTimeout(timeoutId);
    };
  }, [isActive, isConnected, isInitialized, terminalRef]);

  const sessionDisplayName = useMemo(() => getSessionDisplayName(selectedSession), [selectedSession]);
  const sessionDisplayNameShort = useMemo(
    () => (sessionDisplayName ? sessionDisplayName.slice(0, 30) : null),
    [sessionDisplayName],
  );
  const sessionDisplayNameLong = useMemo(
    () => (sessionDisplayName ? sessionDisplayName.slice(0, 50) : null),
    [sessionDisplayName],
  );

  if (!selectedProject && !attachTarget) {
    return (
      <ShellEmptyState
        title={t('shell.selectProject.title')}
        description={t('shell.selectProject.description')}
      />
    );
  }

  if (minimal) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-gray-900">
        {isProtocolOutdated && (
          <div role="alert" className="shrink-0 bg-amber-900/80 px-3 py-2 text-sm text-amber-100">
            {t('shell.protocolOutdated')}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <ShellMinimalView terminalContainerRef={terminalContainerRef} />
        </div>
        <TerminalShortcutsPanel
          wsRef={wsRef}
          terminalRef={terminalRef}
          isConnected={isConnected}
        />
      </div>
    );
  }

  const attachSessionId = attachTarget?.targetClass === 'remote-agent'
    ? attachTarget.target.tmux.sessionId
    : attachTarget?.tmux.sessionId;
  const contextLabel = selectedProject?.displayName || attachSessionId || 'terminal';
  const readyDescription = isPlainShell
    ? t('shell.runCommand', {
        command: initialCommand || t('shell.defaultCommand'),
        projectName: contextLabel,
      })
    : selectedSession
      ? t('shell.resumeSession', { displayName: sessionDisplayNameLong })
      : t('shell.startSession');
  const connectingDescription = isPlainShell
    ? t('shell.runCommand', {
        command: initialCommand || t('shell.defaultCommand'),
        projectName: contextLabel,
      })
    : t('shell.startCli', { projectName: contextLabel });
  const overlayMode = !isInitialized ? 'loading' : isConnecting ? 'connecting' : !isConnected ? 'connect' : null;

  return (
    <div className="flex h-full w-full flex-col bg-gray-900">
      {isProtocolOutdated && (
        <div role="alert" className="bg-amber-900/80 px-3 py-2 text-sm text-amber-100">
          {t('shell.protocolOutdated')}
        </div>
      )}
      <ShellHeader
        isConnected={isConnected}
        isInitialized={isInitialized}
        isRestarting={isRestarting}
        hasSession={Boolean(selectedSession)}
        sessionDisplayNameShort={sessionDisplayNameShort}
        onDisconnect={disconnectShell}
        onRestart={restartShell}
        statusNewSessionText={t('shell.status.newSession')}
        statusInitializingText={t('shell.status.initializing')}
        statusRestartingText={t('shell.status.restarting')}
        disconnectLabel={t('shell.actions.disconnect')}
        disconnectTitle={t('shell.actions.disconnectTitle')}
        restartLabel={t('shell.actions.restart')}
        restartTitle={t('shell.actions.restartTitle')}
        disableRestart={isRestarting || !isInitialized}
      />
      <div className="relative flex-1 overflow-hidden p-2">
        <div
          ref={terminalContainerRef}
          className="h-full w-full focus:outline-none"
          style={{ outline: 'none' }}
        />
        {overlayMode && (
          <ShellConnectionOverlay
            mode={overlayMode}
            description={overlayMode === 'connecting' ? connectingDescription : readyDescription}
            loadingLabel={t('shell.loading')}
            connectLabel={t('shell.actions.connect')}
            connectTitle={t('shell.actions.connectTitle')}
            connectingLabel={t('shell.connecting')}
            onConnect={restartShell}
          />
        )}
        {options && isConnected && (
          <CliPromptShortcuts options={options} onInput={sendPromptInput} />
        )}
      </div>
      <TerminalShortcutsPanel
        wsRef={wsRef}
        terminalRef={terminalRef}
        isConnected={isConnected}
      />
    </div>
  );
}
