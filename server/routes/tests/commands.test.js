import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeModelsCommand, resolveCustomCommandPath } from '../commands.js';
import { providerModelsService } from '../../modules/providers/services/provider-models.service.js';

test('models command returns available models only for the active provider', async () => {
  const originalGetProviderModels = providerModelsService.getProviderModels;
  const originalGetCurrentActiveModel = providerModelsService.getCurrentActiveModel;
  let getCurrentActiveModelCalls = 0;

  providerModelsService.getProviderModels = async () => ({
    models: {
      OPTIONS: [{ value: 'gpt-5.4', label: 'gpt-5.4' }],
      DEFAULT: 'gpt-5.4',
    },
    cache: {
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-04T00:00:00.000Z',
      source: 'fresh',
    },
  });
  providerModelsService.getCurrentActiveModel = async () => {
    getCurrentActiveModelCalls += 1;
    return {
      model: 'gpt-5.3-codex',
    };
  };

  try {
    const result = await executeModelsCommand([], {
      provider: 'codex',
      model: 'gpt-5.4',
    });

    assert.equal(result.type, 'builtin');
    assert.equal(result.action, 'models');
    assert.equal(result.data.current.provider, 'codex');
    assert.equal(result.data.current.model, 'gpt-5.4');
    assert.deepEqual(Object.keys(result.data.available), ['codex']);
    assert.deepEqual(result.data.available.codex, result.data.availableModels);
    assert.ok(result.data.availableModels.includes('gpt-5.4'));
    assert.equal(result.data.available.claude, undefined);
    assert.equal(result.data.available.cursor, undefined);
    assert.equal(getCurrentActiveModelCalls, 0);
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    providerModelsService.getCurrentActiveModel = originalGetCurrentActiveModel;
  }
});

test('models command falls back to claude for unsupported providers', async () => {
  const originalGetProviderModels = providerModelsService.getProviderModels;
  const originalGetCurrentActiveModel = providerModelsService.getCurrentActiveModel;

  providerModelsService.getProviderModels = async () => ({
    models: {
      OPTIONS: [{ value: 'default', label: 'Default (recommended)' }],
      DEFAULT: 'default',
    },
    cache: {
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-04T00:00:00.000Z',
      source: 'fresh',
    },
  });
  providerModelsService.getCurrentActiveModel = async () => ({
    model: 'default',
  });

  try {
    const result = await executeModelsCommand([], {
      provider: 'unknown-provider',
    });

    assert.equal(result.data.current.provider, 'claude');
    assert.deepEqual(Object.keys(result.data.available), ['claude']);
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    providerModelsService.getCurrentActiveModel = originalGetCurrentActiveModel;
  }
});
test('custom command resolution rejects symlinks outside the canonical command directory', async () => {
  const tempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'commands-route-')));
  const projectRoot = path.join(tempDir, 'project');
  const commandsDir = path.join(projectRoot, '.claude', 'commands');
  const outsideFile = path.join(tempDir, 'outside.md');
  const commandFile = path.join(commandsDir, 'valid.md');
  const escapedCommand = path.join(commandsDir, 'escaped.md');

  try {
    await mkdir(commandsDir, { recursive: true });
    await Promise.all([
      writeFile(commandFile, '# valid'),
      writeFile(outsideFile, '# outside'),
      symlink(outsideFile, escapedCommand, 'file'),
      symlink(path.join(tempDir, 'missing.md'), path.join(commandsDir, 'dangling.md'), 'file'),
    ]);

    assert.equal(
      await resolveCustomCommandPath(commandFile, commandsDir, projectRoot),
      commandFile,
    );
    assert.equal(
      await resolveCustomCommandPath(escapedCommand, commandsDir, projectRoot),
      null,
    );
    assert.equal(
      await resolveCustomCommandPath(path.join(commandsDir, 'dangling.md'), commandsDir, projectRoot),
      null,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
