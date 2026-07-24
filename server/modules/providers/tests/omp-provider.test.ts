import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseOmpModelCatalog,
  parseOmpTranscriptActiveModelLine,
} from '@/modules/providers/list/omp/omp-models.provider.js';
import { OmpSkillsProvider } from '@/modules/providers/list/omp/omp-skills.provider.js';

test('parseOmpModelCatalog maps native selectors, reasoning levels, and context metadata', () => {
  const catalog = parseOmpModelCatalog(JSON.stringify({
    models: [
      {
        provider: 'openai-codex',
        id: 'gpt-5.6-sol',
        selector: 'openai-codex/gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        contextWindow: 200000,
        thinking: ['low', 'medium', 'high'],
      },
      {
        provider: 'anthropic',
        id: 'claude-sonnet-4-6',
        selector: 'anthropic/claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        contextWindow: 200000,
        thinking: [],
      },
      {
        selector: 'openai-codex/gpt-5.6-sol',
        name: 'Duplicate',
      },
    ],
  }));

  assert.equal(catalog.DEFAULT, 'default');
  assert.deepEqual(catalog.OPTIONS, [
    { value: 'default', label: 'Current CLI model' },
    {
      value: 'openai-codex/gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      description: '200,000 token context',
      effort: {
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      },
    },
    {
      value: 'anthropic/claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      description: '200,000 token context',
    },
  ]);
});

test('parseOmpModelCatalog rejects malformed model payloads without inventing rows', () => {
  assert.deepEqual(parseOmpModelCatalog('{"models":[null,{},42]}'), {
    OPTIONS: [{ value: 'default', label: 'Current CLI model' }],
    DEFAULT: 'default',
  });
  assert.throws(() => parseOmpModelCatalog('not-json'), SyntaxError);
});

test('OMP transcript metadata exposes model and thinking level', () => {
  assert.deepEqual(
    parseOmpTranscriptActiveModelLine(JSON.stringify({
      type: 'model_change',
      model: 'openai-codex/gpt-5.6-sol',
    })),
    { model: 'openai-codex/gpt-5.6-sol' },
  );
  assert.deepEqual(
    parseOmpTranscriptActiveModelLine(JSON.stringify({
      type: 'thinking_level_change',
      thinkingLevel: 'high',
    })),
    { effort: 'high' },
  );
  assert.equal(
    parseOmpTranscriptActiveModelLine(JSON.stringify({
      type: 'thinking_level_change',
      thinkingLevel: 'inherit',
    })),
    null,
  );
  assert.deepEqual(
    parseOmpTranscriptActiveModelLine(JSON.stringify({
      type: 'configured_model_chain',
      entries: ['openai-codex/gpt-5.6-sol:xhigh'],
    })),
    { effort: 'xhigh' },
  );
});

class InspectableOmpSkillsProvider extends OmpSkillsProvider {
  sources(workspacePath: string) {
    return this.getSkillSources(workspacePath);
  }
}

test('Oh My Pi skill sources use the native /skill: invocation prefix', async () => {
  const workspacePath = '/tmp/chatmux-omp-skills-workspace';
  const sources = await new InspectableOmpSkillsProvider().sources(workspacePath);
  assert.ok(sources.some((source) => (
    source.rootDir === `${workspacePath}/.omp/skills`
    && source.scope === 'project'
    && source.commandPrefix === '/skill:'
  )));
  assert.ok(sources.some((source) => (
    source.rootDir.endsWith('/.omp/agent/skills')
    && source.scope === 'user'
    && source.commandPrefix === '/skill:'
  )));
  assert.ok(sources.some((source) => (
    source.rootDir.endsWith('/.codex/skills')
    && source.scope === 'user'
    && source.commandPrefix === '/skill:'
  )));
  assert.ok(sources.every((source) => source.commandPrefix === '/skill:'));
});
