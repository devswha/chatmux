import assert from 'node:assert/strict';
import test from 'node:test';

import { I18nextProvider } from 'react-i18next';
import TestRenderer, { act } from 'react-test-renderer';

import DiagnosticsSettingsTab, { DiagnosticsSummary } from './DiagnosticsSettingsTab';
import { deferred, i18n, paneSummary, summary } from './diagnostics.testSupport';

test('mounted settings loads once, refreshes only the cached GET, and clears data on owner denial', async (context) => {
  const calls: { url: string; options?: RequestInit }[] = [];
  let response = new Response(JSON.stringify(summary()));
  context.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    return url.endsWith('/panes') && response.status === 200
      ? new Response(JSON.stringify(paneSummary()))
      : response;
  });
  let tree: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<I18nextProvider i18n={i18n}><DiagnosticsSettingsTab /></I18nextProvider>); });
  context.after(() => { act(() => tree.unmount()); });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/settings/diagnostics');
  assert.equal(calls[1].url, '/api/settings/diagnostics/panes');
  assert.equal(calls[0].options?.cache, 'no-store');
  assert.equal(calls[0].options?.credentials, 'same-origin');
  assert.equal(calls[0].options?.method, undefined);
  assert.match(JSON.stringify(tree!.toJSON()), /4 cached rows/);
  assert.match(JSON.stringify(tree!.toJSON()), /12 \/ 448/);
  response = new Response('PRIVATE_ERROR token', { status: 403 });
  await act(async () => { tree.root.findByType('button').props.onClick(); });
  assert.equal(calls.length, 4);
  assert.match(JSON.stringify(tree!.toJSON()), /Sign in as this server/);
  assert.doesNotMatch(JSON.stringify(tree!.toJSON()), /4 cached rows|12 \/ 448|PRIVATE_ERROR/);
});

test('network and unsupported response failures are generic and refresh can recover', async (context) => {
  let mode: 'failure' | 'unsupported' | 'success' = 'failure';
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    if (mode === 'failure') throw new Error('PRIVATE_ERROR /home/secret token');
    if (url.endsWith('/panes')) return new Response(JSON.stringify(paneSummary()));
    return new Response(JSON.stringify(mode === 'unsupported' ? { schemaVersion: 2 } : summary()));
  });
  let tree: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<I18nextProvider i18n={i18n}><DiagnosticsSettingsTab /></I18nextProvider>); });
  context.after(() => { act(() => tree.unmount()); });
  for (const next of ['unsupported', 'success'] as const) {
    assert.match(JSON.stringify(tree!.toJSON()), /Diagnostics could not be read/);
    assert.doesNotMatch(JSON.stringify(tree!.toJSON()), /PRIVATE_ERROR|\/home\/secret/);
    mode = next;
    await act(async () => { tree.root.findByType('button').props.onClick(); });
  }
  assert.match(JSON.stringify(tree!.toJSON()), /4 cached rows/);
  assert.doesNotMatch(JSON.stringify(tree!.toJSON()), /Diagnostics could not be read/);
});

test('loading disables refresh and closing settings aborts the pending request', async (context) => {
  let signal: AbortSignal | undefined;
  context.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    signal = options.signal ?? undefined;
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  let tree: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<I18nextProvider i18n={i18n}><DiagnosticsSettingsTab /></I18nextProvider>); });
  assert.equal(tree!.root.findByType('button').props.disabled, true);
  assert.equal(tree!.root.findAllByProps({ role: 'status' }).length, 2);
  await act(async () => { tree.unmount(); });
  assert.equal(signal?.aborted, true);
});

const tab = () => <I18nextProvider i18n={i18n}><DiagnosticsSettingsTab /></I18nextProvider>;
const paneRegion = (tree: TestRenderer.ReactTestRenderer) => tree.root.findByProps({ 'aria-label': 'Pane diagnostics' });
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body));

