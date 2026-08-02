import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HERDR_CAPABILITIES_ENV,
  HERDR_RUNTIME_ENV,
  HERDR_SOURCES_ENV,
  herdrSourceId,
  readHerdrRuntimeConfig,
} from '../herdr-config.service.js';

const source = { alias: 'alpha', selector: 'work', binary: '/opt/herdr/herdr' };
function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { [HERDR_RUNTIME_ENV]: '1', [HERDR_SOURCES_ENV]: JSON.stringify([source]), ...overrides };
}

test('Herdr source IDs are deterministic opaque public IDs', () => {
  assert.equal(herdrSourceId('alpha'), 'hsrc_jtP2rWhblZ6tcCJRjhr3bA');
  assert.equal(herdrSourceId('alpha'), herdrSourceId('alpha'));
  assert.notEqual(herdrSourceId('alpha'), herdrSourceId('beta'));
});

test('Herdr configuration is opt-in, linux x64 only, and never enables create', () => {
  assert.equal(readHerdrRuntimeConfig({}, 'linux', 'x64').enabled, false);
  for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'arm64']] as const) {
    const config = readHerdrRuntimeConfig(env(), platform, arch);
    assert.deepEqual(config, { enabled: false, sources: [], startupCapabilities: { discovery: false, output: false, actions: false, attach: false, create: false }, policyPath: null, errorCode: 'platform_unsupported' });
  }
  const config = readHerdrRuntimeConfig(env({ [HERDR_CAPABILITIES_ENV]: 'discovery,output,actions,attach' }), 'linux', 'x64');
  assert.equal(config.enabled, true);
  assert.deepEqual(config.startupCapabilities, { discovery: true, output: true, actions: true, attach: true, create: false });
  assert.deepEqual(config.sources, [{ ...source, sourceId: herdrSourceId('alpha') }]);
});

test('Herdr configuration rejects malformed capabilities and unsafe source declarations', () => {
  for (const capabilities of ['create', 'discovery,discovery', 'output,unknown']) {
    assert.equal(readHerdrRuntimeConfig(env({ [HERDR_CAPABILITIES_ENV]: capabilities }), 'linux', 'x64').errorCode, 'invalid_capabilities');
  }
  const invalidSources: unknown[] = [
    [],
    [{ ...source, selector: 'default' }],
    [{ ...source, binary: 'relative/herdr' }],
    [{ ...source, binary: '/tmp/herdr\0bad' }],
    [{ ...source, extra: true }],
    [source, { ...source, selector: 'other' }],
    Array.from({ length: 9 }, (_, index) => ({ ...source, alias: `source${index}` })),
  ];
  for (const sources of invalidSources) {
    const config = readHerdrRuntimeConfig(env({ [HERDR_SOURCES_ENV]: JSON.stringify(sources) }), 'linux', 'x64');
    assert.equal(config.enabled, false);
    assert.equal(config.errorCode, 'invalid_sources');
    assert.deepEqual(config.sources, []);
  }
  assert.equal(readHerdrRuntimeConfig(env({ [HERDR_SOURCES_ENV]: '{' }), 'linux', 'x64').errorCode, 'invalid_sources');
  assert.equal(readHerdrRuntimeConfig(env({ [HERDR_SOURCES_ENV]: 'x'.repeat(16 * 1024 + 1) }), 'linux', 'x64').errorCode, 'invalid_sources');
});
