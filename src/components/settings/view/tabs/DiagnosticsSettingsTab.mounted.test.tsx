import assert from 'node:assert/strict';
import test from 'node:test';

import { I18nextProvider } from 'react-i18next';
import TestRenderer, { act } from 'react-test-renderer';

import DiagnosticsSettingsTab from './DiagnosticsSettingsTab';
import { i18n, summary } from './diagnostics.testSupport';

test('mounted settings loads once, refreshes only the cached GET, and clears data on owner denial', async (context) => {
  const calls: { url: string; options?: RequestInit }[] = [];
  let response = new Response(JSON.stringify(summary()));
  context.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    return response;
  });
  let tree: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<I18nextProvider i18n={i18n}><DiagnosticsSettingsTab /></I18nextProvider>); });
  context.after(() => { act(() => tree.unmount()); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/settings/diagnostics');
  assert.equal(calls[0].options?.cache, 'no-store');
  assert.equal(calls[0].options?.credentials, 'same-origin');
  assert.equal(calls[0].options?.method, undefined);
  assert.match(JSON.stringify(tree!.toJSON()), /4 cached rows/);
  response = new Response('PRIVATE_ERROR token', { status: 403 });
  await act(async () => { tree.root.findByType('button').props.onClick(); });
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(tree!.toJSON()), /Sign in as this server/);
  assert.doesNotMatch(JSON.stringify(tree!.toJSON()), /4 cached rows|PRIVATE_ERROR/);
});

test('network and unsupported response failures are generic and refresh can recover', async (context) => {
  let mode: 'failure' | 'unsupported' | 'success' = 'failure';
  context.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'failure') throw new Error('PRIVATE_ERROR /home/secret token');
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
  assert.equal(tree!.root.findAllByProps({ role: 'status' }).length, 1);
  await act(async () => { tree.unmount(); });
  assert.equal(signal?.aborted, true);
});
