import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';

const root = process.argv[2];
if (!root) throw new Error('An isolated fixture root is required.');
Object.defineProperty(os, 'homedir', { value: () => root });
await initializeDatabase();
try {
  const synchronizer = new CodexSessionSynchronizer();
  const ids = JSON.parse(await readFile(path.join(root, 'cases.json'), 'utf8')) as string[];
  const results = [];
  for (const id of ids) {
    const sessionId = await synchronizer.synchronizeFile(path.join(root, `${id}.jsonl`));
    results.push({ id, title: sessionId ? sessionsDb.getSessionById(sessionId)?.custom_name : null });
  }
  console.log(`TITLE_SCAN_RESULTS=${JSON.stringify(results)}`);
} finally {
  closeConnection();
}
