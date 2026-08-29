#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';

import { acquireWorktreeLock } from './worktree-lock.mjs';

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

function emit(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ verifyOwnerEvent: event, pid: process.pid, ...detail })}\n`);
}

function parseCommand(args) {
  const divider = args.indexOf('--');
  const options = divider < 0 ? args : args.slice(0, divider);
  const command = divider < 0 ? ['npm', 'run', 'verify:owned'] : args.slice(divider + 1);
  let lockPath = path.resolve('.omo/runtime/verify-owner.lock');
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] !== '--lock-path' || options[index + 1] === undefined) throw new TypeError('verify owner arguments are invalid');
    lockPath = path.resolve(options[index + 1]); index += 1;
  }
  if (command.length === 0) throw new TypeError('verify owner command is required');
  return { lockPath, executable: command[0], args: command.slice(1) };
}

async function main() {
  const command = parseCommand(process.argv.slice(2));
  const ownership = await acquireWorktreeLock(command.lockPath, {
    timeoutMs: 15 * 60_000,
    onWait: (owner) => emit('waiting', { ownerPid: owner.wrapper.pid, childPid: owner.child?.pid ?? null }),
    onStale: (owner) => emit('stale-owner-removed', { ownerPid: owner.wrapper.pid, childPid: owner.child?.pid ?? null }),
  });
  emit('acquired');
  let supervisor; let requestedSignal; let signalForwarded = false; let released = false;
  const forward = () => {
    if (requestedSignal === undefined || supervisor === undefined || !supervisor.connected || signalForwarded) return;
    signalForwarded = true; supervisor.send({ signal: requestedSignal });
  };
  const handlers = Object.fromEntries(SIGNALS.map((signal) => [signal, () => { requestedSignal ??= signal; forward(); }]));
  for (const signal of SIGNALS) process.on(signal, handlers[signal]);
  try {
    supervisor = spawn(process.execPath, [
      path.resolve('scripts/verify-owner-supervisor.mjs'),
      '--lockPath', command.lockPath, '--token', ownership.token,
      '--dev', ownership.lock.dev, '--ino', ownership.lock.ino, '--', command.executable, ...command.args,
    ], { cwd: process.cwd(), env: process.env, detached: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    const status = await new Promise((resolve, reject) => {
      supervisor.once('error', reject);
      supervisor.on('message', (message) => {
        if (message?.type === 'ready') {
          emit('child-recorded', { childPid: message.identity.pid, processGroupId: process.platform === 'win32' ? null : message.identity.pid });
          supervisor.send({ type: 'start' }); forward();
        }
        if (message?.type === 'released') released = true;
      });
      supervisor.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (released) await ownership.release();
    for (const signal of SIGNALS) process.removeListener(signal, handlers[signal]);
    if (requestedSignal !== undefined) {
      process.kill(process.pid, requestedSignal); return;
    }
    if (status.signal !== null) { process.kill(process.pid, status.signal); return; }
    process.exitCode = status.code ?? 1;
  } catch (error) {
    if (supervisor === undefined) await ownership.release();
    throw error;
  } finally {
    for (const signal of SIGNALS) process.removeListener(signal, handlers[signal]);
    emit(released ? 'released' : 'ownership-retained');
  }
}

try { await main(); } catch (error) {
  console.error(error);
  process.exitCode = 1;
}
