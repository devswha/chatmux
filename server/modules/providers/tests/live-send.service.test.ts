import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isValidTmuxName,
  isValidSpawnName,
  classifySpawnResponse,
  normalizeSpawnCwd,
} from '@/modules/providers/services/live-send.service.js';

test('isValidTmuxName accepts simple session tokens, rejects unsafe ones', () => {
  for (const ok of ['omg', 'magi-stock', 'flask', 'company-gjc', 'a.b_c-1']) {
    assert.equal(isValidTmuxName(ok), true, ok);
  }
  for (const bad of ['', ' omg', 'a b', 'a;b', 'a/b', '$(x)', '-lead', 42, null, undefined]) {
    assert.equal(isValidTmuxName(bad as unknown), false, String(bad));
  }
});


test('isValidSpawnName accepts safe names but rejects the reserved "company"', () => {
  for (const ok of ['patina', 'magi-stock', 'feat_x', 'a.b_c-1']) {
    assert.equal(isValidSpawnName(ok), true, ok);
  }
  for (const bad of ['company', 'Company', 'COMPANY', '', ' x', 'a b', 'a/b', 42, null]) {
    assert.equal(isValidSpawnName(bad as unknown), false, String(bad));
  }
});

test('classifySpawnResponse: 2xx ok, 409 conflict, 4xx failure (all reachable)', () => {
  assert.deepEqual(classifySpawnResponse(200, 'spawned patina'), {
    ok: true, reachable: true, conflict: false, detail: 'spawned patina',
  });
  const dup = classifySpawnResponse(409, 'name already exists');
  assert.equal(dup.ok, false);
  assert.equal(dup.conflict, true);
  assert.equal(dup.reachable, true);
  const failed = classifySpawnResponse(400, 'cwd must be under $HOME');
  assert.equal(failed.ok, false);
  assert.equal(failed.conflict, false);
});

// Regression: the tower resolves cwd with expanduser + realpath, so a bare
// HOME-relative value ("workspace/x") resolved against the tower's own process
// CWD (not necessarily $HOME) and every spawn was rejected with "not an
// existing directory under home". The proxy must send an explicit "~/" prefix.
test('normalizeSpawnCwd makes home-relative paths explicit and passes the rest through', () => {
  assert.equal(normalizeSpawnCwd('workspace/my-proj'), '~/workspace/my-proj');
  assert.equal(normalizeSpawnCwd('  workspace/my-proj '), '~/workspace/my-proj');
  assert.equal(normalizeSpawnCwd('~/workspace/my-proj'), '~/workspace/my-proj');
  assert.equal(normalizeSpawnCwd('~'), '~');
  assert.equal(normalizeSpawnCwd('/home/user/workspace'), '/home/user/workspace');
});
