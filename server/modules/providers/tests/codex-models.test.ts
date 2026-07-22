import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseCodexTurnModel,
  readCodexSessionModelFromJsonl,
} from '@/modules/providers/list/codex/codex-models.provider.js';

test('parseCodexTurnModel accepts only turn_context model metadata', () => {
  assert.equal(
    parseCodexTurnModel(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } })),
    'gpt-5.6-sol',
  );
  assert.equal(parseCodexTurnModel(JSON.stringify({ type: 'session_meta', payload: { model: 'wrong' } })), null);
  assert.equal(parseCodexTurnModel('{incomplete'), null);
});

test('readCodexSessionModelFromJsonl follows appended model changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatmux-codex-model-'));
  const rolloutPath = path.join(root, 'rollout.jsonl');

  try {
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'session-1' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      '',
    ].join('\n'));

    assert.deepEqual(await readCodexSessionModelFromJsonl(rolloutPath), { model: 'gpt-5.5' });

    await appendFile(rolloutPath, `${JSON.stringify({
      type: 'turn_context',
      payload: { model: 'openai-codex/gpt-5.6-sol' },
    })}\n`);

    assert.deepEqual(
      await readCodexSessionModelFromJsonl(rolloutPath),
      { model: 'openai-codex/gpt-5.6-sol' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
