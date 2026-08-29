import assert from 'node:assert/strict';
import test from 'node:test';

import { act } from 'react-test-renderer';

import {
  byAttribute,
  catalogOf,
  dispatchLocal,
  dispatchPeer,
  entry,
  LOCAL,
  mount,
  PEER_A,
  PEER_B,
  press,
  spawnCalls,
  stubFetch,
  type as typeInto,
} from './SidebarNewSession.testSupport';

test('Given no enrolled peer, when the form opens, then no host selector appears and the local path input is used', (t) => {
  // Given / When
  const harness = mount({ localHostId: LOCAL, hosts: new Map() });
  t.after(harness.dispose);

  // Then
  assert.equal(byAttribute(harness, 'data-spawn-host').length, 0);
  assert.equal(byAttribute(harness, 'data-peer-cwd-input').length, 0);
  assert.equal(byAttribute(harness, 'data-spawn-provider').length, 7);
});

test('Given a local spawn for GJC and for a native CLI, when each succeeds, then the caller is told a session was created', async (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mount({ localHostId: LOCAL, hosts: new Map() });
  t.after(harness.dispose);

  // When
  await dispatchLocal(harness, fetches, 'gjc', 'feature-gjc');
  await dispatchLocal(harness, fetches, 'codex', 'feature-codex');

  // Then
  assert.deepEqual(spawnCalls(fetches).map((call) => call.url), [
    '/api/providers/sessions/live/spawn',
    '/api/providers/sessions/external/spawn',
  ]);
  assert.equal(harness.created(), 2);
});

test('Given a local spawn with no working directory, when submit is pressed, then nothing is dispatched', async (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mount({ localHostId: LOCAL, hosts: new Map() });
  t.after(harness.dispose);
  typeInto(harness, 'data-spawn-name', 'feature');

  // When
  press(harness, 'data-spawn-submit');
  await act(async () => { await Promise.resolve(); });

  // Then
  assert.equal(harness.created(), 0);
  assert.equal(spawnCalls(fetches).length, 0);
});

test('Given only offline, resynchronizing or spawn-incapable peers, when hosts are offered, then none of them appear', (t) => {
  // Given
  const catalog = catalogOf(
    entry(LOCAL, 'online'),
    entry(PEER_A, 'offline'),
    entry(PEER_B, 'online', { sync: 'syncing' }),
  );

  // When
  const harness = mount(catalog);
  t.after(harness.dispose);

  // Then
  const offered = byAttribute(harness, 'data-spawn-host').map((node) => node.props['data-spawn-host']);
  assert.deepEqual(offered, []);
});

test('Given an online peer, when it is selected, then only its spawnable provider is offered and its projects are listed', (t) => {
  // Given
  const harness = mount(catalogOf(entry(LOCAL, 'online'), entry(PEER_A, 'online')));
  t.after(harness.dispose);

  // When
  press(harness, 'data-spawn-host', PEER_A);

  // Then
  assert.deepEqual(byAttribute(harness, 'data-spawn-provider').map((node) => node.props['data-spawn-provider']), ['gjc']);
  assert.equal(byAttribute(harness, 'data-spawn-project').length, 1);
  assert.equal(byAttribute(harness, 'data-peer-cwd-input').length, 1);
});

test('Given a peer spawn, when a controller path is entered, then the request is never dispatched', async (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  const harness = mount(catalogOf(entry(LOCAL, 'online'), entry(PEER_A, 'online')));
  t.after(harness.dispose);
  press(harness, 'data-spawn-host', PEER_A);
  typeInto(harness, 'data-spawn-project', 'project-collision');
  typeInto(harness, 'data-spawn-name', 'feature');
  typeInto(harness, 'data-peer-cwd-input', '/home/devswha/workspace/chatmux');

  // When
  press(harness, 'data-spawn-submit');
  await act(async () => { await Promise.resolve(); });

  // Then
  assert.equal(spawnCalls(fetches).length, 0);
  assert.equal(harness.created(), 0);
});

