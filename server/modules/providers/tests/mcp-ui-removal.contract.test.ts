import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('MCP settings UI stays absent', () => {
  assert.equal(existsSync(new URL('../../../../src/components/mcp', import.meta.url)), false);
  const settingsContent = readFileSync(
    new URL('../../../../src/components/settings/view/tabs/agents-settings/sections/AgentCategoryContentSection.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(settingsContent, /McpServers|selectedCategory === 'mcp'/);
});

test('provider MCP backend and Browser cleanup remain available', () => {
  const routes = readFileSync(new URL('../provider.routes.ts', import.meta.url), 'utf8');
  const cleanup = readFileSync(
    new URL('../services/chatmux-browser-mcp-cleanup.service.ts', import.meta.url),
    'utf8',
  );

  assert.match(routes, /\/:provider\/mcp\/servers/);
  assert.match(routes, /\/mcp\/servers\/global/);
  assert.match(cleanup, /applyBrowserMcpCleanup/);
  assert.match(cleanup, /rollbackBrowserMcpCleanup/);
});