test('pane cards expose complete bounded cached evidence with distinct sockets and lanes, not raw fields or controls', async (context) => {
  const panes = paneSummary();
  const first = panes.panes[0];
  const observation = first.observations[0];
  first.observations.push({
    ...observation, lane: 'live', provider: 'gjc', presence: 'stale', freshness: 'stale',
    binding: { grade: 'inferred', providerSessionReported: false },
    actionabilityReport: 'reported_false', connectionIssue: 'transcript_ambiguous',
    process: { agentPid: null, generation: 'unknown', lineage: { relation: 'unknown', reason: 'ancestry_limit', pids: [] } },
  });
  panes.panes.push({ ...first, paneNumber: 2, socketNumber: 2, captureSlot: null, observations: [{
    ...observation, freshness: 'unknown', binding: { grade: 'unknown', providerSessionReported: false },
    process: { agentPid: 200, generation: 'unknown', lineage: { relation: 'unknown', reason: 'sample_predates_generation', pids: [] } },
  }] });
  const sentinel = 'PRIVATE_DIAGNOSTIC_SENTINEL';
  Object.assign(panes, { rawSocketPath: sentinel, error: sentinel });
  Object.assign(first, { sessionName: sentinel, cwd: sentinel, inventoryKey: sentinel });
  Object.assign(observation, { argv: sentinel, transcriptPath: sentinel, providerSessionId: sentinel, credentials: sentinel });
  Object.assign(observation.process, { generationString: sentinel, startTime: sentinel });
  context.mock.method(globalThis, 'fetch', async (url: string) => jsonResponse(url.endsWith('/panes') ? panes : summary()));
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(tab()); });
  context.after(() => { act(() => tree.unmount()); });
  const region = paneRegion(tree);
  const cards = region.findAllByType('article');
  assert.deepEqual(cards.map((card) => card.props['aria-label']), ['Pane 1', 'Pane 2']);
  const field = (node: TestRenderer.ReactTestInstance, name: string) => node.findByProps({ 'data-diagnostic-field': name }).props['data-value'];
  for (const [name, value] of Object.entries({
    'sample-time': 100_000, 'host-age': 42_000, 'scan-age': 1_000, 'full-scan-age': 8_000,
    'collector-status': 'available', 'cache-ttl': 2_000, 'stale-threshold': 30_000,
    'host-freshness': 'stale', 'host-capture': 'partial', 'host-failure': 'none',
    'total-rows': 1_002, 'rows-inspected': 1_000, 'rows-omitted': 2, 'invalid-rows-omitted': 3,
    'host-panes-omitted': 4, 'host-processes-omitted': 5, 'counts-capped': true,
    'limit-discovery-rows': 1_000, 'limit-host-panes': 1_000, 'limit-host-processes': 8_192, 'limit-lineage-pids': 32,
  })) assert.equal(field(region, name), value, name);
  assert.deepEqual(region.findAllByProps({ 'data-diagnostic-field': 'lane-status' }).map((node) => node.props['data-value']), ['ok', 'ok']);
  assert.deepEqual(region.findAllByProps({ 'data-diagnostic-field': 'lane-rows' }).map((node) => node.props['data-value']), [4, 2]);
  assert.deepEqual(region.findAllByProps({ 'data-diagnostic-field': 'lane-stale-rows' }).map((node) => node.props['data-value']), [1, 0]);
  assert.deepEqual(region.findAllByProps({ 'data-diagnostic-field': 'lane-failures' }).map((node) => node.props['data-value']), [0, 0]);
  assert.deepEqual(region.findAllByProps({ 'data-diagnostic-field': 'socket-capture' }).map((node) => node.props['data-value']), ['ok', 'unavailable']);
  assert.deepEqual(region.findAllByProps({ 'data-diagnostic-field': 'socket-reason' }).map((node) => node.props['data-value']), ['none', 'socket_unavailable']);
  for (const [name, value] of Object.entries({ socket: 1, 'capture-slot': 1, session: '$0', window: '@0', pane: '%0', 'pane-pid': 100 })) {
    assert.equal(field(cards[0], name), value, name);
  }
  assert.equal(field(cards[1], 'socket'), 2);
  assert.equal(field(cards[1], 'capture-slot'), 'unknown');
  const external = cards[0].findByProps({ 'aria-label': 'External observation' });
  assert.equal(external.props['data-freshness'], 'fresh');
  for (const [name, value] of Object.entries({
    provider: 'codex', presence: 'present', freshness: 'fresh', activity: 'waiting_user', binding: 'observed',
    'provider-session': true, 'agent-pid': 200, generation: 'recorded', lineage: 'descendant',
    'lineage-reason': 'none', 'lineage-pids': '100,150,200', actionability: 'unknown', 'connection-issue': 'none',
  })) assert.equal(field(external, name), value, name);
  const live = cards[0].findByProps({ 'aria-label': 'Live observation' });
  assert.equal(live.props['data-freshness'], 'stale');
  for (const [name, value] of Object.entries({ binding: 'inferred', 'provider-session': false, lineage: 'unknown',
    'lineage-reason': 'ancestry_limit', 'lineage-pids': '', actionability: 'reported_false', 'connection-issue': 'transcript_ambiguous',
  })) assert.equal(field(live, name), value, name);
  assert.equal(cards[1].findByProps({ 'aria-label': 'External observation' }).props['data-freshness'], 'unknown');
  assert.equal(tree.root.findAllByType('button').length, 1);
  assert.equal(region.findAllByType('a').length, 0);
  assert.doesNotMatch(JSON.stringify(tree.toJSON()), /PRIVATE_DIAGNOSTIC_SENTINEL|\[object Object\]/);
});

