import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseOmoModelCatalog } from '@/modules/providers/list/omo/omo-models.provider.js';
import { OmoSkillsProvider } from '@/modules/providers/list/omo/omo-skills.provider.js';

// Verbatim `omo --list-models` output: an aligned table, preceded by the
// startup notice the CLI writes before the table.
const LIST_MODELS_OUTPUT = [
  "config-watch user config discovery requires reload { userConfigCreationDiscovery: 'reload_required' }",
  'provider                model                    context  max-out  thinking  images',
  'alibaba-token-plan      deepseek-v3.2            131.1K   65.5K    yes       no    ',
  'alibaba-token-plan      kimi-k2.5                262.1K   98.3K    yes       yes   ',
  'alibaba-token-plan      deepseek-v3.2            131.1K   65.5K    yes       no    ',
  '',
].join('\n');

test('parseOmoModelCatalog reads the table, drops the header and startup noise, and dedupes', () => {
  const catalog = parseOmoModelCatalog(LIST_MODELS_OUTPUT);

  assert.equal(catalog.DEFAULT, 'default');
  assert.deepEqual(catalog.OPTIONS, [
    { value: 'default', label: 'Current CLI model' },
    {
      value: 'alibaba-token-plan/deepseek-v3.2',
      label: 'deepseek-v3.2',
      description: '131.1K context · alibaba-token-plan',
    },
    {
      value: 'alibaba-token-plan/kimi-k2.5',
      label: 'kimi-k2.5',
      description: '262.1K context · alibaba-token-plan',
    },
  ]);
});

test('parseOmoModelCatalog falls back when no row survives the shape guard', () => {
  for (const raw of [
    '',
    'provider                model                    context  max-out  thinking  images',
    "config-watch user config discovery requires reload { userConfigCreationDiscovery: 'reload_required' }",
    'alibaba-token-plan      deepseek-v3.2            131.1K   65.5K    maybe     no',
  ]) {
    const catalog = parseOmoModelCatalog(raw);
    assert.deepEqual(catalog.OPTIONS, [{ value: 'default', label: 'Current CLI model' }], raw.slice(0, 40));
    assert.equal(catalog.DEFAULT, 'default');
  }
});

class InspectableOmoSkillsProvider extends OmoSkillsProvider {
  sources(workspacePath: string) {
    return this.getSkillSources(workspacePath);
  }
}

test('omo skill sources use omo-owned roots and the native /skill: prefix', async () => {
  const workspacePath = '/tmp/chatmux-omo-skills-workspace';
  const sources = await new InspectableOmoSkillsProvider().sources(workspacePath);

  assert.ok(sources.some((source) => (
    source.rootDir === path.join(workspacePath, '.omo', 'skills')
    && source.scope === 'project'
    && source.commandPrefix === '/skill:'
  )));
  assert.ok(sources.some((source) => (
    source.rootDir === path.join(os.homedir(), '.omo', 'agent', 'skills')
    && source.scope === 'user'
    && source.commandPrefix === '/skill:'
  )));
  assert.ok(sources.every((source) => source.commandPrefix === '/skill:'));
  assert.ok(sources.every((source) => !source.rootDir.includes('/.omp/')));
});
