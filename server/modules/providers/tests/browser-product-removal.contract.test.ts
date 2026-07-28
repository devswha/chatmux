import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('Browser product server runtime and old stdio entrypoint stay absent', () => {
  assert.equal(existsSync(new URL('../../browser-use', import.meta.url)), false);
  assert.equal(existsSync(new URL('../../../browser-use-mcp.ts', import.meta.url)), false);
});

test('server no longer mounts Browser product routes or stops Browser sessions', () => {
  const server = readSource('../../../index.js');

  assert.doesNotMatch(server, /modules\/browser-use/);
  assert.doesNotMatch(server, /\/api\/browser-use(?:-mcp)?/);
  assert.doesNotMatch(server, /browserUseService\.stopAllSessions/);
  assert.match(server, /app\.use\('\/api\/providers', authenticateToken, providerRoutes\)/);
});

test('CLI retains Browser cleanup while omitting the old Browser stdio command', () => {
  const cli = readSource('../../../cli.js');
  const cleanupCli = readSource('../../../browser-mcp-cleanup-cli.ts');
  const cleanupService = readSource('../services/chatmux-browser-mcp-cleanup.service.ts');
  const providerRoutes = readSource('../provider.routes.ts');

  assert.doesNotMatch(cli, /browser-use-mcp/);
  assert.match(cli, /browser-mcp-cleanup/);
  assert.match(cli, /runBrowserMcpCleanupCli/);
  assert.match(cleanupCli, /applyBrowserMcpCleanup/);
  assert.match(cleanupCli, /rollbackBrowserMcpCleanup/);
  assert.match(cleanupService, /applyBrowserMcpCleanup/);
  assert.match(cleanupService, /rollbackBrowserMcpCleanup/);
  assert.match(providerRoutes, /\/:provider\/mcp\/servers/);
  assert.match(providerRoutes, /\/mcp\/servers\/global/);
});
