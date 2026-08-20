import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';
import { CLIENT_RELOAD_REQUIRED, type ShellAttachTarget, type ShellInitMessage } from '../types/types';
import { TERMINAL_INIT_DELAY_MS } from '../constants/constants';
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '../utils/socket';
import { decodeFramedBase64, readTerminalFrame } from '../../../../shared/terminal-runtime';

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

export type ShellInitMessageParams = {
  projectPath: string;
  sessionId: string | null;
  hasSession: boolean;
  provider: string;
  cols: number;
  rows: number;
  initialCommand: string | null | undefined;
  isPlainShell: boolean;
  forceRestart: boolean;
  attachTarget: ShellAttachTarget | null | undefined;
  /** Last output seq already rendered; lets the server resume seamlessly. */
  lastSeq?: number | null;
};

export function buildShellInitMessage({
  projectPath,
  sessionId,
  hasSession,
  provider,
  cols,
  rows,
  initialCommand,
  isPlainShell,
  forceRestart,
  attachTarget,
  lastSeq,
}: ShellInitMessageParams): ShellInitMessage {
  if (attachTarget?.runtime === 'herdr') {
    return {
      type: 'terminal.init',
      protocolVersion: 3,
      mode: attachTarget.mode,
      target: attachTarget.target,
      cols,
      rows,
    };
  }

  const base = {
    ...(typeof lastSeq === 'number' ? { lastSeq } : {}),
    type: 'terminal.init' as const,
    protocolVersion: 3 as const,
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
      ...base,
      mode: 'typed-attach',
      target: {
        runtime: 'tmux',
        tmux: attachTarget.tmux,
        targetClass: 'local-agent',
        process: attachTarget.process,
      },
    } as ShellInitMessage;
  }

  if (attachTarget) {
    return {
      ...base,
      mode: 'typed-attach',
      target: {
        runtime: 'tmux',
        tmux: attachTarget.tmux,
        targetClass: 'attach-only',
        admissionCapability: attachTarget.capability,
      },
    } as ShellInitMessage;
  }

  return {
    ...base,
    mode: 'plain-shell',
    initialCommand,
    isPlainShell,
  } as ShellInitMessage;
}

