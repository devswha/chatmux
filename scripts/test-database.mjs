// Loaded after tsx, separately in each server test worker. Import-time auth and
// fleet initialization must never fall through to an operator's real database.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';

// Explicit Worker fixtures own their database and register scoped TS loaders.
// Node 22 does not install the process-level tsx hooks in those worker threads.
if (isMainThread) {
  const directory = mkdtempSync(path.join(tmpdir(), 'chatmux-test-db-'));
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  const { closeConnection } = await import('../server/modules/database/connection.ts');
  const { initializeDatabase } = await import('../server/modules/database/init-db.ts');
  const log = console.log;
  process.once('exit', () => {
    console.log = () => undefined;
    try { closeConnection(); } finally { rmSync(directory, { recursive: true, force: true }); console.log = log; }
  });
  console.log = () => undefined;
  try { await initializeDatabase(); } finally { console.log = log; }
}
