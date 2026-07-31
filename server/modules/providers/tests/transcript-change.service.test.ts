import assert from 'node:assert/strict';
import test from 'node:test';

import {
  markTranscriptChanged,
  onTranscriptChanged,
  transcriptChangeVersion,
} from '@/modules/providers/services/transcript-change.service.js';

test('transcript invalidation is session-scoped with provider-wide failure fallback', () => {
  const first = `first-${Date.now()}`;
  const second = `second-${Date.now()}`;
  const firstBefore = transcriptChangeVersion('codex', first);
  const secondBefore = transcriptChangeVersion('codex', second);
  const observed: Array<{ providerSessionId: string | null }> = [];
  const unsubscribe = onTranscriptChanged((change) => {
    if (change.provider === 'codex') observed.push({ providerSessionId: change.providerSessionId });
  });

  markTranscriptChanged('codex', first);
  const firstAfter = transcriptChangeVersion('codex', first);
  assert.notEqual(firstAfter, firstBefore);
  assert.equal(transcriptChangeVersion('codex', second), secondBefore);

  markTranscriptChanged('codex');
  assert.notEqual(transcriptChangeVersion('codex', second), secondBefore);
  unsubscribe();
  assert.deepEqual(observed, [
    { providerSessionId: first },
    { providerSessionId: null },
  ]);
});

test('one failing transcript-change consumer cannot suppress another', () => {
  const id = `listener-${Date.now()}`;
  let called = 0;
  const stopFailing = onTranscriptChanged(() => { throw new Error('expected'); });
  const stopHealthy = onTranscriptChanged((change) => {
    if (change.providerSessionId === id) called += 1;
  });
  markTranscriptChanged('gjc', id);
  stopFailing();
  stopHealthy();
  assert.equal(called, 1);
});
