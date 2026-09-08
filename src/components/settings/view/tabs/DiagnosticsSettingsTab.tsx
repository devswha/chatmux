import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { OwnerDiagnostics, OwnerPaneDiagnostics } from '../../../../../shared/diagnostics';
import { Button } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';

export function DiagnosticsSummary({ data }: { data: OwnerDiagnostics }) {
  const { t, i18n } = useTranslation('settings');
  const collector = data.collector;
  // Older schema-v1 servers may omit this additive field during an upgrade.
  const indexing = data.indexing;
  const counter = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat(i18n.language).format(Math.floor(value)) : t('diagnostics.unknown');
  const withLimit = (value: number | null | undefined, limit: number | null | undefined) => t('diagnostics.indexing.withLimit', {
    value: counter(value), limit: counter(limit),
  });
  const failedLane = Object.values(collector.lanes).some((lane) => lane.status === 'failing' || lane.status === 'degraded');
  const age = (value: number | null) => value === null
    ? t('diagnostics.unknown')
    : t('diagnostics.seconds', { count: Math.floor(value / 1_000) });

  return (
    <div className="min-w-0 space-y-6 [overflow-wrap:anywhere]">
      <p className="text-xs text-muted-foreground">
        {t('diagnostics.sampledAt', { time: new Date(data.generatedAtMs).toLocaleTimeString(i18n.language) })}
      </p>
      <SettingsSection title={t('diagnostics.discovery')}>
        <SettingsCard className="space-y-4 p-4">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {[
              [t('diagnostics.freshness'), t(`diagnostics.freshnessStates.${collector.freshness}`)],
              [t('diagnostics.mode'), t(`diagnostics.modes.${collector.mode}`)],
              [t('diagnostics.scanAge'), age(collector.scanAgeMs)],
              [t('diagnostics.fullScanAge'), age(collector.fullScanAgeMs)],
            ].map(([label, value]) => (
              <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{value}</dd></div>
            ))}
          </dl>
          {collector.scanning && <p className="text-sm">{t('diagnostics.scanning')}</p>}
          {collector.status === 'available' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(['external', 'live'] as const).map((lane) => (
                <div key={lane} className="rounded-lg bg-muted/40 p-3 text-sm">
                  <h4 className="font-medium">{t(`diagnostics.lanes.${lane}`)}</h4>
                  <p>{t(`diagnostics.laneStates.${collector.lanes[lane].status}`)}</p>
                  <p className="mt-1 text-muted-foreground">{t('diagnostics.rowCounts', {
                    rows: collector.lanes[lane].rows, stale: collector.lanes[lane].staleRows,
                  })}</p>
                  <p>{t('diagnostics.failures', { count: collector.lanes[lane].consecutiveFailures })}</p>
                </div>
              ))}
            </div>
          )}
          {collector.rowsTruncated && <p className="text-sm text-muted-foreground">{t('diagnostics.truncated')}</p>}
          {(collector.freshness === 'waiting') && <p className="text-sm">{t('diagnostics.recovery.waiting')}</p>}
          {(collector.freshness === 'stale' || collector.freshness === 'unavailable' || failedLane) && (
            <p className="text-sm">{t('diagnostics.recovery.discovery')}</p>
          )}
        </SettingsCard>
      </SettingsSection>

      {collector.connectionIssues.length > 0 && (
        <SettingsSection title={t('diagnostics.connectionIssues')} description={t('diagnostics.issueDescription')}>
          <SettingsCard className="space-y-4 p-4">
            {collector.connectionIssues.map(({ code, count }) => (
              <div key={code} className="text-sm">
                <h4 className="font-medium">{t(`diagnostics.reasons.${code}.title`)} ({count})</h4>
                <p className="mt-1 text-muted-foreground">{t(`diagnostics.reasons.${code}.guidance`)}</p>
              </div>
            ))}
          </SettingsCard>
        </SettingsSection>
      )}

      <SettingsSection title={t('diagnostics.watcher')} description={t('diagnostics.watcherDescription')}>
        <SettingsCard className="space-y-2 p-4 text-sm">
          <p className="font-medium">{t(`diagnostics.watcherStates.${data.gjcWatcher.status}`)}</p>
          {data.gjcWatcher.status !== 'unavailable' && <p>{t('diagnostics.failures', { count: data.gjcWatcher.consecutiveFailures })}</p>}
          {data.gjcWatcher.watchLimitObserved && <p>{t('diagnostics.recovery.watchLimit')}</p>}
          {data.gjcWatcher.status !== 'no_failures_reported' && !data.gjcWatcher.watchLimitObserved && (
            <p>{t('diagnostics.recovery.watcher')}</p>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('diagnostics.indexing.title')} description={t('diagnostics.indexing.description')}>
        <SettingsCard className="space-y-3 p-4 text-sm">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[
              [t('diagnostics.indexing.admission'), t(`diagnostics.indexing.states.${indexing?.status ?? 'unavailable'}`)],
              [t('diagnostics.indexing.pending'), withLimit(indexing?.pending, indexing?.maxPending)],
              [t('diagnostics.indexing.active'), withLimit(indexing?.active, indexing?.maxActive)],
              [t('diagnostics.indexing.reconciling'), counter(indexing?.reconciling)],
              [t('diagnostics.indexing.reconciliationPending'), counter(indexing?.reconciliationPending)],
              [t('diagnostics.indexing.overflowed'), counter(indexing?.overflowed)],
              [t('diagnostics.indexing.failures'), counter(indexing?.failures)],
            ].map(([label, value]) => (
              <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{value}</dd></div>
            ))}
          </dl>
          <p className="text-muted-foreground">{t('diagnostics.indexing.scope')}</p>
          <p className="text-muted-foreground">{t('diagnostics.indexing.totals')}</p>
          {((indexing?.overflowed ?? 0) > 0 || (indexing?.failures ?? 0) > 0 || (indexing?.reconciliationPending ?? 0) > 0) && (
            <p>{t('diagnostics.indexing.recovery')}</p>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('diagnostics.eventLoop')} description={t('diagnostics.eventLoopDescription')}>
        <SettingsCard className="p-4 text-sm">
          {data.eventLoop.utilization === null ? t('diagnostics.unknown')
            : new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 1 }).format(data.eventLoop.utilization)}
        </SettingsCard>
      </SettingsSection>
      <p className="text-sm text-muted-foreground">{t('diagnostics.recovery.terminal')}</p>
    </div>
  );
}