for (const endpoint of ['aggregate', 'panes'] as const) {
  for (const failure of ['network', '404', '503', 'parse', 'unsupported'] as const) {
    test(`${endpoint} ${failure} clears only its previous data and refresh recovers`, async (context) => {
      let failing = false;
      context.mock.method(globalThis, 'fetch', async (url: string) => {
        const isPane = url.endsWith('/panes');
        if (failing && isPane === (endpoint === 'panes')) {
          switch (failure) {
            case 'network': throw new Error('PRIVATE_DIAGNOSTIC_SENTINEL');
            case '404': case '503': return new Response('PRIVATE_DIAGNOSTIC_SENTINEL', { status: Number(failure) });
            case 'parse': return new Response('PRIVATE_DIAGNOSTIC_SENTINEL');
            case 'unsupported': return jsonResponse({ schemaVersion: 2 });
          }
        }
        return jsonResponse(isPane ? paneSummary() : summary());
      });
      let tree!: TestRenderer.ReactTestRenderer;
      await act(async () => { tree = TestRenderer.create(tab()); });
      context.after(() => { act(() => tree.unmount()); });
      failing = true;
      await act(async () => { tree.root.findByType('button').props.onClick(); });
      assert.equal(tree.root.findAllByType(DiagnosticsSummary).length, endpoint === 'panes' ? 1 : 0);
      assert.equal(paneRegion(tree).props['data-state'], endpoint === 'panes' ? 'unavailable' : 'ready');
      assert.equal(paneRegion(tree).findAllByType('article').length, endpoint === 'panes' ? 0 : 1);
      assert.equal(tree.root.findAllByProps({ role: 'alert' }).length, 1);
      assert.doesNotMatch(JSON.stringify(tree.toJSON()), /PRIVATE_DIAGNOSTIC_SENTINEL/);
      failing = false;
      await act(async () => { tree.root.findByType('button').props.onClick(); });
      assert.equal(tree.root.findAllByType(DiagnosticsSummary).length, 1);
      assert.equal(paneRegion(tree).props['data-state'], 'ready');
      assert.equal(tree.root.findAllByProps({ role: 'alert' }).length, 0);
    });
  }
  for (const status of [401, 403]) {
    for (const peer of ['reject', 'success'] as const) {
      test(`${endpoint} ${status} clears both datasets when peer ${peer}`, async (context) => {
        let denied = false;
        context.mock.method(globalThis, 'fetch', async (url: string) => {
          const isPane = url.endsWith('/panes');
          if (denied) {
            if (isPane === (endpoint === 'panes')) return new Response('PRIVATE_DIAGNOSTIC_SENTINEL', { status });
            if (peer === 'reject') throw new Error('PRIVATE_DIAGNOSTIC_SENTINEL');
          }
          return jsonResponse(isPane ? paneSummary() : summary());
        });
        let tree!: TestRenderer.ReactTestRenderer;
        await act(async () => { tree = TestRenderer.create(tab()); });
        context.after(() => { act(() => tree.unmount()); });
        denied = true;
        await act(async () => { tree.root.findByType('button').props.onClick(); });
        assert.equal(tree.root.findAllByType(DiagnosticsSummary).length, 0);
        assert.equal(tree.root.findAllByType('article').length, 0);
        assert.equal(tree.root.findAllByProps({ 'data-diagnostic-error': 'owner' }).length, 1);
        assert.doesNotMatch(JSON.stringify(tree.toJSON()), /PRIVATE_DIAGNOSTIC_SENTINEL/);
      });
    }
  }
}

