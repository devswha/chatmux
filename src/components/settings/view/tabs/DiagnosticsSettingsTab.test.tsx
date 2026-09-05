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
    assert.doesNotMatch(html, /diagnostics\.|undefined/);
  } finally { await i18n.changeLanguage('en'); }
});
