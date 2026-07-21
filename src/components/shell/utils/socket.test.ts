import assert from 'node:assert/strict';
import test from 'node:test';

import { getShellWebSocketUrl } from './socket';

type MinimalWindow = { location: { protocol: string; host: string } };

// Regression: the shell socket URL was gated on a localStorage auth token,
// but a WebSocket handshake cannot carry custom headers — authentication is
// server-side (auth cookie, or the implicit owner when CHATMUX_AUTH=none).
// In no-login mode there IS no stored token, so every terminal attach
// (외부 CLI / Shell) silently rendered a black screen without ever opening
// the socket. The URL builder must not consult client-side credentials —
// this test runs without any localStorage global, so reintroducing a token
// check fails loudly instead of silently returning null.
test('shell websocket URL never requires a client-side auth token', () => {
  const globals = globalThis as { window?: MinimalWindow };
  const originalWindow = globals.window;
  try {
    globals.window = { location: { protocol: 'https:', host: 'home.example.ts.net:8449' } };
    assert.equal(getShellWebSocketUrl(), 'wss://home.example.ts.net:8449/shell');

    globals.window = { location: { protocol: 'http:', host: '127.0.0.1:3021' } };
    assert.equal(getShellWebSocketUrl(), 'ws://127.0.0.1:3021/shell');
  } finally {
    if (originalWindow === undefined) {
      delete globals.window;
    } else {
      globals.window = originalWindow;
    }
  }
});