for (const state of ['empty', 'waiting', 'unavailable', 'ready'] as const) {
  test(`pane section distinguishes ${state}`, async (context) => {
    const panes = paneSummary();
    if (state !== 'ready') panes.panes = [];
    if (state === 'waiting') {
      panes.collector.freshness = 'waiting';
      panes.collector.lanes.external.status = 'waiting';
      panes.collector.lanes.live.status = 'waiting';
    }
    if (state === 'unavailable') {
      panes.collector.status = 'unavailable';
      panes.collector.freshness = 'unavailable';
    }
    context.mock.method(globalThis, 'fetch', async (url: string) => jsonResponse(url.endsWith('/panes') ? panes : summary()));
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => { tree = TestRenderer.create(tab()); });
    context.after(() => { act(() => tree.unmount()); });
    assert.equal(paneRegion(tree).props['data-state'], state);
    if (state === 'unavailable') assert.equal(paneRegion(tree).findAllByProps({ role: 'alert' }).length, 1);
    if (state === 'waiting') assert.equal(paneRegion(tree).findAllByProps({ role: 'status' }).length, 1);
  });
}

test('cold pane loading is scoped; rerenders issue no requests; unmount aborts both', { timeout: 2_000 }, async (context) => {
  const calls: RequestInit[] = [];
  const pending = deferred<Response>();
  context.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => {
    calls.push(options);
    return pending.promise;
  });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(tab()); });
  context.after(() => { act(() => tree.unmount()); });
  assert.equal(paneRegion(tree).props['data-state'], 'waiting');
  assert.equal(paneRegion(tree).findAllByProps({ role: 'status' }).length, 1);
  assert.equal(tree.root.findByType('button').props.disabled, true);
  await act(async () => { tree.update(tab()); });
  assert.equal(calls.length, 2);
  for (const options of calls) {
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.method ?? 'GET', 'GET');
  }
  await act(async () => { tree.unmount(); });
  assert.ok(calls.every((options) => options.signal?.aborted));
  await act(async () => { pending.resolve(jsonResponse(paneSummary())); });
  assert.equal(tree.toJSON(), null);
});

for (const seam of ['request', 'body'] as const) {
  test(`late ${seam} from superseded refresh cannot overwrite new sample`, { timeout: 2_000 }, async (context) => {
    const pending = deferred<Response>();
    const body = deferred<unknown>();
    const started = deferred<void>();
    let first = true;
    context.mock.method(globalThis, 'fetch', (url: string) => {
      if (first && url.endsWith('/panes')) {
        if (seam === 'request') { started.resolve(); return pending.promise; }
        const response = jsonResponse({});
        context.mock.method(response, 'json', () => { started.resolve(); return body.promise; });
        return Promise.resolve(response);
      }
      const panes = paneSummary();
      panes.panes[0].panePid = 999;
      return Promise.resolve(jsonResponse(url.endsWith('/panes') ? panes : summary()));
    });
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => { tree = TestRenderer.create(tab()); await started.promise; });
    context.after(() => { act(() => tree.unmount()); });
    first = false;
    await act(async () => { tree.root.findByType('button').props.onClick(); });
    const before = JSON.stringify(tree.toJSON());
    await act(async () => {
      pending.resolve(jsonResponse(paneSummary()));
      body.resolve(paneSummary());
    });
    assert.equal(JSON.stringify(tree.toJSON()), before);
  });
}

