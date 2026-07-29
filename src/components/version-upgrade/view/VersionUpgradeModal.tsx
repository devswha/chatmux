import { useCallback, useEffect, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { InstallMode, SystemUpdateStatus, UpdateJob } from "../../../hooks/useVersionCheck";
import { refreshAfterServerUpdate, requestServiceWorkerRefresh } from "../../../services/serviceWorkerUpdate";
import { authenticatedFetch } from "../../../utils/api";
import { copyTextToClipboard } from "../../../utils/clipboard";

interface VersionUpgradeModalProps {
    isOpen: boolean;
    onClose: () => void;
    currentVersion: string;
    runningVersion: string | null;
    latestVersion: string | null;
    installMode: InstallMode;
    clientRefreshAvailable: boolean;
    serverUpdateAvailable: boolean;
    canUpdate: boolean;
    bootId: string | null;
    activeJob: UpdateJob | null;
    sourceUpdateInFlight: boolean;
    sourceUpdate: { operationId: string; initialBootId: string } | null;
}

export type UpdatePhase =
    | { kind: 'idle' }
    | { kind: 'confirm' }
    | { kind: 'starting' }
    | { kind: 'waiting'; mode: 'source' | 'release'; initialBootId: string | null; jobId?: string; operationId?: string; localSourceAuthorityPending?: boolean }
    | { kind: 'success' }
    | { kind: 'failed' | 'failed_rolled_back' | 'failed_rollback' | 'manual_required'; message?: string };

export type UpdatePhaseEvent =
    | { type: 'set'; phase: UpdatePhase }
    | { type: 'release_missing'; message: string }
    | { type: 'release_terminal'; phase: TerminalFailurePhase; message?: string }
    | { type: 'release_success' }
    | { type: 'source_poll'; healthSucceeded: boolean; bootUnchanged: boolean; authority: 'active' | 'inactive' | 'transient' }
    | { type: 'authority_lost'; message: string }
    | { type: 'retry' };

export function reduceUpdatePhase(phase: UpdatePhase, event: UpdatePhaseEvent): UpdatePhase {
    if (event.type === 'set') return event.phase;
    if (event.type === 'authority_lost') {
        return phase.kind === 'waiting' ? { kind: 'failed', message: event.message } : phase;
    }
    if (event.type === 'retry') return phase.kind === 'failed' ? { kind: 'confirm' } : phase;
    if (event.type === 'release_missing') {
        return phase.kind === 'waiting' && phase.mode === 'release'
            ? { kind: 'failed', message: event.message }
            : phase;
    }
    if (event.type === 'release_terminal') {
        return phase.kind === 'waiting' && phase.mode === 'release'
            ? { kind: event.phase, ...(event.message ? { message: event.message } : {}) }
            : phase;
    }
    if (event.type === 'release_success') {
        return phase.kind === 'waiting' && phase.mode === 'release' ? { kind: 'success' } : phase;
    }
    if (phase.kind !== 'waiting' || phase.mode !== 'source') return phase;
    if (event.healthSucceeded) return { kind: 'success' };
    if (event.authority === 'active' || event.authority === 'transient' || !event.bootUnchanged) return phase;
    if (phase.localSourceAuthorityPending) {
        return { ...phase, localSourceAuthorityPending: false };
    }
    return { kind: 'failed' };
}

type HealthResponse = { bootId?: unknown; version?: unknown };

const UPDATE_POLL_INTERVAL_MS = 5_000;
const SOURCE_UPGRADE_COMMAND = 'git pull --ff-only && npm ci && npm run build && systemctl --user restart chatmux.service';
type TerminalFailurePhase = 'failed' | 'failed_rolled_back' | 'failed_rollback' | 'manual_required';
const TERMINAL_FAILURE_PHASES = new Set<TerminalFailurePhase>(['failed', 'failed_rolled_back', 'failed_rollback', 'manual_required']);

function isTerminalFailurePhase(phase: UpdateJob['phase']): phase is TerminalFailurePhase {
    return TERMINAL_FAILURE_PHASES.has(phase as TerminalFailurePhase);
}
const UPDATE_BOOT_ID_KEY_PREFIX = 'chatmux:update:initial-boot:';

function storedInitialBootId(key: string, fallback: string | null): string | null {
    try {
        return sessionStorage.getItem(`${UPDATE_BOOT_ID_KEY_PREFIX}${key}`) || fallback;
    } catch {
        return fallback;
    }
}
export function sourceWaitInitialBootId(storedBootId: string | null, initialBootId: string): string {
    return storedBootId === initialBootId ? storedBootId : initialBootId;
}

function storedSourceInitialBootId(operationId: string, initialBootId: string): string {
    return sourceWaitInitialBootId(storedInitialBootId(`source:${operationId}`, initialBootId), initialBootId);
}


function rememberInitialBootId(key: string, bootId: string | null): void {
    if (!bootId) return;
    try {
        sessionStorage.setItem(`${UPDATE_BOOT_ID_KEY_PREFIX}${key}`, bootId);
    } catch {
        // Polling still works while this page remains open.
    }
}

function clearInitialBootId(key: string): void {
    try {
        sessionStorage.removeItem(`${UPDATE_BOOT_ID_KEY_PREFIX}${key}`);
    } catch {
        // Storage is optional.
    }
}

export function hasServerRebooted(initialBootId: string | null, health: HealthResponse | null): boolean {
    return Boolean(initialBootId && health && typeof health.bootId === 'string' && health.bootId.length > 0 && health.bootId !== initialBootId);
}

export function hasVerifiedServerUpdate(initialBootId: string | null, job: UpdateJob, health: HealthResponse | null): boolean {
    return job.phase === 'succeeded'
        && hasServerRebooted(initialBootId, health)
        && typeof health?.version === 'string'
        && health.version === job.targetVersion;
}

export function hasVerifiedSourceUpdate(initialBootId: string | null, health: HealthResponse | null): boolean {
    return hasServerRebooted(initialBootId, health);
}
export function authoritativeUpdateWait(
    activeJob: UpdateJob | null,
    sourceUpdate: { operationId: string; initialBootId: string } | null,
): { mode: 'release'; jobId: string } | { mode: 'source'; operationId: string; initialBootId: string } | null {
    if (activeJob) return { mode: 'release', jobId: activeJob.id };
    return sourceUpdate ? { mode: 'source', ...sourceUpdate } : null;
}

export function sourceAuthorityFromStatus(
    responseOk: boolean,
    status: SystemUpdateStatus | null,
    operationId: string,
    initialBootId: string,
): 'active' | 'inactive' | 'transient' {
    if (!responseOk) return 'transient';
    const source = status?.source;
    return source?.inFlight === true
        && source.operationId === operationId
        && source.initialBootId === initialBootId
        ? 'active'
        : 'inactive';
}


export function VersionUpgradeModal({
    isOpen,
    onClose,
    currentVersion,
    runningVersion,
    latestVersion,
    installMode,
    clientRefreshAvailable,
    serverUpdateAvailable,
    canUpdate,
    bootId,
    activeJob,
    sourceUpdateInFlight,
    sourceUpdate,
}: VersionUpgradeModalProps) {
    const { t } = useTranslation('common');
    const [phase, dispatch] = useReducer(reduceUpdatePhase, { kind: 'idle' });
    const refreshedRef = useRef(false);
    const jobPollInFlightRef = useRef(false);

    const applyRefreshOnce = useCallback(async (serverVersion: string): Promise<boolean> => {
        if (refreshedRef.current) return true;
        const result = await refreshAfterServerUpdate({ serverVersion });
        if (result === 'failed') return false;
        refreshedRef.current = true;
        return true;
    }, []);

    const pollUpdate = useCallback(async (waiting: Extract<UpdatePhase, { kind: 'waiting' }>) => {
        if (jobPollInFlightRef.current) return;
        jobPollInFlightRef.current = true;
        try {
            if (waiting.mode === 'release') {
                const response = await authenticatedFetch(`/api/system/update/jobs/${encodeURIComponent(waiting.jobId!)}`);
                const job = await response.json().catch(() => null) as UpdateJob | null;
                // A restart temporarily interrupts polling; retain the durable job id and retry.
                if (response.status === 404) {
                    clearInitialBootId(waiting.jobId!);
                    dispatch({ type: 'release_missing', message: t('versionUpdate.errors.start') });
                    return;
                }
                // A restart temporarily interrupts polling; retain the durable job id and retry.
                if (!response.ok || !job || job.id !== waiting.jobId) return;
                if (isTerminalFailurePhase(job.phase)) {
                    clearInitialBootId(job.id);
                    dispatch({ type: 'release_terminal', phase: job.phase, message: job.error });
                    return;
                }
                if (job.phase !== 'succeeded') return;

                const healthResponse = await fetch('/health');
                const health = healthResponse.ok ? await healthResponse.json() as HealthResponse : null;
                if (!hasVerifiedServerUpdate(waiting.initialBootId, job, health) || typeof health?.bootId !== 'string') return;
                if (!await applyRefreshOnce(job.targetVersion)) return;
                clearInitialBootId(job.id);
                dispatch({ type: 'release_success' });
                return;
            }

            const healthResponse = await fetch('/health');
            const health = healthResponse.ok ? await healthResponse.json() as HealthResponse : null;
            if (hasVerifiedSourceUpdate(waiting.initialBootId, health) && typeof health?.version === 'string') {
                if (!await applyRefreshOnce(health.version)) return;
                clearInitialBootId(`source:${waiting.operationId!}`);
                dispatch({ type: 'source_poll', healthSucceeded: true, bootUnchanged: false, authority: 'transient' });
                return;
            }

            const statusResponse = await authenticatedFetch('/api/system/update/status');
            const status = await statusResponse.json().catch(() => null) as SystemUpdateStatus | null;
            const authority = sourceAuthorityFromStatus(
                statusResponse.ok,
                status,
                waiting.operationId!,
                waiting.initialBootId!,
            );
            const bootUnchanged = typeof health?.bootId === 'string' && health.bootId === waiting.initialBootId;
            if (authority === 'inactive' && bootUnchanged && !waiting.localSourceAuthorityPending) {
                clearInitialBootId(`source:${waiting.operationId!}`);
            }
            dispatch({ type: 'source_poll', healthSucceeded: false, bootUnchanged, authority });
        } catch {
            // The server may be restarting. The next interval resumes polling.
        } finally {
            jobPollInFlightRef.current = false;
        }
    }, [applyRefreshOnce, t]);

    useEffect(() => {
        if (!isOpen || phase.kind !== 'waiting') return;
        void pollUpdate(phase);
        const timer = window.setInterval(() => void pollUpdate(phase), UPDATE_POLL_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [isOpen, phase, pollUpdate]);

    useEffect(() => {
        if (!isOpen) return;
        if (!canUpdate) {
            dispatch({ type: 'authority_lost', message: t('versionUpdate.errors.generic') });
            return;
        }
        const authoritative = authoritativeUpdateWait(activeJob, installMode === 'source' && sourceUpdateInFlight ? sourceUpdate : null);
        if (authoritative?.mode === 'release') {
            dispatch({ type: 'set', phase: {
                kind: 'waiting',
                mode: 'release',
                jobId: authoritative.jobId,
                initialBootId: storedInitialBootId(authoritative.jobId, bootId),
            } });
        } else if (authoritative?.mode === 'source') {
            dispatch({ type: 'set', phase: {
                kind: 'waiting',
                mode: 'source',
                operationId: authoritative.operationId,
                initialBootId: storedSourceInitialBootId(authoritative.operationId, authoritative.initialBootId),
                localSourceAuthorityPending: false,
            } });
        }
    }, [activeJob, bootId, canUpdate, installMode, isOpen, sourceUpdate, sourceUpdateInFlight, t]);

    const handleClientRefresh = useCallback(async () => {
        await requestServiceWorkerRefresh({ serverVersion: runningVersion || currentVersion });
    }, [currentVersion, runningVersion]);

    const handleUpdateNow = useCallback(async () => {
        if (!canUpdate || !serverUpdateAvailable || (installMode !== 'release' && installMode !== 'source')) return;
        dispatch({ type: 'set', phase: { kind: 'starting' } });
        try {
            const response = await authenticatedFetch('/api/system/update', {
                method: 'POST',
                headers: { 'X-ChatMux-Update-Intent': 'start' },
            });
            const data = await response.json().catch(() => null) as {
                jobId?: unknown;
                started?: unknown;
                mode?: unknown;
                operationId?: unknown;
                initialBootId?: unknown;
            } | null;
            if (!response.ok || data?.started !== true || data.mode !== installMode) {
                dispatch({ type: 'set', phase: { kind: 'failed', message: t('versionUpdate.errors.start') } });
                return;
            }
            if (installMode === 'release' && typeof data.jobId !== 'string') {
                dispatch({ type: 'set', phase: { kind: 'failed', message: t('versionUpdate.errors.start') } });
                return;
            }
            if (installMode === 'source' && (typeof data.operationId !== 'string' || typeof data.initialBootId !== 'string')) {
                dispatch({ type: 'set', phase: { kind: 'failed', message: t('versionUpdate.errors.start') } });
                return;
            }
            if (installMode === 'release') {
                const jobId = data.jobId as string;
                rememberInitialBootId(jobId, bootId);
                dispatch({ type: 'set', phase: { kind: 'waiting', mode: 'release', initialBootId: bootId, jobId } });
            } else {
                const operationId = data.operationId as string;
                const initialBootId = data.initialBootId as string;
                rememberInitialBootId(`source:${operationId}`, initialBootId);
                dispatch({ type: 'set', phase: { kind: 'waiting', mode: 'source', operationId, initialBootId, localSourceAuthorityPending: true } });
            }
        } catch {
            dispatch({ type: 'set', phase: { kind: 'failed', message: t('versionUpdate.errors.start') } });
        }
    }, [bootId, canUpdate, installMode, serverUpdateAvailable, t]);

    if (!isOpen) return null;
    const busy = phase.kind === 'starting' || phase.kind === 'waiting';
    const updateAllowed = serverUpdateAvailable && canUpdate && (installMode === 'release' || installMode === 'source');
    const manualText = installMode === 'release'
        ? t('versionUpdate.manual.release')
        : installMode === 'source'
            ? SOURCE_UPGRADE_COMMAND
            : t('versionUpdate.manual.unknown');

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <button className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={busy ? undefined : onClose} aria-label={t('versionUpdate.ariaLabels.closeModal')} />
            <div className="relative mx-4 max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-lg border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-800">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('versionUpdate.title')}</h2>
                        <p className="text-sm text-gray-500 dark:text-gray-400">{t('versionUpdate.versionSummary', { server: runningVersion || t('versionUpdate.unknownVersion'), client: currentVersion })}</p>
                    </div>
                    {!busy && <button onClick={onClose} aria-label={t('versionUpdate.ariaLabels.closeButton')} className="rounded-md p-2 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">×</button>}
                </div>

                {clientRefreshAvailable && (
                    <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-200">
                        {t('versionUpdate.clientRefresh.message')}
                        <button onClick={() => void handleClientRefresh()} className="ml-3 font-medium underline">{t('versionUpdate.clientRefresh.action')}</button>
                    </div>
                )}

                {serverUpdateAvailable && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
                        {installMode === 'source'
                            ? t('versionUpdate.serverUpdate.sourceAvailable', { version: latestVersion ?? 'main' })
                            : t('versionUpdate.serverUpdate.releaseAvailable', { version: latestVersion ? ` v${latestVersion}` : '' })}
                    </div>
                )}

                {phase.kind === 'confirm' && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{t('versionUpdate.confirm.message')}</div>}
                {busy && <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">{t('versionUpdate.progress.message')}</div>}
                {phase.kind === 'success' && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{t('versionUpdate.success.message')}</div>}
                {phase.kind === 'failed' && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{phase.message}</div>}
                {phase.kind === 'failed_rolled_back' && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{t('versionUpdate.errors.failedRolledBack', { error: phase.message })}</div>}
                {phase.kind === 'failed_rollback' && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{t('versionUpdate.errors.failedRollback', { error: phase.message })}</div>}
                {phase.kind === 'manual_required' && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{t('versionUpdate.errors.manualRequired', { error: phase.message })}</div>}

                {(phase.kind === 'idle' || phase.kind === 'failed' || phase.kind === 'failed_rolled_back' || phase.kind === 'failed_rollback' || phase.kind === 'manual_required') && (
                    <div className="space-y-2">
                        <h3 className="text-sm font-medium text-gray-900 dark:text-white">{t('versionUpdate.manual.title')}</h3>
                        <code className="block rounded-lg border bg-gray-100 p-3 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-200">{manualText}</code>
                        {installMode === 'source' && <button onClick={() => copyTextToClipboard(SOURCE_UPGRADE_COMMAND)} className="text-sm underline">{t('versionUpdate.manual.copyCommand')}</button>}
                    </div>
                )}

                <div className="flex gap-2 pt-2">
                    {!busy && phase.kind !== 'success' && <button onClick={onClose} className="flex-1 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">{t('versionUpdate.buttons.later')}</button>}
                    {(phase.kind === 'idle' || phase.kind === 'failed' || phase.kind === 'failed_rolled_back' || phase.kind === 'failed_rollback' || phase.kind === 'manual_required') && updateAllowed && <button onClick={() => dispatch({ type: 'set', phase: { kind: 'confirm' } })} className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white">{t('versionUpdate.buttons.updateNow')}</button>}
                    {phase.kind === 'confirm' && <button onClick={() => void handleUpdateNow()} className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white">{t('versionUpdate.buttons.confirmUpdate')}</button>}
                </div>
            </div>
        </div>
    );
}
