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
