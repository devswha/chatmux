import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('skills management UI stays absent', () => {
  assert.equal(existsSync(new URL('../../../../src/components/skills', import.meta.url)), false);
  const settingsContent = readFileSync(
    new URL('../../../../src/components/settings/view/tabs/agents-settings/sections/AgentCategoryContentSection.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(settingsContent, /ProviderSkills|selectedCategory === 'skills'/);
});

test('provider skill readers and live command consumers remain available', () => {
  const routes = readFileSync(new URL('../provider.routes.ts', import.meta.url), 'utf8');
  const liveCommands = readFileSync(new URL('../services/live-commands.service.ts', import.meta.url), 'utf8');
  const slashCommands = readFileSync(
    new URL('../../../../src/components/chat/hooks/useSlashCommands.ts', import.meta.url),
    'utf8',
  );

  assert.match(routes, /\/:provider\/skills/);
  assert.match(liveCommands, /listProviderSkills\("gjc"/);
  assert.match(slashCommands, /encodeURIComponent\(provider\)\}\/skills/);
});
