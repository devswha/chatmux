import i18next from 'i18next';

import type { OwnerDiagnostics } from '../../../../../shared/diagnostics';
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
