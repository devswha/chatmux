#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [kind, outputArgument, runner = 'local', bundleArgument = 'release/server'] = process.argv.slice(2);
if (!['verify', 'bundle'].includes(kind) || !outputArgument) {
  throw new Error('Usage: write-release-receipt.mjs <verify|bundle> <output> [runner] [bundle-directory]');
}

const output = path.resolve(outputArgument);
const receipt = {
  ok: true,
  exitCode: 0,
  node: process.version,
  runner,
};

if (kind === 'bundle') {
  const directory = path.resolve(bundleArgument);
  const candidates = (await readdir(directory)).filter((name) => name.endsWith('.tar.gz'));
  if (candidates.length !== 1) {
    throw new Error(`Expected one server bundle in ${directory}; found ${candidates.length}.`);
  }
  const bundle = path.join(directory, candidates[0]);
  const bytes = await readFile(bundle);
  receipt.glibc = process.report.getReport().header.glibcVersionRuntime;
  receipt.bytes = (await stat(bundle)).size;
  receipt.sha256 = createHash('sha256').update(bytes).digest('hex');
}

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
