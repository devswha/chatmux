import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';
import type { RemoteTerminalResume, ShellAttachTarget } from '../types/types';
import { TERMINAL_INIT_DELAY_MS } from '../constants/constants';
import { getShellWebSocketUrl, sendSocketMessage } from '../utils/socket';

import { buildShellInitMessage } from './shellInitMessage';
import { handleShellSocketPayload } from './shellMessageHandler';

export { buildShellInitMessage } from './shellInitMessage';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

type UseShellConnectionOptions = {
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
  isInitialized: boolean;
  autoConnect: boolean;
  closeSocket: () => void;
  clearTerminalScreen: () => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  isConnected: boolean;
  isConnecting: boolean;
  isProtocolOutdated: boolean;
  closeSocket: () => void;
  connectToShell: (options?: { forceRestart?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
};

export function useShellConnection({
  wsRef,
  terminalRef,
  fitAddonRef,
  selectedProjectRef,
  projectPathRef,
  selectedSessionRef,
  initialCommandRef,
  isPlainShellRef,
  attachTargetRef,
  onProcessCompleteRef,
  isInitialized,
  autoConnect,
  closeSocket,
  clearTerminalScreen,
  onOutputRef,
}: UseShellConnectionOptions): UseShellConnectionResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isProtocolOutdated, setIsProtocolOutdated] = useState(false);
  const connectingRef = useRef(false);
  const forceRestartOnInitRef = useRef(false);
  const suppressAutoConnectRef = useRef(false);
  const protocolOutdatedRef = useRef(false);
  // Sequence-acknowledged resume: track the newest output seq we rendered so
  // a reconnect can ask the server to replay only what we missed, and reset it
  // whenever the connection targets a different shell identity.
  const lastSeqRef = useRef<number | null>(null);
  const remoteResumeRef = useRef<RemoteTerminalResume | null>(null);
  const replayIdentityRef = useRef<string | null>(null);

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  const handleSocketMessage = useCallback((rawPayload: string) => {
    handleShellSocketPayload(rawPayload, {
      terminalRef,
      lastSeqRef,
      remoteResumeRef,
      protocolOutdatedRef,
      suppressAutoConnectRef,
      clearTerminalScreen,
      handleProcessCompletion,
      notifyOutput: onOutputRef?.current ?? undefined,
      setProtocolOutdated: setIsProtocolOutdated,
    });
  }, [clearTerminalScreen, handleProcessCompletion, onOutputRef, terminalRef]);

  const connectWebSocket = useCallback(
    (isConnectionLocked = false) => {
      if ((connectingRef.current && !isConnectionLocked) || isConnecting || isConnected) {
        return;
      }

      try {
        const wsUrl = getShellWebSocketUrl(attachTargetRef.current?.targetClass);

        connectingRef.current = true;

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          setIsConnected(true);
          setIsConnecting(false);
          connectingRef.current = false;

          window.setTimeout(() => {
            const currentTerminal = terminalRef.current;
            const currentFitAddon = fitAddonRef.current;
            const currentProject = selectedProjectRef.current;
            const currentAttachTarget = attachTargetRef.current;
            if (!currentTerminal || !currentFitAddon || (!currentProject && !currentAttachTarget)) {
              return;
            }

            currentFitAddon.fit();
            const forceRestart = forceRestartOnInitRef.current;
            forceRestartOnInitRef.current = false;
            const typedAttach = Boolean(currentAttachTarget);
            const projectPath = projectPathRef.current
              ?? currentProject?.fullPath
              ?? currentProject?.path
              ?? '';

            const identity = JSON.stringify([
              projectPath,
              typedAttach || isPlainShellRef.current ? null : selectedSessionRef.current?.id || null,
              typedAttach ? false : isPlainShellRef.current,
              typedAttach ? null : initialCommandRef.current ?? null,
              currentAttachTarget ?? null,
            ]);
            if (forceRestart || identity !== replayIdentityRef.current) {
              replayIdentityRef.current = identity;
              lastSeqRef.current = null;
              remoteResumeRef.current = null;
            }

            sendSocketMessage(socket, buildShellInitMessage({
              projectPath,
              sessionId: typedAttach || isPlainShellRef.current
                ? null
                : selectedSessionRef.current?.id || null,
              hasSession: typedAttach
                ? false
                : !isPlainShellRef.current && Boolean(selectedSessionRef.current),
              provider: typedAttach
                ? 'external'
                : isPlainShellRef.current
                  ? 'plain-shell'
                  : (selectedSessionRef.current?.__provider || localStorage.getItem('selected-provider') || 'claude'),
              cols: currentTerminal.cols,
              rows: currentTerminal.rows,
              initialCommand: typedAttach ? null : initialCommandRef.current,
              isPlainShell: typedAttach ? false : isPlainShellRef.current,
              forceRestart,
              attachTarget: currentAttachTarget,
              lastSeq: lastSeqRef.current,
              remoteResume: remoteResumeRef.current,
            }));
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          // Keep the rendered screen: on reconnect the server either resumes
          // seamlessly (replays only missed output) or sends replay_start
          // 'redraw', which clears before repainting.
        };

        socket.onerror = () => {
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
        };
      } catch {
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
        forceRestartOnInitRef.current = false;
      }
    },
    [
      fitAddonRef,
      handleSocketMessage,
      initialCommandRef,
      isConnected,
      isConnecting,
      isPlainShellRef,
      attachTargetRef,
      selectedProjectRef,
      projectPathRef,
      selectedSessionRef,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback((options?: { forceRestart?: boolean; automatic?: boolean }) => {
    if (
      !isInitialized ||
      isConnected ||
      isConnecting ||
      connectingRef.current ||
      (options?.automatic && protocolOutdatedRef.current)
    ) {
      return;
    }

    protocolOutdatedRef.current = false;
    setIsProtocolOutdated(false);
    forceRestartOnInitRef.current = Boolean(options?.forceRestart);
    suppressAutoConnectRef.current = false;
    connectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket(true);
  }, [connectWebSocket, isConnected, isConnecting, isInitialized]);

  const disconnectFromShell = useCallback((options?: { suppressAutoConnect?: boolean }) => {
    if (options?.suppressAutoConnect) {
      suppressAutoConnectRef.current = true;
    }

    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    connectingRef.current = false;
    forceRestartOnInitRef.current = false;
  }, [clearTerminalScreen, closeSocket]);

  useEffect(() => {
    if (
      !autoConnect ||
      suppressAutoConnectRef.current ||
      protocolOutdatedRef.current ||
      !isInitialized ||
      isConnecting ||
      isConnected
    ) {
      return;
    }

    connectToShell({ automatic: true });
  }, [autoConnect, connectToShell, isConnected, isConnecting, isInitialized]);

  return { isConnected, isConnecting, isProtocolOutdated, closeSocket, connectToShell, disconnectFromShell };
}
