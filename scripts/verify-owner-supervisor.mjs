#!/usr/bin/env node

import { spawn } from 'node:child_process';

import { readProcessIdentity } from './worktree-lock-identity.mjs';
import { recordOwnedChild, releaseOwnedLock } from './worktree-lock.mjs';

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

function parse(args) {
  const divider = args.indexOf('--');
  if (divider < 0) throw new TypeError('verify supervisor command is required');
  const options = Object.fromEntries(args.slice(0, divider).reduce((pairs, value, index, values) => {
    if (!value.startsWith('--') || values[index + 1] === undefined || index % 2 !== 0) return pairs;
    pairs.push([value.slice(2), values[index + 1]]); return pairs;
  }, []));
  const command = args.slice(divider + 1);
  if (typeof options.lockPath !== 'string' || typeof options.token !== 'string'
    || typeof options.dev !== 'string' || typeof options.ino !== 'string' || command.length === 0) throw new TypeError('verify supervisor arguments are invalid');
  return { lockPath: options.lockPath, expected: { token: options.token, lock: { dev: options.dev, ino: options.ino } }, executable: command[0], args: command.slice(1) };
}

async function waitForStart() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new TypeError('verify supervisor start barrier timed out')), 60_000);
    process.on('message', (message) => {
      if (message?.type !== 'start') return;
      clearTimeout(timeout); resolve();
    });
  });
}

function send(message) {
  if (process.connected) process.send?.(message);
}

async function main() {
  const options = parse(process.argv.slice(2));
  const identity = await readProcessIdentity(process.pid);
  if (identity === null) throw new TypeError('verify supervisor identity is unavailable');
  await recordOwnedChild(options.lockPath, options.expected, {
    ...identity,
    processGroupId: process.platform === 'win32' ? null : process.pid,
  });
  send({ type: 'ready', identity });
  let terminationSignal; let groupSignaled = false; let command; let released = false;
  const forward = (signal) => {
    terminationSignal ??= signal;
    if (command === undefined || groupSignaled) return;
    groupSignaled = true;
    process.kill(process.platform === 'win32' ? command.pid : -process.pid, signal);
  };
  const signalHandlers = Object.fromEntries(SIGNALS.map((signal) => [signal, () => forward(signal)]));
  const messageHandler = (message) => {
    if (SIGNALS.includes(message?.signal)) forward(message.signal);
  };
  for (const signal of SIGNALS) process.on(signal, signalHandlers[signal]);
  process.on('message', messageHandler);
  let status;
  try {
    await waitForStart();
    command = spawn(options.executable, options.args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
    status = await new Promise((resolve, reject) => {
      command.once('error', reject);
      command.once('exit', (code, signal) => resolve({ code, signal }));
    });
    await releaseOwnedLock(options.lockPath, options.expected); released = true;
    send({ type: 'released', status });
  } finally {
    if (!released && (command === undefined || command.exitCode !== null || command.signalCode !== null)) {
      await releaseOwnedLock(options.lockPath, options.expected);
    }
    for (const signal of SIGNALS) process.removeListener(signal, signalHandlers[signal]);
    process.removeListener('message', messageHandler);
    if (process.connected) process.disconnect();
  }
  const exitSignal = terminationSignal ?? status.signal;
  if (exitSignal !== null && exitSignal !== undefined) {
    process.kill(process.pid, exitSignal);
    return;
  }
  process.exitCode = status.code ?? 1;
}

try { await main(); } catch (error) {
  console.error(error);
  process.exitCode = 1;
}