type UseShellConnectionResult = {
  isConnected: boolean;
  isConnecting: boolean;
  isProtocolOutdated: boolean;
  isAttachCapabilityUnavailable: boolean;
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
  const [isAttachCapabilityUnavailable, setIsAttachCapabilityUnavailable] = useState(false);
  const connectingRef = useRef(false);
  const forceRestartOnInitRef = useRef(false);
  const suppressAutoConnectRef = useRef(false);
  const protocolOutdatedRef = useRef(false);
  const reloadRequiredRef = useRef(false);
  // Sequence-acknowledged resume: track the newest output seq we rendered so
  // a reconnect can ask the server to replay only what we missed, and reset it
  // whenever the connection targets a different shell identity.
  const lastSeqRef = useRef<number | null>(null);
  const replayIdentityRef = useRef<string | null>(null);
  const herdrDecoderRef = useRef<TextDecoder | null>(null);
  const consumedHerdrAdmissionRef = useRef<string | null>(null);

  const getHerdrAdmissionIdentity = useCallback(() => {
    const attachTarget = attachTargetRef.current;
    return attachTarget?.runtime === 'herdr' ? JSON.stringify(attachTarget.target) : null;
  }, [attachTargetRef]);

  const requireFreshHerdrAdmission = useCallback(() => {
    suppressAutoConnectRef.current = true;
    setIsAttachCapabilityUnavailable(true);
  }, []);

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

  const handleSocketMessage = useCallback(
    (rawPayload: string) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        console.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        if (typeof message.seq === 'number') {
          lastSeqRef.current = message.seq;
        }
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'terminal.frame') {
        const frame = readTerminalFrame(message, lastSeqRef.current);
        const decoded = frame ? decodeFramedBase64(frame.bytes) : null;
        if (!frame || !decoded) {
          wsRef.current?.close();
          return;
        }
        if (frame.full) {
          clearTerminalScreen();
        }
        lastSeqRef.current = frame.seq;
        const decoder = herdrDecoderRef.current ??= new TextDecoder();
        terminalRef.current?.write(decoder.decode(decoded, { stream: true }));
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'terminal.lifecycle') {
        if (message.state === 'gap' || message.state === 'redraw_required') {
          lastSeqRef.current = null;
          clearTerminalScreen();
          return;
        }
        if (
          message.state === 'identity_invalidated'
          || message.state === 'ownership_lost'
          || message.state === 'source_disabled'
          || message.state === 'closed'
        ) {
          wsRef.current?.close();
        }
        return;
      }

      if (message.type === 'terminal.closed') {
        wsRef.current?.close();
        return;
      }

      // Socket events cannot satisfy browser user-activation requirements, so
      // render auth URLs in the terminal instead of attempting a popup.
      if (message.type === 'auth_url' && typeof message.url === 'string' && message.url) {
        terminalRef.current?.write(`\r\n[Authentication required] Open this URL in your browser:\r\n${message.url}\r\n`);
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'replay_start') {
        // 'resume' continues the existing screen; 'redraw' means the server is
        // about to repaint from scratch (fresh PTY, legacy path, or a replay
        // gap), so stale content must not stack under the replay.
        if (message.mode !== 'resume') {
          clearTerminalScreen();
        }
        return;
      }

      if (message.type === 'error' && message.code === CLIENT_RELOAD_REQUIRED) {
        reloadRequiredRef.current = true;
        protocolOutdatedRef.current = true;
        setIsProtocolOutdated(true);
      }
    },
    [clearTerminalScreen, handleProcessCompletion, onOutputRef, terminalRef, wsRef],
  );

  const connectWebSocket = useCallback(
    (isConnectionLocked = false) => {
      if ((connectingRef.current && !isConnectionLocked) || isConnecting || isConnected) {
        return;
      }

      try {
        const wsUrl = getShellWebSocketUrl();

        connectingRef.current = true;
        let herdrAdmissionIdentity: string | null = null;

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          herdrDecoderRef.current?.decode();
          herdrDecoderRef.current = null;
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
            }

            herdrAdmissionIdentity = getHerdrAdmissionIdentity();
            if (herdrAdmissionIdentity) {
              consumedHerdrAdmissionRef.current = herdrAdmissionIdentity;
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
            }));
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          const trailingOutput = herdrDecoderRef.current?.decode();
          herdrDecoderRef.current = null;
          if (trailingOutput) terminalRef.current?.write(trailingOutput);
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          if (herdrAdmissionIdentity && consumedHerdrAdmissionRef.current === herdrAdmissionIdentity) {
            requireFreshHerdrAdmission();
          }
          // Keep the rendered screen: on reconnect the server either resumes
          // seamlessly (replays only what was missed) or sends replay_start
          // 'redraw', which clears before repainting.
        };

        socket.onerror = () => {
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          if (herdrAdmissionIdentity && consumedHerdrAdmissionRef.current === herdrAdmissionIdentity) {
            requireFreshHerdrAdmission();
          }
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
      getHerdrAdmissionIdentity,
      handleSocketMessage,
      initialCommandRef,
      isConnected,
      isConnecting,
      isPlainShellRef,
      attachTargetRef,
      selectedProjectRef,
      projectPathRef,
      requireFreshHerdrAdmission,
      selectedSessionRef,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback((options?: { forceRestart?: boolean; automatic?: boolean }) => {
    const herdrAdmissionIdentity = getHerdrAdmissionIdentity();
    if (
      !isInitialized ||
      isConnected ||
      isConnecting ||
      connectingRef.current ||
      (options?.automatic && protocolOutdatedRef.current) ||
      reloadRequiredRef.current ||
      (herdrAdmissionIdentity !== null && consumedHerdrAdmissionRef.current === herdrAdmissionIdentity)
    ) {
      if (herdrAdmissionIdentity !== null && consumedHerdrAdmissionRef.current === herdrAdmissionIdentity) {
        requireFreshHerdrAdmission();
      }
      return;
    }

    protocolOutdatedRef.current = false;
    setIsProtocolOutdated(false);
    setIsAttachCapabilityUnavailable(false);
    forceRestartOnInitRef.current = Boolean(options?.forceRestart);
    suppressAutoConnectRef.current = false;
    connectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket(true);
  }, [connectWebSocket, getHerdrAdmissionIdentity, isConnected, isConnecting, isInitialized, requireFreshHerdrAdmission]);

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

  return {
    isConnected,
    isConnecting,
    isProtocolOutdated,
    isAttachCapabilityUnavailable,
    closeSocket,
    connectToShell,
    disconnectFromShell,
  };
}
