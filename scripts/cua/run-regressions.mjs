#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const outputRoot = path.resolve(
  process.env.CUA_EVIDENCE_DIR
    ?? path.join(repositoryRoot, '.omo', 'cua', 'regressions'),
);
const outputPath = path.join(outputRoot, 'regressions.json');
const maxDiagnosticCharacters = 64 * 1024;
const commands = [
  { id: 'typecheck', executable: 'npm', args: ['run', 'typecheck'] },
  { id: 'lint', executable: 'npm', args: ['run', 'lint'] },
  { id: 'tests', executable: 'npm', args: ['test'] },
  { id: 'core', executable: 'npm', args: ['run', 'check:core'] },
  {
    id: 'tmux-e2e',
    executable: process.execPath,
    args: [
      '--import',
      'tsx',
      '--test',
      'server/modules/providers/tests/tmux-runtime.e2e.test.ts',
    ],
    env: { TSX_TSCONFIG_PATH: 'server/tsconfig.json' },
  },
  { id: 'build', executable: 'npm', args: ['run', 'build'] },
];

function appendTail(current, chunk) {
  const next = current + chunk.toString();
  return next.length <= maxDiagnosticCharacters
    ? next
    : next.slice(-maxDiagnosticCharacters);
}

async function runCommand(command) {
  const startedAt = new Date();
  let outputTail = '';
  const child = spawn(command.executable, command.args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...command.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    outputTail = appendTail(outputTail, chunk);
  });
  child.stderr.on('data', (chunk) => {
    outputTail = appendTail(outputTail, chunk);
  });
  const { code, signal, error } = await new Promise((resolve) => {
    child.once('error', (childError) => resolve({ code: null, signal: null, error: childError }));
    child.once('exit', (exitCode, exitSignal) => resolve({
      code: exitCode,
      signal: exitSignal,
      error: null,
    }));
  });
  const finishedAt = new Date();
  const ok = code === 0 && !signal && !error;
  const result = {
    id: command.id,
    command: [command.executable, ...command.args],
    ok,
    exitCode: code,
    signal,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ...(error ? { error: error.message } : {}),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!ok && outputTail) process.stderr.write(`${outputTail}\n`);
  return result;
}

await mkdir(outputRoot, { recursive: true });
const results = [];
for (const command of commands) {
  results.push(await runCommand(command));
  await writeFile(
    outputPath,
    `${JSON.stringify({
      capturedAt: new Date().toISOString(),
      ok: results.length === commands.length && results.every((result) => result.ok),
      results,
    }, null, 2)}\n`,
    'utf8',
  );
}

if (results.some((result) => !result.ok)) process.exitCode = 1;
