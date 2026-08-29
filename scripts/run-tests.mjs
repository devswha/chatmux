import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:js|ts|tsx)$/;
const SKIPPED_DIRECTORIES = new Set(['dist', 'dist-server', 'node_modules']);
export const REAL_RESOURCE_TESTS = Object.freeze([
  'server/gjc-core-host.test.ts',
  'server/modules/fleet/tests/task-12-remote-terminal.live.test.ts',
  'server/modules/providers/tests/tmux-runtime.e2e.test.ts',
  'server/modules/providers/tests/tmux-fleet.e2e.test.ts',
  'server/modules/providers/tests/tmux-fleet-lifecycle.e2e.test.ts',
  'server/modules/fleet/tests/task-23-chat-approval.e2e.test.ts',
  'server/modules/fleet/tests/task-23-discovery-reads.e2e.test.ts',
  'server/modules/fleet/tests/task-23-recovery-isolation.e2e.test.ts',
  'server/modules/fleet/tests/task-23-terminal-spawn-terminate.e2e.test.ts',
]);
const REAL_RESOURCE_TEST_SET = new Set(REAL_RESOURCE_TESTS);

function meetsMinimumNodeVersion() {
  const [nodeMajor, nodeMinor, nodePatch] = process.versions.node.split('.').map(Number);
  return (nodeMajor === 22 && (nodeMinor > 22 || (nodeMinor === 22 && nodePatch >= 2))) ||
    (nodeMajor === 24 && (nodeMinor > 15 || (nodeMinor === 15 && nodePatch >= 0)));
}

function shouldSkipDirectory(root, entryName) {
  return SKIPPED_DIRECTORIES.has(entryName) || (entryName === 'release' && root !== 'scripts');
}

export async function collectTests(root) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && shouldSkipDirectory(root, entry.name)) continue;
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

export function partitionServerTests(files) {
  if (new Set(files).size !== files.length) throw new Error('[test] duplicate server test files were discovered.');
  const discovered = new Set(files);
  const missing = REAL_RESOURCE_TESTS.filter((file) => !discovered.has(file));
  if (missing.length > 0) throw new Error(`[test] real-resource files are missing: ${missing.join(', ')}`);
  return {
    regular: files.filter((file) => !REAL_RESOURCE_TEST_SET.has(file)),
    realResources: REAL_RESOURCE_TESTS,
  };
}

export function runTests(label, files, { tsconfig, testConcurrency } = {}) {
  if (files.length === 0) {
    throw new Error(`[test] ${label}: no test files were discovered.`);
  }

  console.log(`\n[test] ${label}: ${files.length} files`);
  const runtime = tsconfig ? ['--import', 'tsx'] : [];
  const concurrency = testConcurrency === undefined ? [] : [`--test-concurrency=${testConcurrency}`];
  const args = [...runtime, '--test', ...concurrency, ...files];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: tsconfig ? { ...process.env, TSX_TSCONFIG_PATH: tsconfig } : process.env,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export async function discoverTests() {
  const [serverTests, scriptTests, clientTests] = await Promise.all([
    collectTests('server'),
    collectTests('scripts'),
    collectTests('src'),
  ]);

  return {
    serverTests: [...serverTests, ...scriptTests].sort(),
    clientTests,
  };
}

async function main() {
  if (!meetsMinimumNodeVersion()) {
    console.error(
      `[test] Node 22.22.2+ (22.x) or 24.15.0+ (24.x) is required; current runtime is Node ${process.versions.node}.`,
    );
    process.exit(1);
  }

  const { serverTests, clientTests } = await discoverTests();
  const server = partitionServerTests(serverTests);
  runTests('server', server.regular, { tsconfig: 'server/tsconfig.json' });
  runTests('server real tmux/PTY', server.realResources, { tsconfig: 'server/tsconfig.json', testConcurrency: 1 });
  runTests('client', clientTests, { tsconfig: 'tsconfig.json' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
