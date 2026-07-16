import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:js|ts|tsx)$/;
const SKIPPED_DIRECTORIES = new Set(['dist', 'dist-server', 'node_modules', 'release']);

const [nodeMajor, nodeMinor, nodePatch] = process.versions.node.split('.').map(Number);
const meetsMinimumNodeVersion =
  (nodeMajor === 22 && (nodeMinor > 22 || (nodeMinor === 22 && nodePatch >= 2))) ||
  (nodeMajor === 24 && (nodeMinor > 15 || (nodeMinor === 15 && nodePatch >= 0)));

if (!meetsMinimumNodeVersion) {
  console.error(
    `[test] Node 22.22.2+ (22.x) or 24.15.0+ (24.x) is required; current runtime is Node ${process.versions.node}.`,
  );
  process.exit(1);
}

async function collectTests(root) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        files.push(entryPath);
      }
    }
  }

  await visit(root);
  return files.sort();
}

function runTests(label, files, { tsconfig } = {}) {
  if (files.length === 0) {
    throw new Error(`[test] ${label}: no test files were discovered.`);
  }

  console.log(`\n[test] ${label}: ${files.length} files`);
  const args = tsconfig
    ? ['--import', 'tsx', '--test', ...files]
    : ['--test', ...files];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: tsconfig ? { ...process.env, TSX_TSCONFIG_PATH: tsconfig } : process.env,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const [serverTests, clientTests, electronTests] = await Promise.all([
  collectTests('server'),
  collectTests('src'),
  collectTests('electron'),
]);

runTests('server', serverTests, { tsconfig: 'server/tsconfig.json' });
runTests('client', clientTests, { tsconfig: 'tsconfig.json' });
runTests('electron', electronTests);
