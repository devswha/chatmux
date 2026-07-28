import assert from 'node:assert/strict';
import test from 'node:test';

import { updateProjectDisplayName } from '@/modules/projects/services/project-management.service.js';

test('updateProjectDisplayName trims display names before persisting', () => {
  let projectId: string | undefined;
  let customName: string | null | undefined;

  updateProjectDisplayName('project-1', '  My Project  ', {
    updateCustomProjectNameById: (id, name) => {
      projectId = id;
      customName = name;
    },
  });

  assert.equal(projectId, 'project-1');
  assert.equal(customName, 'My Project');
});

test('updateProjectDisplayName writes null for blank and non-string display names', () => {
  const persistedNames: Array<string | null> = [];

  for (const displayName of ['   ', '', null, 42]) {
    updateProjectDisplayName('project-1', displayName, {
      updateCustomProjectNameById: (_id, name) => {
        persistedNames.push(name);
      },
    });
  }

  assert.deepEqual(persistedNames, [null, null, null, null]);
});