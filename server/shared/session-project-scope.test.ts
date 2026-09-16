import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isContainedTranscriptPath,
  resolveContainedJsonlPath,
  sessionBelongsToProject,
} from './session-project-scope.js';

test('Given a session row, when the project path matches, then membership holds after resolve', () => {
  assert.equal(sessionBelongsToProject('/workspace/app', '/workspace/app'), true);
  assert.equal(sessionBelongsToProject('/workspace/app/', '/workspace/app'), true);
  assert.equal(sessionBelongsToProject('/workspace/other', '/workspace/app'), false);
  assert.equal(sessionBelongsToProject(null, '/workspace/app'), false);
});

test('Given a resolved transcript path, when it stays under an allowed root, then it is contained', () => {
  const claude = '/home/owner/.claude';
  assert.equal(isContainedTranscriptPath('/home/owner/.claude/projects/app/session.jsonl', [claude]), true);
  assert.equal(isContainedTranscriptPath('/home/owner/.ssh/id_rsa', [claude]), false);
  assert.equal(isContainedTranscriptPath('/home/owner/.claude', [claude]), true);
});

test('Given an indexed jsonl path, when it escapes the allowed roots, then the read is refused', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'token-usage-scope-'));
  const allowed = path.join(root, 'claude');
  const outside = path.join(root, 'secret.jsonl');
  await mkdir(allowed);
  await writeFile(outside, 'secret\n');
  await symlink(outside, path.join(allowed, 'escaped.jsonl'));

  assert.equal(await resolveContainedJsonlPath(path.join(allowed, 'missing.jsonl'), [allowed]), null);
  assert.equal(await resolveContainedJsonlPath(path.join(allowed, 'escaped.jsonl'), [allowed]), null);
  const inside = path.join(allowed, 'session.jsonl');
  await writeFile(inside, '{}\n');
  assert.equal(await resolveContainedJsonlPath(inside, [allowed]), await realpath(inside));
});
