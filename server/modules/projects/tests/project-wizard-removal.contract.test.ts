import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('wizard, clone, and project creation routes stay removed while rename remains', () => {
  const projectRoutes = read('../projects.routes.ts');

  assert.doesNotMatch(projectRoutes, /project-clone|clone-progress|startCloneProject/);
  assert.doesNotMatch(projectRoutes, /router\.post\(\s*'\/create-project'/);
  assert.match(projectRoutes, /router\.put\('\/:projectId\/rename'/);
});

test('global browse routes stay removed while provider directory suggestions remain', () => {
  const fileRoutes = read('../../files/files.routes.js');
  const providerRoutes = read('../../providers/provider.routes.ts');

  assert.doesNotMatch(fileRoutes, /\/api\/browse-filesystem|\/api\/create-folder/);
  assert.match(providerRoutes, /\/fs\/dir-suggestions/);
});

test('wizard sources and clone service stay absent', () => {
  assert.equal(existsSync(new URL('../../../../src/components/project-creation-wizard', import.meta.url)), false);
  assert.equal(existsSync(new URL('../services/project-clone.service.ts', import.meta.url)), false);
});
