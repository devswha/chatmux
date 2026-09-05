import assert from 'node:assert/strict';
import test from 'node:test';

import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';

import type { OwnerDiagnostics } from '../../../../../shared/diagnostics';
import enSettings from '../../../../i18n/locales/en/settings.json';
import SettingsSidebar from '../SettingsSidebar';

import { DiagnosticsSummary } from './DiagnosticsSettingsTab';
import { i18n, summary } from './diagnostics.testSupport';

function renderSummary(data: OwnerDiagnostics) {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}><DiagnosticsSummary data={data} /></I18nextProvider>);
}

test('normal summary renders sample age, both lanes, liveness limits, and terminal guidance', () => {
  const html = renderSummary(summary());
  for (const text of [
    'Summary captured at', 'External CLI sessions', 'Live GJC sessions',
    '4 cached rows', '1 marked stale', '25%', 'No failures reported',
    'does not prove that the watcher is running', 'verified terminal attach',
    'Transcript indexing', 'Accepting work', '12 / 448', '3 / 4',
    'Active reconciliation steps', 'Overflow events (total)', 'Indexing failures (total)',
    'Initial bulk synchronization is excluded', 'idle or paused during startup',
  ]) assert.ok(html.includes(text), text);
  assert.ok(html.includes('grid-cols-1') && html.includes('sm:grid-cols-2'), 'single-column cards on small screens');
  assert.doesNotMatch(html, /diagnostics\.(?:recovery|lanes|watcherStates|modes)/);
});

test('degraded discovery, retained reasons, and watch limits render useful recovery without action controls', () => {
  const data = summary();
  data.collector.freshness = 'stale';
  data.collector.lanes.external = { status: 'failing', consecutiveFailures: 3, rows: 4, staleRows: 1 };
  data.collector.rowsTruncated = true;
  data.collector.connectionIssues = [{ code: 'transcript_ambiguous', count: 2 }];
  data.gjcWatcher = { status: 'degraded', consecutiveFailures: 20, watchLimitObserved: true };
  const html = renderSummary(data);
  for (const text of ['Older than 30 seconds', '3 consecutive failures', 'chatmux status', 'Transcript is ambiguous (2)', 'inotify', 'first 1,000']) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /<button/);
});

test('waiting and unavailable signals do not display successful discovery or watcher liveness', () => {
  const data = summary();
  data.collector.freshness = 'waiting';
  data.collector.scanAgeMs = null;
  data.collector.fullScanAgeMs = null;
  data.collector.lanes.external.status = 'waiting';
  data.collector.lanes.live.status = 'waiting';
  data.gjcWatcher.status = 'unavailable';
  assert.match(renderSummary(data), /Open the session list/);
  data.collector.status = 'unavailable';
  data.collector.freshness = 'unavailable';
  data.eventLoop.utilization = null;
  const html = renderSummary(data);
  assert.match(html, /Watcher status unavailable/);
  assert.match(html, /chatmux status/);
  assert.doesNotMatch(html, /Last scan succeeded|No failures reported/);
});

test('diagnostics navigation is owner-only in desktop and mobile settings', () => {
  for (const owner of [false, true]) {
    const html = renderToStaticMarkup(<I18nextProvider i18n={i18n}>
      <SettingsSidebar activeTab="diagnostics" onChange={() => undefined} fleetOwner={owner} />
    </I18nextProvider>);
    assert.equal((html.match(/Diagnostics/g) ?? []).length, owner ? 2 : 0);
  }
});

test('Korean summary and all connection recovery codes are translated', async () => {
  await i18n.changeLanguage('ko');
  try {
    const data = summary();
    data.collector.connectionIssues = Object.keys(enSettings.diagnostics.reasons).map((code) => ({
      code: code as OwnerDiagnostics['collector']['connectionIssues'][number]['code'], count: 1,
    }));
    const html = renderSummary(data);
    assert.match(html, /세션 탐색/);
    assert.match(html, /대화 기록 접근 거부/);
    assert.match(html, /대화 기록 인덱싱/);
    assert.match(html, /작업 접수 가능/);
    assert.match(html, /큐 초과 이벤트 \(누적\)/);
    assert.match(html, /최초 일괄 동기화는 집계에서 제외/);
    assert.doesNotMatch(html, /diagnostics\.|undefined/);
  } finally { await i18n.changeLanguage('en'); }
});


test('indexing admission, missing counters, and older responses never imply active liveness', () => {
  const data = summary();
  data.indexing = {
    status: 'closed', pending: 0, active: 0, maxPending: 448, maxActive: 4,
    reconciling: 0, reconciliationPending: 0, overflowed: 0, failures: 0,
  };
  const closed = renderSummary(data);
  assert.match(closed, /Queue closed/);
  assert.match(closed, /0 \/ 448/);
  assert.match(closed, /does not establish watcher or agent liveness/);
  assert.doesNotMatch(closed, /Accepting work/);
  data.indexing.status = 'unavailable';
  data.indexing.pending = null;
  data.indexing.maxPending = null;
  data.indexing.active = null;
  assert.match(renderSummary(data), /Unavailable \/ Unavailable/);
  // An older schema-v1 server can lack the additive indexing object entirely.
  const legacy = { ...data, indexing: undefined } as unknown as OwnerDiagnostics;
  const unknown = renderSummary(legacy);
  assert.match(unknown, /Queue status unavailable/);
  assert.doesNotMatch(unknown, /NaN|undefined|Accepting work|Queue closed/);
});

test('indexing recovery guidance and totals are readable without action controls or private diagnostics', () => {
  const data = summary();
  data.indexing.overflowed = 1_000_000;
  data.indexing.failures = 8;
  const html = renderSummary(data);
  assert.match(html, /1,000,000/);
  assert.match(html, /Totals reset with the scheduler/);
  assert.match(html, /unavailable values do not mean zero/);
  assert.match(html, /Overflow schedules reconciliation/);
  assert.match(html, /Keep existing tmux work running/);
  assert.doesNotMatch(html, /<button|diagnostics\.indexing/);
});