function PaneDiagnostics({ data }: { data: OwnerPaneDiagnostics }) {
  const { t, i18n } = useTranslation('settings');
  const age = (ms: number | null) => ms === null ? t('diagnostics.unknown') : t('diagnostics.seconds', { count: Math.floor(ms / 1000) });
  const display = (value: unknown) => value === null || value === undefined || value === '' ? t('diagnostics.unknown') : String(value);
  return <section aria-label={t('diagnostics.panes.title')} data-state={data.panes.length ? 'ready' : 'empty'} className="space-y-4">
    <div><h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t('diagnostics.panes.title')}</h3><p className="mt-1 text-sm text-muted-foreground">{t('diagnostics.panes.description')}</p></div>
    <p className="text-xs text-muted-foreground">{t('diagnostics.panes.sample', { time: new Date(data.generatedAtMs).toLocaleTimeString(i18n.language), hostAge: age(data.host.ageMs), scanAge: age(data.collector.scanAgeMs), fullScanAge: age(data.collector.fullScanAgeMs) })}</p>
    <p className="text-sm text-muted-foreground">{t('diagnostics.panes.coverage', { inspected: data.coverage.rowsInspected, omitted: data.coverage.rowsOmitted })}</p>
    <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">{data.panes.map((pane) => <article key={`${pane.socketNumber}:${pane.paneId}`} aria-label={t('diagnostics.panes.card', { number: pane.paneNumber })} className="min-w-0 rounded-xl border border-border bg-card/50 p-4 space-y-3 [overflow-wrap:anywhere]"><h4 className="font-medium">{t('diagnostics.panes.card', { number: pane.paneNumber })}</h4><dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">{t('diagnostics.panes.socket')}</dt><dd>{pane.socketNumber}</dd></div><div><dt className="text-muted-foreground">{t('diagnostics.panes.process')}</dt><dd>{display(pane.panePid)}</dd></div></dl>{pane.observations.map((observation) => <div key={observation.lane} role="region" aria-label={t(`diagnostics.panes.${observation.lane}`)} data-freshness={observation.freshness} className="rounded-lg bg-muted/40 p-3 text-sm space-y-1"><h5 className="font-medium">{t(`diagnostics.panes.${observation.lane}`)}</h5><div data-diagnostic-field="binding">{t('diagnostics.panes.binding')}: {display(observation.binding.grade)}</div><div data-diagnostic-field="lineage">{t('diagnostics.panes.lineage')}: {observation.process.lineage.pids.length ? observation.process.lineage.pids.join(' → ') : t('diagnostics.unknown')}</div><div data-diagnostic-field="actionability">{t('diagnostics.panes.actionability')}: {display(observation.actionabilityReport)}</div><div data-diagnostic-field="connection-issue">{t('diagnostics.panes.connection')}: {display(observation.connectionIssue)}</div></div>)}</article>)}</div>
  </section>;
}

export default function DiagnosticsSettingsTab() {
  const { t } = useTranslation('settings');
  const [data, setData] = useState<OwnerDiagnostics | null>(null);
  const [panes, setPanes] = useState<OwnerPaneDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'owner' | 'unavailable' | null>(null);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    setLoading(true);
    setError(null);
    try {
      const [response, paneResponse] = await Promise.all([
        authenticatedFetch('/api/settings/diagnostics', { signal: controller.signal, cache: 'no-store' }),
        authenticatedFetch('/api/settings/diagnostics/panes', { signal: controller.signal, cache: 'no-store' }),
      ]);
      if (request.current !== controller) return;
      if (response.status === 401 || response.status === 403 || paneResponse.status === 401 || paneResponse.status === 403) {
        setData(null); setPanes(null); setError('owner'); return;
      }
      if (paneResponse.ok) { const paneResult = await paneResponse.json() as OwnerPaneDiagnostics; if (paneResult.schemaVersion === 1 && Array.isArray(paneResult.panes) && request.current === controller) setPanes(paneResult); }
      if (request.current !== controller) return;
      if (response.status === 401 || response.status === 403) {
        setData(null);
        setPanes(null);
        setError('owner');
        return;
      }
      if (!response.ok) throw new Error('diagnostics_unavailable');
      const result = await response.json() as OwnerDiagnostics;
      if (result.schemaVersion !== 1) throw new Error('diagnostics_unavailable');
      if (request.current === controller) setData(result);
    } catch {
      if (request.current === controller) {
        setData(null);
        setError('unavailable');
      }
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [refresh]);

  return (
    <SettingsSection title={t('diagnostics.title')} description={t('diagnostics.description')}>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          {t('diagnostics.refresh')}
        </Button>
        {loading && <p role="status" className="text-sm text-muted-foreground">{t('diagnostics.loading')}</p>}
      </div>
      {error && <p role="alert" className="py-2 text-sm">{t(`diagnostics.errors.${error}`)}</p>}
      {data && <DiagnosticsSummary data={data} />}
      {panes && <PaneDiagnostics data={panes} />}
    </SettingsSection>
  );
}
