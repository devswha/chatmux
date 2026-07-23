import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildServeSuggestion,
  getTailscaleAccessInfo,
  parseServeStatus,
  parseTailscaleSelfLogin,
  parseTailscaleStatus,
} from './tailscale-access.js';

// Real `tailscale serve status` output shape from the host this was built on
// (multiple daemons, subpath proxies, plain-http fronts, multi-front blocks).
const SERVE_FIXTURE = [
  'http://home-server (tailnet only)',
  'http://home-server.tail1e211e.ts.net (tailnet only)',
  '|-- / proxy http://127.0.0.1:3021',
  '',
  'https://home-server.tail1e211e.ts.net:8445 (tailnet only)',
  '|-- / proxy http://127.0.0.1:3018',
  '',
  'https://home-server.tail1e211e.ts.net:8449 (tailnet only)',
  '|-- / proxy http://127.0.0.1:3021',
  '',
  'https://home-server.tail1e211e.ts.net:8443 (tailnet only)',
  '|-- / proxy http://127.0.0.1:3019/status',
  '',
  'https://home-server.tail1e211e.ts.net:8446 (tailnet only)',
  '|-- / proxy http://100.123.228.51:3005',
].join('\n');

test('parseServeStatus keeps only HTTPS fronts proxying this port at the root path', () => {
  assert.deepEqual(parseServeStatus(SERVE_FIXTURE, 3021), [
    'https://home-server.tail1e211e.ts.net:8449',
  ]);
});

test('parseServeStatus: plain-http fronts are never advertised (PWA는 HTTPS에서만)', () => {
  // Port 3021 IS proxied by the http:// front block — it must still be dropped.
  const httpOnly = [
    'http://home-server (tailnet only)',
    '|-- / proxy http://127.0.0.1:3021',
  ].join('\n');
  assert.deepEqual(parseServeStatus(httpOnly, 3021), []);
});

test('parseServeStatus: subpath proxies of another daemon never masquerade as this app', () => {
  const subpath = [
    'https://host.ts.net:8443 (tailnet only)',
    '|-- / proxy http://127.0.0.1:3021/status',
  ].join('\n');
  assert.deepEqual(parseServeStatus(subpath, 3021), []);
});

test('parseServeStatus handles empty/garbage output', () => {
  assert.deepEqual(parseServeStatus('', 3021), []);
  assert.deepEqual(parseServeStatus('no serve config\n', 3021), []);
});

test('parseTailscaleStatus reads backend state and strips the MagicDNS trailing dot', () => {
  const parsed = parseTailscaleStatus(JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'home-server.tail1e211e.ts.net.' },
  }));
  assert.deepEqual(parsed, { running: true, dnsName: 'home-server.tail1e211e.ts.net' });
  assert.deepEqual(parseTailscaleStatus('not json'), { running: false, dnsName: null });
  assert.deepEqual(parseTailscaleStatus(JSON.stringify({ BackendState: 'Stopped' })), { running: false, dnsName: null });
});

test('parseTailscaleSelfLogin resolves the local node account without guessing from tailnet name', () => {
  const status = JSON.stringify({
    Self: { UserID: 42 },
    User: {
      7: { LoginName: 'other@example.com' },
      42: { LoginName: 'Owner@Example.com' },
    },
  });
  assert.equal(parseTailscaleSelfLogin(status), 'owner@example.com');
  assert.equal(parseTailscaleSelfLogin('{}'), null);
  assert.equal(parseTailscaleSelfLogin('not json'), null);
});

test('getTailscaleAccessInfo: not installed → silent card; running without a front → setup command', async () => {
  const missing = await getTailscaleAccessInfo(3021, async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  assert.deepEqual(missing, { installed: false, running: false, dnsName: null, httpsUrls: [], suggestedCommand: null });

  const noFront = await getTailscaleAccessInfo(3021, async (args) => {
    if (args[0] === 'status') {
      return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.ts.net.' } });
    }
    return 'no serve config\n';
  });
  assert.equal(noFront.running, true);
  assert.deepEqual(noFront.httpsUrls, []);
  assert.equal(noFront.suggestedCommand, buildServeSuggestion(3021));

  const occupiedDefault = await getTailscaleAccessInfo(3021, async (args) => {
    if (args[0] === 'status') {
      return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.ts.net.' } });
    }
    if (args.includes('--json')) return JSON.stringify({ TCP: { 8443: { HTTPS: true } } });
    return 'no serve config\n';
  });
  assert.equal(
    occupiedDefault.suggestedCommand,
    buildServeSuggestion(3021, 8444),
    'the UI must never suggest overwriting another Serve front',
  );

  const withFront = await getTailscaleAccessInfo(3021, async (args) => {
    if (args[0] === 'status') {
      return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.ts.net.' } });
    }
    return SERVE_FIXTURE;
  });
  assert.deepEqual(withFront.httpsUrls, ['https://home-server.tail1e211e.ts.net:8449']);
  assert.equal(withFront.suggestedCommand, null, 'no setup nag when a front already exists');
});
