import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";

import { authenticatedFetch } from "../../../utils/api";
import { ReleaseInfo } from "../../../types/sharedTypes";
import { copyTextToClipboard } from "../../../utils/clipboard";
import type { InstallMode } from "../../../hooks/useVersionCheck";

interface VersionUpgradeModalProps {
    isOpen: boolean;
    onClose: () => void;
    releaseInfo: ReleaseInfo | null;
    currentVersion: string;
    latestVersion: string | null;
    installMode: InstallMode;
}

/**
 * Self-update phases. The trigger hands the real work to the server's detached
 * updater (deploy.sh: candidate build → restart → health check → auto-rollback),
 * so after `waiting` this page's only job is to poll /health until the bootId
 * changes — that is the restarted process answering. Version alone cannot signal
 * success (a source update may not bump package.json).
 */
type UpdatePhase =
    | { kind: 'idle' }
    | { kind: 'confirm' }
    | { kind: 'starting' }
    | { kind: 'waiting'; sinceMs: number }
    | { kind: 'success' }
    | { kind: 'failed'; message: string };

/** Pure: has the server come back as a NEW process since the update started? */
export function hasServerRebooted(initialBootId: string | null, health: { bootId?: unknown } | null): boolean {
    return Boolean(
        initialBootId
        && health
        && typeof health.bootId === 'string'
        && health.bootId.length > 0
        && health.bootId !== initialBootId,
    );
}

/** Give the pull + optional npm ci + build + restart + health check ample room. */
export const UPDATE_POLL_TIMEOUT_MS = 12 * 60 * 1000;
const UPDATE_POLL_INTERVAL_MS = 5_000;

const SOURCE_UPGRADE_COMMAND = 'git pull --ff-only && npm ci && npm run build && systemctl --user restart chatmux.service';

