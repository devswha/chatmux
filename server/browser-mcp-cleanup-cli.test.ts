import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  BrowserMcpCleanupCliError,
  cleanupExitCode,
  parseBrowserMcpCleanupArgs,
  redactedCleanupSummary,
  runBrowserMcpCleanupCli,
} from './browser-mcp-cleanup-cli.js';
import type { CleanupResult } from './modules/providers/services/chatmux-browser-mcp-cleanup.service.js';

const runId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const result = (status: CleanupResult['status']): CleanupResult => ({
  status,
  runId,
  receiptPath: '/safe/.chatmux/data/migrations/browser-mcp-cleanup/runs/receipt.json',
  providers: [
    {
      provider: 'claude',
      path: '/private/.claude.json',
      classification: 'exact-managed',
      status: 'written',
    },
  ],
});

test('parses only the exact explicit apply and rollback argv', () => {
  assert.deepEqual(parseBrowserMcpCleanupArgs(['apply']), { action: 'apply' });
  assert.deepEqual(parseBrowserMcpCleanupArgs(['rollback', '--run-id', runId]), { action: 'rollback', runId });

  for (const argv of [
    [],
    ['apply', '--path', '/tmp/config'],
    ['apply', '--latest'],
    ['rollback'],
    ['rollback', '--run-id'],
    ['rollback', '--run-id', 'not-a-uuid'],
    ['rollback', '--run-id=' + runId],
    ['rollback', '--run-id', runId, '--latest'],
  ]) {
    assert.throws(() => parseBrowserMcpCleanupArgs(argv), BrowserMcpCleanupCliError);
  }
});

test('apply calls only the injected service and prints a redacted summary', () => {
  let applyCalls = 0;
  const output: string[] = [];
  const exitCode = runBrowserMcpCleanupCli(['apply'], {
    applyBrowserMcpCleanup: () => { applyCalls += 1; return result('completed'); },
    rollbackBrowserMcpCleanup: () => { throw new Error('rollback must not run'); },
  }, line => output.push(line));

  assert.equal(applyCalls, 1);
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output[0]!), {
    status: 'completed',
    runId,
    receiptPath: result('completed').receiptPath,
    providers: [{ provider: 'claude', classification: 'exact-managed', status: 'written' }],
  });
  assert.equal(output[0]!.includes('/private/.claude.json'), false);
});

test('rollback requires a UUID and passes it unchanged to the injected service', () => {
  let receivedRunId: string | undefined;
  const exitCode = runBrowserMcpCleanupCli(['rollback', '--run-id', runId], {
    applyBrowserMcpCleanup: () => { throw new Error('apply must not run'); },
    rollbackBrowserMcpCleanup: id => { receivedRunId = id; return result('rolled_back'); },
  }, () => {});

  assert.equal(receivedRunId, runId);
  assert.equal(exitCode, 0);
});

test('does not print or remap service errors', () => {
  const output: string[] = [];
  assert.throws(() => runBrowserMcpCleanupCli(['apply'], {
    applyBrowserMcpCleanup: () => { throw new Error('provider secret must remain internal'); },
    rollbackBrowserMcpCleanup: () => result('rolled_back'),
  }, line => output.push(line)), /provider secret/);
  assert.deepEqual(output, []);
});

test('maps only completed statuses to zero and redacts provider paths', () => {
  for (const status of ['completed', 'completed_noop', 'rolled_back'] as const) {
    assert.equal(cleanupExitCode(status), 0);
  }
  for (const status of ['blocked', 'failed_compensated', 'rollback_conflict'] as const) {
    assert.equal(cleanupExitCode(status), 1);
  }

  const summary = redactedCleanupSummary(result('blocked'));
  assert.equal(summary.includes('/private/.claude.json'), false);
  assert.equal(summary.includes('exact-managed'), true);
});

test('the main CLI imports and invokes cleanup only from its explicit command branch', () => {
  const source = fs.readFileSync(new URL('./cli.js', import.meta.url), 'utf8');
  assert.match(source, /async function runBrowserMcpCleanup\(args\) \{\s+loadEnvFile\(\);\s+const \{ runBrowserMcpCleanupCli \} = await import\('\.\/browser-mcp-cleanup-cli\.js'\);/);
  assert.match(source, /case 'browser-mcp-cleanup': \{\s+const exitCode = await runBrowserMcpCleanup\(remainingArgs \|\| \[\]\);/);
  assert.equal((source.match(/runBrowserMcpCleanup\(/g) || []).length, 2);
});
