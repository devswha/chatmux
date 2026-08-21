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

async function findTerminalTargets(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${cdpUrl}/json/list`);
    if (!response.ok) {
      throw new Error(`CDP target discovery failed with ${response.status}`);
    }
    const targets = (await response.json()).filter((target) => (
      target.type === 'page' && target.url.includes('/session/')
    ));
    const probes = await Promise.allSettled(targets.map(async (target) => {
      const result = await callTarget(target, 'Runtime.evaluate', {
        expression: "Boolean(document.querySelector('.xterm'))",
        returnByValue: true,
      }, 1_500);
      return result?.result?.value === true ? target : null;
    }));
    const terminalTargets = probes.flatMap((probe) => (
      probe.status === 'fulfilled' && probe.value ? [probe.value] : []
    ));
    if (terminalTargets.length > 0) return terminalTargets;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('No ChatMux page with a rendered CLI terminal was found.');
}

const captureDeadline = Date.now() + 35_000;
let captured = false;
let lastError = new Error('CLI screenshot was not attempted.');
while (!captured && Date.now() < captureDeadline) {
  const targets = await findTerminalTargets();
  for (const target of targets) {
    try {
      const screenshot = await callTarget(target, 'Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      }, 25_000);
      await writeFile(outputPath, Buffer.from(screenshot.data, 'base64'));
      captured = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!captured) await new Promise((resolve) => setTimeout(resolve, 300));
}
if (!captured) throw lastError;
process.stdout.write(`${outputPath}\n`);
