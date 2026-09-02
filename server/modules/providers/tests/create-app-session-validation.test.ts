import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { AppError } from '@/shared/utils.js';

test('browser-initiated project registration is refused outside the workspace policy or for missing directories', async () => {
  const rejectedByPolicy = await sessionsService.createAppSession('claude', '/etc', {
    validate: async () => ({ valid: false, error: 'Cannot use system-critical directories as workspace locations' }),
    isDirectory: async () => true,
  }).then(() => null, (error: unknown) => error);
  assert.ok(rejectedByPolicy instanceof AppError && rejectedByPolicy.code === 'INVALID_PROJECT_PATH' && rejectedByPolicy.statusCode === 400);

  const missing = await sessionsService.createAppSession('claude', '/home/owner/workspace/gone', {
    validate: async () => ({ valid: true }),
    isDirectory: async () => false,
  }).then(() => null, (error: unknown) => error);
  assert.ok(missing instanceof AppError && missing.code === 'PROJECT_PATH_NOT_FOUND');

  const empty = await sessionsService.createAppSession('claude', '   ').then(() => null, (error: unknown) => error);
  assert.ok(empty instanceof AppError && empty.code === 'PROJECT_PATH_REQUIRED', 'the existing empty-path contract is unchanged');
});
