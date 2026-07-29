import { useCallback, useEffect, useRef, useState } from 'react';

import { version } from '../../package.json';
import { authenticatedFetch } from '../utils/api';

export type InstallMode = 'source' | 'release' | 'unknown';
export type UpdateAvailability = 'available' | 'unavailable' | 'unknown' | 'error';
export type UpdateJobPhase =
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'staging'
  | 'cutting_over'
  | 'restarting'
  | 'verifying_health'
  | 'rolling_back'
  | 'succeeded'
  | 'failed'
  | 'failed_rolled_back'
  | 'failed_rollback'
  | 'manual_required';

export type UpdateJob = {
  id: string;
  phase: UpdateJobPhase;
  targetVersion: string;
  error?: string;
};

export type SystemUpdateStatus = {
  mode?: InstallMode;
  bootId?: string;
  canUpdate?: boolean;
  source?: {
    available?: boolean;
    inFlight?: boolean;
    operationId?: string;
    initialBootId?: string;
    currentRevision?: string;
    targetRevision?: string;
    targetVersion?: string;
  } | null;
  release?: { available?: boolean; targetVersion?: string | null } | null;
  activeJob?: UpdateJob | null;
};

/** Strict server SemVer comparison. Invalid versions intentionally do not compare. */
export function compareSemVer(left: string, right: string): number | null {
  const parse = (value: string) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
    return match ? [match[1], match[2], match[3]] : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].length !== b[index].length) return a[index].length > b[index].length ? 1 : -1;
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export const useVersionCheck = (_owner: string, _repo: string) => {
  const [runningVersion, setRunningVersion] = useState<string | null>(null);
  const [bootId, setBootId] = useState<string | null>(null);
  const [installMode, setInstallMode] = useState<InstallMode>('unknown');
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [availability, setAvailability] = useState<UpdateAvailability>('unknown');
  const [canUpdate, setCanUpdate] = useState(false);
  const [activeJob, setActiveJob] = useState<UpdateJob | null>(null);
  const [sourceUpdate, setSourceUpdate] = useState<{ operationId: string; initialBootId: string } | null>(null);
  const requestInFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      const healthResponse = await fetch('/health');
      if (healthResponse.ok) {
        const health = await healthResponse.json() as { version?: unknown };
        setRunningVersion(typeof health.version === 'string' ? health.version : null);
      }

      const statusResponse = await authenticatedFetch('/api/system/update/status');
      if (!statusResponse.ok) {
        setAvailability('error');
        setCanUpdate(false);
        return;
      }
      const status = await statusResponse.json() as SystemUpdateStatus;
      setBootId(typeof status.bootId === 'string' ? status.bootId : null);
      setCanUpdate(status.canUpdate === true);
      setActiveJob(status.activeJob && typeof status.activeJob.id === 'string' && typeof status.activeJob.phase === 'string' && typeof status.activeJob.targetVersion === 'string' ? status.activeJob : null);
      setSourceUpdate(status.mode === 'source'
        && status.source?.inFlight === true
        && typeof status.source.operationId === 'string'
        && typeof status.source.initialBootId === 'string'
        ? { operationId: status.source.operationId, initialBootId: status.source.initialBootId }
        : null);
      setInstallMode(status.mode === 'source' || status.mode === 'release' ? status.mode : 'unknown');
      const sourceAvailable = status.source?.available === true;
      const releaseTargetVersion = status.release?.targetVersion;
      const sourceTargetVersion = status.source?.targetVersion;
      setLatestVersion(
        status.mode === 'release' && typeof releaseTargetVersion === 'string'
          ? releaseTargetVersion
          : status.mode === 'source' && typeof sourceTargetVersion === 'string'
            ? sourceTargetVersion
            : null,
      );
      setAvailability(status.mode === 'source'
        ? (sourceAvailable ? 'available' : status.source?.available === false ? 'unavailable' : 'unknown')
        : (status.release?.available === true ? 'available' : status.release?.available === false ? 'unavailable' : 'unknown'));
    } catch {
      setAvailability('error');
      setCanUpdate(false);
    } finally {
      requestInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5 * 60 * 1000);
    const onFocus = () => void refresh();
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  const clientRefreshAvailable = runningVersion !== null && compareSemVer(runningVersion, version) !== null && compareSemVer(runningVersion, version)! > 0;
  const serverUpdateAvailable = availability === 'available'
    && (installMode === 'source' || (installMode === 'release' && latestVersion !== null && runningVersion !== null && compareSemVer(latestVersion, runningVersion) !== null && compareSemVer(latestVersion, runningVersion)! > 0));

  return {
    activeJob,
    availability,
    bootId,
    canUpdate,
    clientRefreshAvailable,
    currentVersion: version,
    installMode,
    latestVersion,
    refresh,
    runningVersion,
    serverUpdateAvailable,
    sourceUpdateInFlight: sourceUpdate !== null,
    sourceUpdate,
    updateAvailable: clientRefreshAvailable || serverUpdateAvailable,
    restartRequired: clientRefreshAvailable,
  };
};