for (const endpoint of ['aggregate', 'panes'] as const) {
  for (const seam of ['request', 'body'] as const) {
    test(`${endpoint} pending ${seam} expires at deadline without discarding the completed peer or accepting late data`, { timeout: 2_000 }, async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const pending = deferred<Response>();
      const body = deferred<unknown>();
      const started = deferred<void>();
      context.mock.method(globalThis, 'fetch', (url: string) => {
        if (url.endsWith('/panes') === (endpoint === 'panes')) {
          if (seam === 'request') { started.resolve(); return pending.promise; }
          const response = jsonResponse({});
          context.mock.method(response, 'json', () => { started.resolve(); return body.promise; });
          return Promise.resolve(response);
        }
        return Promise.resolve(jsonResponse(url.endsWith('/panes') ? paneSummary() : summary()));
      });
      let tree!: TestRenderer.ReactTestRenderer;
      await act(async () => { tree = TestRenderer.create(tab()); await started.promise; });
      context.after(() => { act(() => tree.unmount()); });
      assert.equal(tree.root.findAllByType(DiagnosticsSummary).length, endpoint === 'panes' ? 1 : 0);
      assert.equal(paneRegion(tree).props['aria-busy'], endpoint === 'panes');
      await act(async () => { context.mock.timers.tick(9_999); });
      assert.equal(tree.root.findByType('button').props.disabled, true);
      await act(async () => { context.mock.timers.tick(1); });
      assert.equal(tree.root.findByType('button').props.disabled, false);
      assert.equal(tree.root.findAllByType(DiagnosticsSummary).length, endpoint === 'panes' ? 1 : 0);
      assert.equal(paneRegion(tree).props['data-state'], endpoint === 'panes' ? 'unavailable' : 'ready');
      const before = JSON.stringify(tree.toJSON());
      await act(async () => {
        pending.resolve(jsonResponse(endpoint === 'panes' ? paneSummary() : summary()));
        body.resolve(endpoint === 'panes' ? paneSummary() : summary());
      });
      assert.equal(JSON.stringify(tree.toJSON()), before);
    });
  }
  test(`${endpoint} denial during peer body read clears both and ignores the late body`, { timeout: 2_000 }, async (context) => {
    const denied = deferred<Response>();
    const body = deferred<unknown>();
    const started = deferred<void>();
    context.mock.method(globalThis, 'fetch', (url: string) => {
      if (url.endsWith('/panes') === (endpoint === 'panes')) return denied.promise;
      const response = jsonResponse({});
      context.mock.method(response, 'json', () => { started.resolve(); return body.promise; });
      return Promise.resolve(response);
    });
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => { tree = TestRenderer.create(tab()); await started.promise; });
    context.after(() => { act(() => tree.unmount()); });
    await act(async () => { denied.resolve(new Response(null, { status: 403 })); });
    assert.equal(tree.root.findAllByProps({ 'data-diagnostic-error': 'owner' }).length, 1);
    assert.equal(tree.root.findAllByType(DiagnosticsSummary).length, 0);
    assert.equal(tree.root.findAllByType('article').length, 0);
    const before = JSON.stringify(tree.toJSON());
    await act(async () => { body.resolve(endpoint === 'panes' ? summary() : paneSummary()); });
    assert.equal(JSON.stringify(tree.toJSON()), before);
  });
}

test('unmount aborts pending body reads and never reads their late data', { timeout: 2_000 }, async (context) => {
  const bodies = [deferred<unknown>(), deferred<unknown>()];
  const signals: AbortSignal[] = [];
  let bodyReads = 0;
  const started = deferred<void>();
  context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    if (options.signal) signals.push(options.signal);
    const response = jsonResponse({});
    context.mock.method(response, 'json', () => {
      bodyReads += 1;
      if (bodyReads === 2) started.resolve();
      return bodies[url.endsWith('/panes') ? 1 : 0].promise;
    });
    return response;
  });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(tab()); await started.promise; });
  await act(async () => { tree.unmount(); });
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
  await act(async () => { bodies[0].resolve(summary()); bodies[1].resolve(paneSummary()); });
  assert.equal(tree.toJSON(), null);
});

