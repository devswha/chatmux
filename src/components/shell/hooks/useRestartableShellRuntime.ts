import { useCallback, useEffect, useRef, useState } from 'react';

import { SHELL_RESTART_DELAY_MS } from '../constants/constants';
import type { UseShellRuntimeOptions, UseShellRuntimeResult } from '../types/types';

import { useShellRuntime } from './useShellRuntime';

type RestartableShellRuntimeOptions = Omit<UseShellRuntimeOptions, 'isRestarting'>;

type RestartableShellRuntimeResult = UseShellRuntimeResult & Readonly<{
  readonly isRestarting: boolean;
  readonly restartShell: () => void;
  readonly disconnectShell: () => void;
}>;

export function useRestartableShellRuntime(
  options: RestartableShellRuntimeOptions,
): RestartableShellRuntimeResult {
  const [isRestarting, setIsRestarting] = useState(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartAfterInitRef = useRef(false);
  const runtime = useShellRuntime({ ...options, isRestarting });
  const {
    connectToShell,
    disconnectFromShell,
    isInitialized,
    isConnected,
    isConnecting,
  } = runtime;

  useEffect(() => () => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
    }
  }, []);

  const restartShell = useCallback(() => {
    restartAfterInitRef.current = true;
    setIsRestarting(true);
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
    }
    restartTimerRef.current = setTimeout(() => {
      setIsRestarting(false);
      restartTimerRef.current = null;
    }, SHELL_RESTART_DELAY_MS);
  }, []);

  const disconnectShell = useCallback(() => {
    restartAfterInitRef.current = false;
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    setIsRestarting(false);
    disconnectFromShell({ suppressAutoConnect: true });
  }, [disconnectFromShell]);

  useEffect(() => {
    if (
      !restartAfterInitRef.current ||
      isRestarting ||
      !isInitialized ||
      isConnected ||
      isConnecting
    ) {
      return;
    }

    restartAfterInitRef.current = false;
    connectToShell({ forceRestart: true });
  }, [connectToShell, isConnected, isConnecting, isInitialized, isRestarting]);

  return { ...runtime, isRestarting, restartShell, disconnectShell };
}
