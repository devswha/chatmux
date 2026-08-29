#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

import WebSocket from 'ws';

const cdpUrl = process.argv[2] ?? 'http://127.0.0.1:9333';
const outputPath = process.argv[3];

if (!outputPath) {
  throw new Error('Usage: cdp-screenshot.mjs <cdp-url> <output-path>');
}

function callTarget(target, method, params = {}, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new Error(`CDP request timed out: ${method}`));
    }, timeoutMs);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      callback();
    };
    socket.once('open', () => {
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== 1) return;
      if (message.error) {
        finish(() => reject(new Error(JSON.stringify(message.error))));
        return;
      }
      finish(() => resolve(message.result));
    });
    socket.once('error', (error) => finish(() => reject(error)));
  });
}

async function terminalTargets() {
  const response = await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`CDP target discovery failed with ${response.status}`);
  const targets = (await response.json()).filter((target) => (
    target.type === 'page' && target.url.includes('/session/')
  ));
  const probes = await Promise.allSettled(targets.map(async (target) => {
    const result = await callTarget(target, 'Runtime.evaluate', {
      expression: `new Promise((resolve, reject) => {
        const inspect = () => document.querySelector('.xterm-screen');
        const existing = inspect();
        if (existing) { resolve(true); return; }
        const observer = new MutationObserver(() => {
          if (!inspect()) return;
          observer.disconnect(); clearTimeout(timeout); resolve(true);
        });
        const timeout = setTimeout(() => {
          observer.disconnect(); reject(new Error('xterm readiness timed out'));
        }, 15000);
        observer.observe(document.documentElement, { subtree: true, childList: true });
      })`,
      awaitPromise: true,
      returnByValue: true,
    }, 20_000);
    return result?.result?.value === true ? target : null;
  }));
  return probes.flatMap((probe) => (
    probe.status === 'fulfilled' && probe.value ? [probe.value] : []
  ));
}

const targets = await terminalTargets();
if (targets.length === 0) throw new Error('No ChatMux page produced the exact xterm readiness signal.');
const captures = await Promise.allSettled(targets.map((target) => callTarget(
  target,
  'Page.captureScreenshot',
  { format: 'png', fromSurface: true, captureBeyondViewport: false },
  25_000,
)));
const screenshot = captures.find((capture) => capture.status === 'fulfilled');
if (screenshot === undefined || screenshot.status !== 'fulfilled') {
  throw new AggregateError(
    captures.filter((capture) => capture.status === 'rejected').map((capture) => capture.reason),
    'Every event-ready terminal screenshot failed.',
  );
}
await writeFile(outputPath, Buffer.from(screenshot.value.data, 'base64'));
process.stdout.write(`${outputPath}\n`);
