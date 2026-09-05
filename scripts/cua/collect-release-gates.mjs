#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const evidence = path.resolve(process.env.CUA_EVIDENCE_DIR ?? path.join(root, '.cua-release-evidence'));
const protectedHooks = [
  'src/components/chat/hooks/useChatComposerState.ts',
  'src/components/chat/hooks/useChatSessionState.ts',
];

async function json(name) {
  try { return JSON.parse(await readFile(path.join(evidence, name), 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
}

function pureLoc(source) {
  return source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('//');
  }).length;
}

const [{ stdout: changedOutput }, { stdout: stagedOutput }] = await Promise.all([
  execFileAsync('git', ['ls-files', '-m', '-o', '--exclude-standard', '--', '*.ts', '*.tsx'], { cwd: root }),
  execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: root }),
]);
const changed = [...new Set(changedOutput.split('\n').filter(Boolean))];
const locRows = [];
for (const file of changed) {
  try {
    const source = await readFile(path.join(root, file), 'utf8');
    locRows.push({ file, pureLoc: pureLoc(source) });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
const locViolations = locRows.filter(({ file, pureLoc: lines }) => (
  lines > 250 && !protectedHooks.includes(file)
));
// Approved changes must not fail against hashes frozen in an older release.
// Check that the harness preserved the source committed for this exact run.
const { stdout: commitOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
const referenceCommit = commitOutput.trim();
const expectedHookHashes = Object.fromEntries(await Promise.all(
  protectedHooks.map(async (file) => {
    const { stdout } = await execFileAsync('git', ['show', `${referenceCommit}:${file}`], { cwd: root, encoding: 'buffer' });
    return [file, createHash('sha256').update(stdout).digest('hex')];
  }),
));
const actualHookHashes = Object.fromEntries(await Promise.all(
  protectedHooks.map(async (file) => [file, await sha256(file)]),
));
const [node22, node24, bundle, focused, stopped] = await Promise.all([
  json('ci/verify-node22.json'), json('ci/verify-node24.json'), json('ci/bundle-node22.json'),
  json('focused-terminal.json'), json('stopped.json'),
]);
const fixturePorts = [
  Number.parseInt(process.env.CUA_VITE_PORT ?? '4310', 10),
  Number.parseInt(process.env.CUA_CDP_PORT ?? '9333', 10),
];
const listenerCheck = await execFileAsync('ss', ['-ltn'], { encoding: 'utf8' });
const occupiedFixturePorts = fixturePorts.filter((port) => new RegExp(`:${port}\\b`).test(listenerCheck.stdout));
const checks = {
  focusedTerminalIsolation: focused?.ok === true && focused?.tests >= 1,
  verifyNode22: node22?.ok === true && node22?.exitCode === 0 && /^v22\./.test(node22?.node ?? ''),
  verifyNode24: node24?.ok === true && node24?.exitCode === 0 && /^v24\./.test(node24?.node ?? ''),
  canonicalBundle: bundle?.ok === true && bundle?.exitCode === 0 && bundle?.bytes > 0
    && /^[a-f0-9]{64}$/.test(bundle?.sha256 ?? ''),
  protectedHooks: JSON.stringify(actualHookHashes) === JSON.stringify(expectedHookHashes),
  typescriptLoc: locViolations.length === 0,
  stagingEmpty: stagedOutput.trim() === '',
  cleanup: stopped?.cleanupError === null && occupiedFixturePorts.length === 0,
};
const report = {
  capturedAt: new Date().toISOString(), ok: Object.values(checks).every(Boolean), checks,
  receipts: { node22, node24, bundle, focused },
  protectedHooks: { referenceCommit, expected: expectedHookHashes, actual: actualHookHashes },
  typescriptLoc: { filesChecked: locRows.length, limit: 250, violations: locViolations },
  cleanup: { stopped, fixturePorts, occupiedFixturePorts },
};
await writeFile(path.join(evidence, 'release-gates.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: report.ok, checks }, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
