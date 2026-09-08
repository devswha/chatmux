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

type PaneField = readonly [name: string, value: string | number | boolean, display?: string];

function PaneFields({ fields }: { fields: readonly PaneField[] }) {
  const { t, i18n } = useTranslation('settings');
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-3 text-sm sm:grid-cols-2">
      {fields.map(([name, value, display]) => (
        <div key={name} className="min-w-0" data-diagnostic-field={name} data-value={value}>
          <dt className="text-muted-foreground">{t('diagnostics.panes.fields.' + name)}</dt>
          <dd className="font-medium [overflow-wrap:anywhere]">
            {display ?? (typeof value === 'number'
              ? new Intl.NumberFormat(i18n.language).format(value)
              : t('diagnostics.panes.values.' + value, { defaultValue: t('diagnostics.panes.values.unknown') }))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

type DiagnosticRead<T> = { kind: 'ready'; data: T } | { kind: 'owner' | 'unavailable' };
type SectionState<T> = { data: T | null; loading: boolean; error: boolean };

async function readDiagnostics<T extends { schemaVersion: 1 }>(
  url: string, signal: AbortSignal, compatible: (data: T) => boolean,
): Promise<DiagnosticRead<T>> {
  const cancelled = new Promise<DiagnosticRead<T>>((resolve) => {
    signal.addEventListener('abort', () => resolve({ kind: 'unavailable' }), { once: true });
  });
  const read = async (): Promise<DiagnosticRead<T>> => {
    try {
      const response = await authenticatedFetch(url, { signal, cache: 'no-store' });
      if (response.status === 401 || response.status === 403) return { kind: 'owner' };
      if (!response.ok) return { kind: 'unavailable' };
      const data: T = await response.json();
      return data?.schemaVersion === 1 && compatible(data)
        ? { kind: 'ready', data } : { kind: 'unavailable' };
    } catch {
      // Network and JSON errors cross the API boundary; never expose raw error text.
      return { kind: 'unavailable' };
    }
  };
  return Promise.race([read(), cancelled]);
}

function PaneDiagnostics({ state }: { state: SectionState<OwnerPaneDiagnostics> }) {
  const { t, i18n } = useTranslation('settings');
  const { data, loading, error } = state;
  const age = (ms: number | null) => ms === null ? t('diagnostics.panes.values.unknown')
    : t('diagnostics.seconds', { count: Math.floor(ms / 1000) });
  const machineState = error || data?.collector.status === 'unavailable' || data?.collector.freshness === 'unavailable'
    ? 'unavailable'
    : data?.panes.length ? 'ready'
      : !data || data.collector.freshness === 'waiting' || Object.values(data.collector.lanes).some((lane) => lane.status === 'waiting')
        ? 'waiting'
        : Object.values(data.collector.lanes).some((lane) => lane.status !== 'ok') ? 'unavailable' : 'empty';
  return (
    <section aria-label={t('diagnostics.panes.title')} data-state={machineState} aria-busy={loading}
      className="min-w-0 space-y-4 break-keep [overflow-wrap:anywhere]">
      <SettingsSection title={t('diagnostics.panes.title')} description={t('diagnostics.panes.description')}>
        {loading && <p role="status" className="text-sm text-muted-foreground">{t('diagnostics.loading')}</p>}
        {!loading && machineState === 'waiting' && <p role="status" className="text-sm">{t('diagnostics.panes.waiting')}</p>}
        {machineState === 'unavailable' && <p role="alert" className="text-sm">{t('diagnostics.panes.unavailable')}</p>}
        {!loading && machineState === 'empty' && <p className="text-sm text-muted-foreground">{t('diagnostics.panes.empty')}</p>}
        {data && (
          <>
            <SettingsCard className="space-y-4 p-4">
              <PaneFields fields={[
                ['sample-time', data.generatedAtMs, new Date(data.generatedAtMs).toLocaleString(i18n.language)],
                ['cache-ttl', data.cacheTtlMs, age(data.cacheTtlMs)],
                ['stale-threshold', data.staleAfterMs, age(data.staleAfterMs)],
                ['collector-status', data.collector.status],
                ['scan-age', data.collector.scanAgeMs ?? 'unknown', age(data.collector.scanAgeMs)],
                ['full-scan-age', data.collector.fullScanAgeMs ?? 'unknown', age(data.collector.fullScanAgeMs)],
                ['collector-freshness', data.collector.freshness],
                ['host-age', data.host.ageMs ?? 'unknown', age(data.host.ageMs)],
                ['host-freshness', data.host.freshness], ['host-capture', data.host.capture],
                ['host-failure', data.host.failure ?? 'none'],
              ]} />
              <p className="text-xs text-muted-foreground">{t('diagnostics.panes.sampleNote')}</p>
              {(['external', 'live'] as const).map((lane) => (
                <div key={lane} className="space-y-3 rounded-lg bg-muted/40 p-3">
                  <h4 className="text-sm font-medium">{t('diagnostics.lanes.' + lane)}</h4>
                  <PaneFields fields={[
                    ['lane-status', data.collector.lanes[lane].status, t('diagnostics.laneStates.' + data.collector.lanes[lane].status)],
                    ['lane-rows', data.collector.lanes[lane].rows],
                    ['lane-stale-rows', data.collector.lanes[lane].staleRows],
                    ['lane-failures', data.collector.lanes[lane].consecutiveFailures],
                  ]} />
                </div>
              ))}
              {data.host.sockets.map((socket) => (
                <div key={socket.slot} className="rounded-lg bg-muted/40 p-3">
                  <PaneFields fields={[
                    ['socket-slot', socket.slot], ['socket-capture', socket.capture],
                    ['socket-reason', socket.reason ?? 'none'], ['socket-pane-count', socket.paneCount],
                  ]} />
                </div>
              ))}
              <PaneFields fields={[
                ['total-rows', data.coverage.totalRows ?? 'unknown'], ['rows-inspected', data.coverage.rowsInspected],
                ['rows-omitted', data.coverage.rowsOmitted], ['invalid-rows-omitted', data.coverage.invalidRowsOmitted],
                ['host-panes-omitted', data.coverage.hostPanesOmitted], ['host-processes-omitted', data.coverage.hostProcessesOmitted],
                ['counts-capped', data.coverage.countsCapped],
                ['limit-discovery-rows', data.limits.discoveryRows], ['limit-host-panes', data.limits.hostPanes],
                ['limit-host-processes', data.limits.hostProcesses], ['limit-lineage-pids', data.limits.lineagePids],
              ]} />
            </SettingsCard>
            <p className="text-xs text-muted-foreground">{t('diagnostics.panes.identityNote')}</p>
            <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
              {data.panes.map((pane) => (
                <article key={pane.paneNumber} aria-label={t('diagnostics.panes.card', { number: pane.paneNumber })}
                  className="min-w-0 space-y-4 rounded-xl border border-border bg-card/50 p-4">
                  <h4 className="font-medium">{t('diagnostics.panes.card', { number: pane.paneNumber })}</h4>
                  <PaneFields fields={[
                    ['socket', pane.socketNumber], ['capture-slot', pane.captureSlot ?? 'unknown'],
                    ['session', pane.sessionId, pane.sessionId], ['window', pane.windowId, pane.windowId],
                    ['pane', pane.paneId, pane.paneId], ['pane-pid', pane.panePid ?? 'unknown'],
                  ]} />
                  {pane.observations.map((observation) => (
                    <div key={observation.lane} role="region" aria-label={t('diagnostics.panes.' + observation.lane)}
                      data-freshness={observation.freshness} className="min-w-0 space-y-3 rounded-lg bg-muted/40 p-3">
                      <h5 className="text-sm font-medium">{t('diagnostics.panes.' + observation.lane)}</h5>
                      <PaneFields fields={[
                        ['provider', observation.provider], ['presence', observation.presence],
                        ['freshness', observation.freshness], ['activity', observation.activity],
                        ['binding', observation.binding.grade], ['provider-session', observation.binding.providerSessionReported],
                        ['agent-pid', observation.process.agentPid ?? 'unknown'], ['generation', observation.process.generation],
                        ['lineage', observation.process.lineage.relation], ['lineage-reason', observation.process.lineage.reason ?? 'none'],
                        ['lineage-pids', observation.process.lineage.pids.join(','), observation.process.lineage.pids.length
                          ? observation.process.lineage.pids.join(' → ') : t('diagnostics.panes.values.unknown')],
                        ['actionability', observation.actionabilityReport], ['connection-issue', observation.connectionIssue ?? 'none'],
                      ]} />
                    </div>
                  ))}
                </article>
              ))}
            </div>
          </>
        )}
      </SettingsSection>
    </section>
  );
}

export default function DiagnosticsSettingsTab() {
  const { t } = useTranslation('settings');
  const [aggregate, setAggregate] = useState<SectionState<OwnerDiagnostics>>({ data: null, loading: true, error: false });
  const [panes, setPanes] = useState<SectionState<OwnerPaneDiagnostics>>({ data: null, loading: true, error: false });
  const [ownerDenied, setOwnerDenied] = useState(false);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let denied = false;
    setOwnerDenied(false);
    setAggregate((previous) => ({ ...previous, loading: true, error: false }));
    setPanes((previous) => ({ ...previous, loading: true, error: false }));
    const publish = <T,>(result: DiagnosticRead<T>, update: (state: SectionState<T>) => void) => {
      if (request.current !== controller || denied) return;
      if (result.kind === 'owner') {
        denied = true;
        setOwnerDenied(true);
        setAggregate({ data: null, loading: false, error: false });
        setPanes({ data: null, loading: false, error: false });
        controller.abort();
        return;
      }
      update({ data: result.kind === 'ready' ? result.data : null, loading: false, error: result.kind === 'unavailable' });
    };
    try {
      await Promise.all([
        readDiagnostics<OwnerDiagnostics>('/api/settings/diagnostics', controller.signal,
          (data) => Boolean(data.collector && data.gjcWatcher && data.eventLoop))
          .then((result) => publish(result, setAggregate)),
        readDiagnostics<OwnerPaneDiagnostics>('/api/settings/diagnostics/panes', controller.signal,
          (data) => Boolean(Array.isArray(data.panes) && data.collector && data.host && data.coverage && data.limits))
          .then((result) => publish(result, setPanes)),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [refresh]);

  const loading = aggregate.loading || panes.loading;
  return (
    <SettingsSection title={t('diagnostics.title')} description={t('diagnostics.description')}>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          {t('diagnostics.refresh')}
        </Button>
        {aggregate.loading && <p role="status" className="text-sm text-muted-foreground">{t('diagnostics.loading')}</p>}
      </div>
      {ownerDenied && <p role="alert" data-diagnostic-error="owner" className="py-2 text-sm">{t('diagnostics.errors.owner')}</p>}
      {aggregate.error && <p role="alert" className="py-2 text-sm">{t('diagnostics.errors.unavailable')}</p>}
      {aggregate.data && <DiagnosticsSummary data={aggregate.data} />}
      {!ownerDenied && <PaneDiagnostics state={panes} />}
    </SettingsSection>
  );
}
