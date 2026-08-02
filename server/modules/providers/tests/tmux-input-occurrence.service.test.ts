import assert from 'node:assert/strict';
import test from 'node:test';

import { observeTmuxInputActivity } from '@/modules/providers/services/tmux-input-occurrence.service.js';

test('shares a stable INPUT occurrence between screen and transcript observers', () => {
  const identity = {
    provider: 'codex',
    providerSessionId: `cross-producer-${Date.now()}`,
  };

  observeTmuxInputActivity(identity, 'screen', false);
  const screenOccurrence = observeTmuxInputActivity(identity, 'screen', true);
  // The transcript's delayed RUN snapshot is stale; it must join the current
  // occurrence rather than advancing the sequence.
  observeTmuxInputActivity(identity, 'transcript', false);
  const transcriptOccurrence = observeTmuxInputActivity(identity, 'transcript', true);
  assert.ok(screenOccurrence);
  assert.equal(transcriptOccurrence, screenOccurrence);

  observeTmuxInputActivity(identity, 'screen', false);
  // Both observers see the real next RUN; only the first transition advances.
  observeTmuxInputActivity(identity, 'transcript', false);
  const nextScreenOccurrence = observeTmuxInputActivity(identity, 'screen', true);
  const nextTranscriptOccurrence = observeTmuxInputActivity(identity, 'transcript', true);
  assert.ok(nextScreenOccurrence);
  assert.notEqual(nextScreenOccurrence, screenOccurrence);
  assert.equal(nextTranscriptOccurrence, nextScreenOccurrence);
});
