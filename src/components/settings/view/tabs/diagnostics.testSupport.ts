import i18next from 'i18next';

import type { OwnerDiagnostics, OwnerPaneDiagnostics } from '../../../../../shared/diagnostics';
import enSettings from '../../../../i18n/locales/en/settings.json';
import koSettings from '../../../../i18n/locales/ko/settings.json';

export const i18n = i18next.createInstance();
await i18n.init({
  lng: 'en', fallbackLng: 'en',
  resources: { en: { settings: enSettings }, ko: { settings: koSettings } },
  interpolation: { escapeValue: false },
});

export function summary(): OwnerDiagnostics {
  return {
    schemaVersion: 1, generatedAtMs: 100_000, cacheTtlMs: 2_000,
    collector: {
      status: 'available', mode: 'active', scanning: false, freshness: 'fresh',
      scanAgeMs: 1_000, fullScanAgeMs: 8_000, staleAfterMs: 30_000, rowsTruncated: false,
      lanes: {
        external: { status: 'ok', consecutiveFailures: 0, rows: 4, staleRows: 1 },
        live: { status: 'ok', consecutiveFailures: 0, rows: 2, staleRows: 0 },
      },
      connectionIssues: [],
    },
    gjcWatcher: { status: 'no_failures_reported', consecutiveFailures: 0, watchLimitObserved: false },
    indexing: {
      status: 'accepting', pending: 12, active: 3, maxPending: 448, maxActive: 4,
      reconciling: 1, reconciliationPending: 2, overflowed: 25, failures: 6,
    },
    eventLoop: { utilization: 0.25 },
  };
}

export function paneSummary(): OwnerPaneDiagnostics {
  const { status, freshness, scanAgeMs, fullScanAgeMs, lanes } = summary().collector;
  return {
    schemaVersion: 1, generatedAtMs: 100_000, cacheTtlMs: 2_000, staleAfterMs: 30_000,
    collector: { status, freshness, scanAgeMs, fullScanAgeMs, lanes },
    host: {
      freshness: 'stale', ageMs: 42_000, capture: 'partial', failure: null,
      sockets: [
        { slot: 1, capture: 'ok', reason: null, paneCount: 1 },
        { slot: 2, capture: 'unavailable', reason: 'socket_unavailable', paneCount: 0 },
      ],
    },
    limits: { discoveryRows: 1_000, hostPanes: 1_000, hostProcesses: 8_192, lineagePids: 32 },
    coverage: {
      totalRows: 1_002, rowsInspected: 1_000, rowsOmitted: 2, invalidRowsOmitted: 3,
      hostPanesOmitted: 4, hostProcessesOmitted: 5, countsCapped: true,
    },
    panes: [{
      paneNumber: 1, socketNumber: 1, captureSlot: 1,
      sessionId: '$0', windowId: '@0', paneId: '%0', panePid: 100,
      observations: [{
        lane: 'external', provider: 'codex', presence: 'present', freshness: 'fresh',
        activity: 'waiting_user', connectionIssue: null, actionabilityReport: 'unknown',
        binding: { grade: 'observed', providerSessionReported: true },
        process: {
          agentPid: 200, generation: 'recorded',
          lineage: { relation: 'descendant', reason: null, pids: [100, 150, 200] },
        },
      }],
    }],
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
