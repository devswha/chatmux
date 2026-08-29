#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import WebSocket from 'ws';

const execFileAsync = promisify(execFile);
const output = path.resolve(process.env.CUA_EVIDENCE_DIR);
const baseUrl = process.env.CUA_PWA_BASE_URL;
const cdpUrl = process.env.CUA_CDP_URL;
const deepLink = '/hosts/00000000-0000-4000-8000-000000000024/session/notification-proof';
const targets = await (await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
const target = targets.find((entry) => entry.type === 'page' && entry.url.startsWith(baseUrl));
if (!target) throw new Error('Exact pre-requested ChatMux target was not found.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const seen = [];
  const timer = setTimeout(() => {
    socket.terminate();
    reject(new Error(`Active-session PWA readiness timed out: ${JSON.stringify(seen.slice(-20))}`));
  }, 30_000);
  const finish = (callback) => { clearTimeout(timer); socket.close(); callback(); };
  let evidenceSent = false;
  let probeId = 10;
  const probe = () => {
    if (evidenceSent || socket.readyState !== WebSocket.OPEN) return;
    probeId += 1;
    socket.send(JSON.stringify({
      id: probeId,
      method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        expression: `({
          ready: location.origin === ${JSON.stringify(new URL(baseUrl).origin)}
            && document.readyState === 'complete'
            && Boolean(document.querySelector('#root'))
            && Boolean(document.querySelector('link[rel="manifest"]')),
          href: location.href,
          state: document.readyState,
        })`,
      },
    }));
  };
  const collectEvidence = () => {
    if (evidenceSent) return;
    evidenceSent = true;
    socket.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: {
        awaitPromise: true, returnByValue: true,
        expression: `(async () => {
          const registration = await navigator.serviceWorker.ready;
          if (Notification.permission !== 'granted') throw new Error('notification permission is ' + Notification.permission);
          const deepLink = ${JSON.stringify(deepLink)};
          await registration.showNotification('ChatMux Todo 24', { body: 'Host-qualified completion ready', tag: 'task-24-host-qualified-completion', data: { navigation: { href: deepLink } } });
          const notifications = await registration.getNotifications({ tag: 'task-24-host-qualified-completion' });
          const response = await fetch(deepLink, { redirect: 'manual' });
          return {
            origin: location.origin, title: document.title, permission: Notification.permission,
            serviceWorker: { active: registration.active?.state === 'activated', scope: registration.scope, scriptURL: registration.active?.scriptURL ?? null },
            notification: { title: notifications[0]?.title ?? null, tag: notifications[0]?.tag ?? null, navigation: notifications[0]?.data?.navigation ?? null },
            deepLink: { href: deepLink, status: response.status, served: response.ok },
          };
        })()`,
      },
    }));
  };
  socket.once('error', (error) => finish(() => reject(error)));
  socket.once('open', () => {
    socket.send(JSON.stringify({ id: 2, method: 'Page.enable' }));
    socket.send(JSON.stringify({ id: 3, method: 'Runtime.enable' }));
  });
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    seen.push({
      id: message.id,
      method: message.method,
      value: message.result?.result?.value,
      error: message.error,
      url: message.params?.frame?.url,
    });
    if (message.id === 2 || message.id === 3) probe();
    if (['Page.loadEventFired', 'Page.frameNavigated', 'Runtime.executionContextCreated'].includes(message.method)) probe();
    if (message.id >= 11 && message.result?.result?.value?.ready === true) collectEvidence();
    if (message.id !== 1) return;
    if (message.error || message.result?.exceptionDetails) finish(() => reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails))));
    else finish(() => resolve(message.result.result.value));
  });
});
if (result.title !== 'ChatMux' || result.notification.navigation?.href !== deepLink) throw new Error(`PWA assertion failed: ${JSON.stringify(result)}`);
await execFileAsync('gnome-screenshot', ['-f', path.join(output, 'os-notification-delivered.png')]);
await writeFile(path.join(output, 'pwa-notification-browser.json'), `${JSON.stringify({ ...result, notificationApiCreated: true }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