export function VersionUpgradeModal({
    isOpen,
    onClose,
    releaseInfo,
    currentVersion,
    latestVersion,
    installMode
}: VersionUpgradeModalProps) {
    const { t } = useTranslation('common');
    const [phase, setPhase] = useState<UpdatePhase>({ kind: 'idle' });
    const initialBootIdRef = useRef<string | null>(null);
    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const logPathRef = useRef<string | null>(null);

    const stopPolling = useCallback(() => {
        if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
        }
    }, []);

    useEffect(() => stopPolling, [stopPolling]);

    const beginPolling = useCallback((startedAtMs: number) => {
        stopPolling();
        pollTimerRef.current = setInterval(async () => {
            if (Date.now() - startedAtMs > UPDATE_POLL_TIMEOUT_MS) {
                stopPolling();
                setPhase({
                    kind: 'failed',
                    message: t('versionUpdate.updateTimedOut', {
                        defaultValue: 'The update did not come back in time — deploy.sh may have rolled back to the previous version. Check the log:',
                    }) + (logPathRef.current ? ` ${logPathRef.current}` : ''),
                });
                return;
            }
            try {
                const response = await fetch('/health');
                const health = await response.json();
                if (hasServerRebooted(initialBootIdRef.current, health)) {
                    stopPolling();
                    setPhase({ kind: 'success' });
                    // The restarted server serves the NEW frontend bundle; reload to load it.
                    setTimeout(() => window.location.reload(), 2_000);
                }
            } catch {
                // Mid-restart the server is briefly unreachable — that is expected; keep polling.
            }
        }, UPDATE_POLL_INTERVAL_MS);
    }, [stopPolling, t]);

    const handleUpdateNow = useCallback(async () => {
        setPhase({ kind: 'starting' });
        try {
            const healthResponse = await fetch('/health');
            const health = await healthResponse.json();
            initialBootIdRef.current = typeof health.bootId === 'string' ? health.bootId : null;

            const response = await authenticatedFetch('/api/system/update', { method: 'POST' });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.started) {
                setPhase({
                    kind: 'failed',
                    message: (typeof data?.error === 'string' && data.error) || `Update failed to start (HTTP ${response.status})`,
                });
                return;
            }
            logPathRef.current = typeof data.logPath === 'string' ? data.logPath : null;
            const startedAtMs = Date.now();
            setPhase({ kind: 'waiting', sinceMs: startedAtMs });
            beginPolling(startedAtMs);
        } catch (error) {
            setPhase({ kind: 'failed', message: error instanceof Error ? error.message : 'Update failed to start' });
        }
    }, [beginPolling]);

    if (!isOpen) return null;

    const busy = phase.kind === 'starting' || phase.kind === 'waiting';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop — kept inert while an update is in flight so the progress view stays visible */}
            <button
                className="fixed inset-0 bg-black/50 backdrop-blur-sm"
                onClick={busy ? undefined : onClose}
                aria-label={t('versionUpdate.ariaLabels.closeModal')}
            />

            {/* Modal */}
            <div className="relative mx-4 max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-lg border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-800">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                            <svg className="h-5 w-5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
                            </svg>
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('versionUpdate.title')}</h2>
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                                {releaseInfo?.title || t('versionUpdate.newVersionReady')}
                            </p>
                        </div>
                    </div>
                    {!busy && (
                        <button
                            onClick={onClose}
                            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                        >
                            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    )}
                </div>

                {/* Version Info */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between rounded-lg bg-gray-50 p-3 dark:bg-gray-700/50">
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('versionUpdate.currentVersion')}</span>
                        <span className="font-mono text-sm text-gray-900 dark:text-white">{currentVersion}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-700 dark:bg-blue-900/20">
                        <span className="text-sm font-medium text-blue-700 dark:text-blue-300">{t('versionUpdate.latestVersion')}</span>
                        <span className="font-mono text-sm text-blue-900 dark:text-blue-100">{latestVersion}</span>
                    </div>
                </div>

                {/* Changelog */}
                {phase.kind !== 'waiting' && releaseInfo?.body && (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-medium text-gray-900 dark:text-white">{t('versionUpdate.whatsNew')}</h3>
                            {releaseInfo?.htmlUrl && (
                                <a
                                    href={releaseInfo.htmlUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
                                >
                                    {t('versionUpdate.viewFullRelease')}
                                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                    </svg>
                                </a>
                            )}
                        </div>
                        <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-700/50">
                            <div className="prose prose-sm max-w-none text-sm text-gray-700 dark:prose-invert dark:text-gray-300">
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={changelogComponents}>
                                    {cleanChangelog(releaseInfo.body)}
                                </ReactMarkdown>
                            </div>
                        </div>
                    </div>
                )}

                {/* Phase surfaces */}
                {phase.kind === 'confirm' && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
                        {t('versionUpdate.confirmRestartWarning', {
                            defaultValue: 'The server pulls the update, rebuilds, and restarts itself — this view drops for a couple of minutes and a failed health check rolls back automatically. tmux agent sessions keep running; only an in-flight web-run turn would be interrupted.',
                        })}
                    </div>
                )}

                {(phase.kind === 'starting' || phase.kind === 'waiting') && (
                    <div className="flex items-center gap-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-blue-800 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-200">
                        <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                        {t('versionUpdate.waitingRestart', {
                            defaultValue: 'Updating — pulling, building, and restarting the server. This page reloads by itself when the new version answers.',
                        })}
                    </div>
                )}

                {phase.kind === 'success' && (
                    <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-200">
                        {t('versionUpdate.updateSucceeded', { defaultValue: 'Updated — the new server is answering. Reloading…' })}
                    </div>
                )}

                {phase.kind === 'failed' && (
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200">
                        {phase.message}
                    </div>
                )}

                {/* Manual path */}
                {(phase.kind === 'idle' || phase.kind === 'failed') && (
                    <div className="space-y-3">
                        <h3 className="text-sm font-medium text-gray-900 dark:text-white">{t('versionUpdate.manualUpgrade')}</h3>
                        {installMode === 'release' ? (
                            <p className="rounded-lg border bg-gray-100 p-3 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-200">
                                {t('versionUpdate.releaseModeManual', {
                                    defaultValue: 'Release-artifact installs update via the checksum-verified cutover in docs/SELF-HOST.md — one-click update is intentionally not offered.',
                                })}
                            </p>
                        ) : (
                            <div className="rounded-lg border bg-gray-100 p-3 dark:bg-gray-800">
                                <code className="font-mono text-sm text-gray-800 dark:text-gray-200">
                                    {SOURCE_UPGRADE_COMMAND}
                                </code>
                            </div>
                        )}
                        <p className="text-xs text-gray-600 dark:text-gray-400">
                            {t('versionUpdate.manualUpgradeHint')}
                        </p>
                    </div>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-2">
                    {!busy && phase.kind !== 'success' && (
                        <button
                            onClick={onClose}
                            className="flex-1 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                        >
                            {t('versionUpdate.buttons.later')}
                        </button>
                    )}
                    {(phase.kind === 'idle' || phase.kind === 'failed') && installMode !== 'release' && (
                        <button
                            onClick={() => copyTextToClipboard(SOURCE_UPGRADE_COMMAND)}
                            className="flex-1 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                        >
                            {t('versionUpdate.buttons.copyCommand')}
                        </button>
                    )}
                    {phase.kind === 'idle' && installMode === 'source' && (
                        <button
                            onClick={() => setPhase({ kind: 'confirm' })}
                            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                        >
                            {t('versionUpdate.buttons.updateNow')}
                        </button>
                    )}
                    {phase.kind === 'confirm' && (
                        <button
                            onClick={() => void handleUpdateNow()}
                            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                        >
                            {t('versionUpdate.buttons.confirmUpdate', { defaultValue: 'Update and restart' })}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

const changelogComponents = {
    a: ({ href, children }: { href?: string; children?: ReactNode }) => (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
            {children}
        </a>
    ),
};

// Clean up changelog by removing GitHub-specific metadata
const cleanChangelog = (body: string) => {
    if (!body) return '';

    return body
        // Remove full commit hashes (40 character hex strings)
        .replace(/\b[0-9a-f]{40}\b/gi, '')
        // Remove short commit hashes (7-10 character hex strings at start of line or after dash/space)
        .replace(/(?:^|\s|-)([0-9a-f]{7,10})\b/gi, '')
        // Remove "Full Changelog" links
        .replace(/\*\*Full Changelog\*\*:.*$/gim, '')
        // Remove compare links (e.g., https://github.com/.../compare/v1.0.0...v1.0.1)
        .replace(/https?:\/\/github\.com\/[^\/]+\/[^\/]+\/compare\/[^\s)]+/gi, '')
        // Clean up multiple consecutive empty lines
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        // Trim whitespace
        .trim();
};