test('pane lineage reasons render localized visible values, including unknowns and maximum PID chains', async (context) => {
  const panes = paneSummary();
  const observation = panes.panes[0].observations[0];
  const reasons = ['host_unavailable', 'pane_not_observed', 'process_not_recorded', 'process_not_observed',
    'sample_predates_generation', 'ancestry_incomplete', 'ancestry_cycle', 'ancestry_limit', 'not_in_pane_chain'] as const;
  panes.panes = reasons.map((reason, index) => ({
    ...panes.panes[0], paneNumber: index + 1,
    observations: [{
      ...observation, binding: { grade: index === 0 ? 'tagged' : 'unknown', providerSessionReported: false },
      actionabilityReport: index === 0 ? 'reported_true' : 'unknown',
      process: { agentPid: null, generation: 'unknown', lineage: { relation: 'unknown', reason, pids: [] } },
    }],
  }));
  panes.panes.push({ ...panes.panes[0], paneNumber: 10, observations: [{ ...observation,
    process: { agentPid: 2_147_483_647, generation: 'recorded', lineage: {
      relation: 'descendant', reason: null, pids: Array.from({ length: 32 }, (_, index) => 2_147_483_616 + index),
    } },
  }] });
  panes.host.ageMs = null;
  panes.host.freshness = 'unavailable';
  panes.host.capture = 'failed';
  panes.host.failure = 'capture_failed';
  panes.coverage.totalRows = null;
  context.mock.method(globalThis, 'fetch', async (url: string) => jsonResponse(url.endsWith('/panes') ? panes : summary()));
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(tab()); });
  context.after(() => { act(() => tree.unmount()); });
  for (const language of ['en', 'ko']) {
    await act(async () => { await i18n.changeLanguage(language); });
    try {
      const fields = tree.root.findAll((node) => typeof node.props['data-diagnostic-field'] === 'string');
      for (const field of fields) {
        const value: unknown = field.props['data-value'];
        if (typeof value === 'string' && i18n.exists('diagnostics.panes.values.' + value, { ns: 'settings' })) {
          const prefix = field.props['data-diagnostic-field'] === 'lane-status' ? 'diagnostics.laneStates.' : 'diagnostics.panes.values.';
          assert.equal(field.findByType('dd').children.join(''), i18n.t(prefix + value, { ns: 'settings' }));
        }
      }
      assert.equal(tree.root.findAllByType('article').length, 10);
      assert.equal(tree.root.findAllByProps({ 'data-diagnostic-field': 'lineage-reason' }).length, 10);
      assert.doesNotMatch(JSON.stringify(tree.toJSON()), /diagnostics\.panes\.|undefined|NaN/);
    } finally { await act(async () => { await i18n.changeLanguage('en'); }); }
  }
});


test('manual refresh updates indexing counters without polling or starting mutations', async (context) => {
  let calls = 0;
  const data = summary();
  context.mock.method(globalThis, 'fetch', async (_url: string, options?: RequestInit) => {
    calls += 1;
    assert.equal(options?.method, undefined);
    return new Response(JSON.stringify(data));
  });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<I18nextProvider i18n={i18n}><DiagnosticsSettingsTab /></I18nextProvider>); });
  context.after(() => { act(() => tree.unmount()); });
  assert.match(JSON.stringify(tree.toJSON()), /12 \/ 448/);
  data.indexing.pending = 40;
  await act(async () => { tree.update(<I18nextProvider i18n={i18n}><DiagnosticsSettingsTab /></I18nextProvider>); });
  assert.equal(calls, 2);
  assert.match(JSON.stringify(tree.toJSON()), /12 \/ 448/);
  await act(async () => { tree.root.findByType('button').props.onClick(); });
  assert.equal(calls, 4);
  assert.match(JSON.stringify(tree.toJSON()), /40 \/ 448/);
  assert.equal(tree.root.findAllByType('button').length, 1, 'refresh is the only control');
});