test('Given the same project id on two peers, when each spawn is dispatched, then the request names only its own host', async (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  const catalog = catalogOf(entry(LOCAL, 'online'), entry(PEER_A, 'online'), entry(PEER_B, 'online'));
  const harness = mount(catalog);
  t.after(harness.dispose);

  // When
  await dispatchPeer(harness, PEER_A, 'feature-22');
  await dispatchPeer(harness, PEER_B, 'feature-33');

  // Then
  assert.deepEqual(spawnCalls(fetches).map((call) => call.url), [
    `/api/hosts/${PEER_A}/projects/project-collision/sessions/spawn`,
    `/api/hosts/${PEER_B}/projects/project-collision/sessions/spawn`,
  ]);
  assert.deepEqual(spawnCalls(fetches).map((call) => call.body), [
    { name: 'feature-22', cwd: 'workspace/app' },
    { name: 'feature-33', cwd: 'workspace/app' },
  ]);
  assert.equal(harness.created(), 2);
});

test('Given a dispatched peer spawn whose answer never arrives, when the outcome is unknown, then nothing is resent until the host is re-checked', async (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  fetches.reply((url) => (url.includes('spawn') ? 'reject' : { status: 200, body: { data: { suggestions: [] } } }));
  const harness = mount(catalogOf(entry(LOCAL, 'online'), entry(PEER_A, 'online')));
  t.after(harness.dispose);
  press(harness, 'data-spawn-host', PEER_A);
  typeInto(harness, 'data-spawn-project', 'project-collision');
  typeInto(harness, 'data-spawn-name', 'feature');
  typeInto(harness, 'data-peer-cwd-input', 'workspace/app');

  // When
  press(harness, 'data-spawn-submit');
  await act(async () => { await Promise.resolve(); });

  // Then
  assert.equal(byAttribute(harness, 'data-spawn-status', 'unknown').length, 1);
  assert.equal(harness.created(), 0, 'an unresolved outcome is not a success');
  const submit = byAttribute(harness, 'data-spawn-submit')[0];
  assert.equal(submit?.props.disabled, true, 'resend stays disabled until the host is re-checked');
  assert.equal(spawnCalls(fetches).length, 1);

  press(harness, 'data-spawn-reconcile');
  assert.equal(harness.refreshes(), 1, 'the roster is re-read before the user may act again');
  assert.equal(byAttribute(harness, 'data-spawn-status', 'unknown').length, 0);
  assert.equal(spawnCalls(fetches).length, 1, 'reconciling never resends the request');
});

test('Given a peer name conflict, when the spawn is refused, then it is a plain rejection with no unresolved outcome', async (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  fetches.reply((url) => (url.includes('spawn')
    ? { status: 200, body: { data: { ok: false, reachable: true, conflict: true } } }
    : { status: 200, body: { data: { suggestions: [] } } }));
  const harness = mount(catalogOf(entry(LOCAL, 'online'), entry(PEER_A, 'online')));
  t.after(harness.dispose);
  press(harness, 'data-spawn-host', PEER_A);
  typeInto(harness, 'data-spawn-project', 'project-collision');
  typeInto(harness, 'data-spawn-name', 'feature');
  typeInto(harness, 'data-peer-cwd-input', 'workspace/app');

  // When
  press(harness, 'data-spawn-submit');
  await act(async () => { await Promise.resolve(); });

  // Then
  assert.equal(byAttribute(harness, 'data-spawn-status', 'rejected:name-conflict').length, 1);
  assert.equal(byAttribute(harness, 'data-spawn-submit')[0]?.props.disabled, false);
});

test('Given a peer path field, when suggestions are requested, then they come from the peer host route', async (t) => {
  // Given
  const fetches = stubFetch();
  t.after(fetches.restore);
  fetches.reply(() => ({ status: 200, body: { data: { suggestions: ['workspace/app'] } } }));
  const harness = mount(catalogOf(entry(LOCAL, 'online'), entry(PEER_A, 'online')));
  t.after(harness.dispose);
  press(harness, 'data-spawn-host', PEER_A);
  typeInto(harness, 'data-spawn-project', 'project-collision');

  // When
  typeInto(harness, 'data-peer-cwd-input', 'work');
  await act(async () => { await fetches.awaitRequest((url) => url.includes('dir-suggestions')); });

  // Then
  const suggestionCalls = fetches.calls.filter((call) => call.url.includes('dir-suggestions'));
  assert.ok(suggestionCalls.length > 0, 'the peer must be asked for its own paths');
  for (const call of suggestionCalls) {
    assert.ok(call.url.startsWith(`/api/hosts/${PEER_A}/projects/project-collision/dir-suggestions`), call.url);
  }
  assert.equal(byAttribute(harness, 'data-peer-cwd-suggestion', 'workspace/app').length, 1);
});
