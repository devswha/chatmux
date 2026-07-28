import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('plugin API, process manager, and websocket proxy stay absent', () => {
  assert.equal(existsSync(new URL('../../../routes/plugins.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../../../utils/plugin-loader.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../../../utils/plugin-process-manager.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../services/plugin-websocket-proxy.service.ts', import.meta.url)), false);

  const serverIndex = read('../../../index.js');
  assert.doesNotMatch(serverIndex, /\/api\/plugins|pluginsRoutes|getPluginPort|freezeAndDrainPlugins/);
});

test('shared websocket gateway keeps shell, chat, auth, and unknown-path close', () => {
  const gateway = read('../services/websocket-server.service.ts');

  assert.doesNotMatch(gateway, /plugin-ws|handlePluginWsProxy|getPluginPort/);
  assert.match(gateway, /pathname === '\/shell'/);
  assert.match(gateway, /pathname === '\/ws'/);
  assert.match(gateway, /verifyWebSocketClient/);
  assert.match(gateway, /ws\.close\(\)/);
  assert.ok(gateway.indexOf("pathname === '/shell'") < gateway.indexOf("pathname === '/ws'"));
});

test('client and development proxy expose no plugin surface', () => {
  assert.equal(existsSync(new URL('../../../../src/components/plugins', import.meta.url)), false);
  assert.equal(existsSync(new URL('../../../../src/contexts/PluginsContext.tsx', import.meta.url)), false);
  assert.doesNotMatch(read('../../../../vite.config.js'), /plugin-ws/);
});
