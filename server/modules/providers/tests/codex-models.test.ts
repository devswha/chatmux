import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseCodexTurnActiveModel,
  readCodexSessionModelFromJsonl,
} from '@/modules/providers/list/codex/codex-models.provider.js';

test('parseCodexTurnActiveModel reads model and reasoning effort from turn context', () => {
  assert.deepEqual(
    parseCodexTurnActiveModel(JSON.stringify({
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    })),
    { model: 'gpt-5.6-sol', effort: 'xhigh' },
  );
  assert.equal(
    parseCodexTurnActiveModel(JSON.stringify({ type: 'session_meta', payload: { model: 'wrong' } })),
    null,
  );
  assert.equal(parseCodexTurnActiveModel('{incomplete'), null);
});

test('readCodexSessionModelFromJsonl follows appended model changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatmux-codex-model-'));
  const rolloutPath = path.join(root, 'rollout.jsonl');

  try {
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'session-1' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'medium' } }),
      '',
    ].join('\n'));

    assert.deepEqual(
      await readCodexSessionModelFromJsonl(rolloutPath),
      { model: 'gpt-5.5', effort: 'medium' },
    );

    await appendFile(rolloutPath, `${JSON.stringify({
      type: 'turn_context',
      payload: { model: 'openai-codex/gpt-5.6-sol', effort: 'xhigh' },
    })}\n`);

    assert.deepEqual(
      await readCodexSessionModelFromJsonl(rolloutPath),
      { model: 'openai-codex/gpt-5.6-sol', effort: 'xhigh' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
