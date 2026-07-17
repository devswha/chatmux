import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RemoteAccessCardView } from './RemoteAccessCard';

// 관제탑 큐 #288 1단계: read-only 접속 주소 카드. HTTPS serve 주소만 홍보하고
// (plain-HTTP 100.x는 PWA 격하 — 금주 실사고 경로), 미설치/미실행이면 조용히 숨는다.

test('renders nothing when tailscale is absent or stopped', () => {
  assert.equal(renderToStaticMarkup(createElement(RemoteAccessCardView, { info: null })), '');
  assert.equal(
    renderToStaticMarkup(createElement(RemoteAccessCardView, {
      info: { installed: false, running: false, dnsName: null, httpsUrls: [], suggestedCommand: null },
    })),
    '',
  );
  assert.equal(
    renderToStaticMarkup(createElement(RemoteAccessCardView, {
      info: { installed: true, running: false, dnsName: 'host.ts.net', httpsUrls: [], suggestedCommand: null },
    })),
    '',
  );
});

test('shows the HTTPS serve address when a front exists', () => {
  const html = renderToStaticMarkup(createElement(RemoteAccessCardView, {
    info: {
      installed: true,
      running: true,
      dnsName: 'home-server.tail1e211e.ts.net',
      httpsUrls: ['https://home-server.tail1e211e.ts.net:8449'],
      suggestedCommand: null,
    },
  }));
  assert.ok(html.includes('https://home-server.tail1e211e.ts.net:8449'), 'promotes the HTTPS front');
  assert.ok(!html.includes('tailscale serve --bg'), 'no setup command when a front exists');
});

test('shows the one-line setup command when running without a front', () => {
  const html = renderToStaticMarkup(createElement(RemoteAccessCardView, {
    info: {
      installed: true,
      running: true,
      dnsName: 'host.ts.net',
      httpsUrls: [],
      suggestedCommand: 'tailscale serve --bg --https=8443 3021',
    },
  }));
  assert.ok(html.includes('tailscale serve --bg --https=8443 3021'), 'copyable setup command shown');
});
