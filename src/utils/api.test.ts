import assert from 'node:assert/strict';
import test from 'node:test';

import { api, authenticatedFetch } from './api.js';
import { clearSession, markSessionActive } from './authToken.js';

test('authenticatedFetch omits content-type when a request has no body', async () => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  clearSession();
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return new Response(null, { status: 204 });
  };

  try {
    await authenticatedFetch('/api/system/update', {
      method: 'POST',
      headers: { 'X-ChatMux-Update-Intent': 'start' },
    });
    const headers = new Headers(captured?.headers);
    assert.equal(headers.has('content-type'), false);
    assert.equal(headers.get('x-chatmux-update-intent'), 'start');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authenticatedFetch keeps JSON content-type for requests with a JSON body', async () => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  clearSession();
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return new Response(null, { status: 204 });
  };

  try {
    await authenticatedFetch('/api/example', { method: 'POST', body: '{}' });
    const headers = new Headers(captured?.headers);
    assert.equal(headers.get('content-type'), 'application/json');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('live roster requests forward optional abort signals without changing zero-argument calls', async () => {
  const originalFetch = globalThis.fetch;
  const captured: Array<RequestInit | undefined> = [];
  clearSession();
  globalThis.fetch = async (_input, init) => {
    captured.push(init);
    return new Response('{}', { status: 200 });
  };
  const controller = new AbortController();

  try {
    await api.liveSessions(controller.signal);
    await api.externalSessions(controller.signal);
    await api.liveSessions();
    assert.equal(captured[0]?.signal, controller.signal);
    assert.equal(captured[1]?.signal, controller.signal);
    assert.equal(captured[2]?.signal, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authenticatedFetch never attaches a bearer header, even while a session is active; the cookie is the credential', async () => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  markSessionActive();
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return new Response(null, { status: 204, headers: { 'X-Refreshed-Token': 'a.b.c' } });
  };
  try {
    await authenticatedFetch('/api/projects');
    const headers = new Headers(captured?.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(captured?.credentials, 'same-origin');
  } finally {
    globalThis.fetch = originalFetch;
    clearSession();
  }
});
