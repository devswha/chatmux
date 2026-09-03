import { useCallback, useEffect, useState } from 'react';

import { fleetApi, FleetSettingsRequestError } from './fleetApi';
import type { FleetEnrollmentInput, FleetPairingCode, FleetRevocationResult, FleetSettingsPayload, FleetSshEnrollmentInput, FleetSshEnrollmentResult } from './types';

type FleetSettingsState = Readonly<{
  readonly data: FleetSettingsPayload | null;
  readonly code: FleetPairingCode | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly lastRevocation: FleetRevocationResult | null;
}>;

function message(error: unknown): string {
  if (error instanceof FleetSettingsRequestError) return error.code;
  if (error instanceof Error) return error.message;
  return 'UNKNOWN_ERROR';
}

export function useFleetSettings() {
  const [state, setState] = useState<FleetSettingsState>({
    data: null, code: null, error: null, pending: false, lastRevocation: null,
  });
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fleetApi.settings(signal);
      setState((current) => ({ ...current, data, error: null }));
    } catch (error) {
      if (signal?.aborted) return;
      setState((current) => ({ ...current, error: message(error) }));
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setState((current) => ({ ...current, pending: true, error: null, lastRevocation: null }));
    try {
      await action();
      await load();
    } catch (error) {
      setState((current) => ({ ...current, error: message(error) }));
    } finally {
      setState((current) => ({ ...current, pending: false }));
    }
  }, [load]);

  const generateCode = useCallback(async () => {
    setState((current) => ({ ...current, pending: true, error: null }));
    try {
      const code = await fleetApi.pairingCode();
      setState((current) => ({ ...current, code }));
    } catch (error) {
      setState((current) => ({ ...current, error: message(error) }));
    } finally {
      setState((current) => ({ ...current, pending: false }));
    }
  }, []);
  const enroll = useCallback((input: FleetEnrollmentInput) => run(() => fleetApi.enroll(input)), [run]);
  const sshEnroll = useCallback(async (input: FleetSshEnrollmentInput): Promise<FleetSshEnrollmentResult> => {
    setState((current) => ({ ...current, pending: true, error: null, lastRevocation: null }));
    try {
      const result = await fleetApi.sshEnroll(input);
      await load();
      return result;
    } catch (error) {
      setState((current) => ({ ...current, error: message(error) }));
      throw error;
    } finally {
      setState((current) => ({ ...current, pending: false }));
    }
  }, [load]);
  const reconnect = useCallback((peerId: string) => run(() => fleetApi.reconnect(peerId)), [run]);
  const removeLocal = useCallback((peerId: string) => run(() => fleetApi.removeLocal(peerId)), [run]);
  const revoke = useCallback(async (peerId: string) => {
    setState((current) => ({ ...current, pending: true, error: null, lastRevocation: null }));
    try {
      const lastRevocation = await fleetApi.revoke(peerId);
      const data = await fleetApi.settings();
      setState((current) => ({ ...current, data, lastRevocation }));
    } catch (error) {
      setState((current) => ({ ...current, error: message(error) }));
    } finally {
      setState((current) => ({ ...current, pending: false }));
    }
  }, []);

  return { ...state, load, generateCode, enroll, sshEnroll, reconnect, revoke, removeLocal };
}
