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
if (!baseUrl || !cdpUrl) throw new Error('CUA_PWA_BASE_URL and CUA_CDP_URL are required.');

const response = await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`CDP target discovery failed with ${response.status}`);
const target = (await response.json()).find((entry) => entry.type === 'page' && entry.url.startsWith(baseUrl));
if (!target) throw new Error('The isolated ChatMux app target was not found.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const seen = [];
  const timeout = setTimeout(() => {
    socket.terminate();
    reject(new Error(`PWA CDP evidence timed out: ${JSON.stringify(seen.slice(-20))}`));
  }, 30_000);
  const finish = (callback) => { clearTimeout(timeout); socket.close(); callback(); };
  socket.once('error', (error) => finish(() => reject(error)));
  socket.once('close', () => {
    if (!evaluationSent) finish(() => reject(new Error(`PWA CDP target closed: ${JSON.stringify(seen.slice(-20))}`)));
  });
  let evaluationSent = false; let navigationSent = false; let probeId = 10;
  const evaluate = () => {
    if (evaluationSent) return;
    evaluationSent = true;
    socket.send(JSON.stringify({
      id: 3,
      method: 'Runtime.evaluate',
      params: {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          if (document.readyState !== 'complete') await new Promise((ready) => addEventListener('load', ready, { once: true }));
          const deepLink = ${JSON.stringify(deepLink)};
          if (!('serviceWorker' in navigator)) throw new Error('service workers unavailable: ' + JSON.stringify({ href: location.href, secure: isSecureContext, origin: location.origin }));
          const registration = await navigator.serviceWorker.ready;
          if (Notification.permission !== 'granted') throw new Error('notification permission is ' + Notification.permission);
          await registration.showNotification('ChatMux Todo 24', {
            body: 'Host-qualified completion ready', tag: 'task-24-host-qualified-completion',
            data: { navigation: { href: deepLink } },
          });
          const notifications = await registration.getNotifications({ tag: 'task-24-host-qualified-completion' });
          if (notifications.length !== 1) throw new Error('service worker notification was not retained');
          const deepLinkResponse = await fetch(deepLink, { redirect: 'manual' });
          return {
            origin: location.origin,
            displayModeStandalone: matchMedia('(display-mode: standalone)').matches,
            permission: Notification.permission,
            serviceWorker: { active: registration.active?.state === 'activated', scope: registration.scope, scriptURL: registration.active?.scriptURL ?? null },
            notification: { title: notifications[0].title, tag: notifications[0].tag, navigation: notifications[0].data?.navigation ?? null },
            deepLink: { href: deepLink, status: deepLinkResponse.status, served: deepLinkResponse.ok },
          };
        })()`,
      },
    }));
  };
  const probeLocation = () => {
    if (evaluationSent) return;
    probeId += 1;
    socket.send(JSON.stringify({ id: probeId, method: 'Runtime.evaluate', params: { expression: 'location.href', returnByValue: true } }));
  };
  socket.once('open', () => {
    socket.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
    socket.send(JSON.stringify({ id: 4, method: 'Network.enable' }));
    socket.send(JSON.stringify({
      id: 5,
      method: 'Browser.grantPermissions',
      params: {
        origin: baseUrl,
        permissions: ['notifications', 'localNetwork', 'localNetworkAccess', 'loopbackNetwork'],
      },
    }));
  });
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    seen.push({
      id: message.id, method: message.method, error: message.error,
      value: message.result?.result?.value,
      url: message.params?.request?.url ?? message.params?.documentURL,
      errorText: message.params?.errorText,
      blockedReason: message.params?.blockedReason,
    });
    if (message.id === 1) {
      if (message.error) finish(() => reject(new Error(JSON.stringify(message.error))));
      return;
    }
    if (message.id === 5) {
      if (message.error) finish(() => reject(new Error(JSON.stringify(message.error))));
      else probeLocation();
      return;
    }
    if (message.method === 'Page.loadEventFired') probeLocation();
    if (message.method === 'Page.frameNavigated' && message.params?.frame?.parentId === undefined
      && message.params.frame.url.startsWith(baseUrl)) evaluate();
    if (message.id >= 11 && message.result?.result?.value?.startsWith(baseUrl)) evaluate();
    if (message.id >= 11 && message.result?.result?.value === 'about:blank' && !navigationSent) {
      navigationSent = true;
      socket.send(JSON.stringify({ id: 6, method: 'Page.stopLoading' }));
    }
    if (message.id === 6 && !message.error) {
      socket.send(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url: baseUrl, transitionType: 'typed' } }));
    }
    if (message.id === 6 && message.error) finish(() => reject(new Error(JSON.stringify(message.error))));
    if (message.id === 2 && message.error) finish(() => reject(new Error(JSON.stringify(message.error))));
    if (message.id !== 3) return;
    if (message.error || message.result?.exceptionDetails) {
      finish(() => reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails))));
    } else {
      finish(() => resolve(message.result.result.value));
    }
  });
});
await execFileAsync('gnome-screenshot', ['-f', path.join(output, 'os-notification-delivered.png')]);
await writeFile(path.join(output, 'pwa-notification-browser.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
