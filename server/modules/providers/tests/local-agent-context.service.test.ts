import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateLocalAgentContext } from '@/modules/providers/services/local-agent-context.service.js';

test('local agent context rejects a different HOME without binding the process', async () => {
  const alternateHome = await mkdtemp(path.join(os.tmpdir(), 'chatmux-agent-home-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { ...process.env, HOME: alternateHome },
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  try {
    const startedAtMs = (await stat(`/proc/${child.pid}`)).mtimeMs;
    assert.equal(await validateLocalAgentContext({
      pid: child.pid!,
      startedAtMs,
      socketPath: path.join(alternateHome, 'missing-tmux.sock'),
    }), 'agent_home_mismatch');
  } finally {
    child.kill('SIGKILL');
  }
});
