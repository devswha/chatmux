import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';

test('database connection creates private storage', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatmux-db-permissions-'));
  const databasePath = path.join(root, 'private', 'auth.db');
  const previousDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = databasePath;
  closeConnection();
  t.after(async () => {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  });

  getConnection();

  assert.equal(fs.statSync(path.dirname(databasePath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);
});
