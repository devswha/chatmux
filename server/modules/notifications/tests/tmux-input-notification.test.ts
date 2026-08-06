import assert from 'node:assert/strict';
import test from 'node:test';

import {
  notifyTmuxInputRequiredIfWatched,
  tmuxInputNotificationsEnabled,
} from '@/modules/notifications/services/tmux-input-notification.service.js';

test('CHATMUX_LIVE_NOTIFY=0 disables the screen INPUT notification producer', () => {
  const previous = process.env.CHATMUX_LIVE_NOTIFY;
  try {
    process.env.CHATMUX_LIVE_NOTIFY = '0';
    assert.equal(tmuxInputNotificationsEnabled(), false);
    assert.doesNotThrow(() => notifyTmuxInputRequiredIfWatched(null as never, 'screen-occurrence'));
    process.env.CHATMUX_LIVE_NOTIFY = '1';
    assert.equal(tmuxInputNotificationsEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.CHATMUX_LIVE_NOTIFY;
    else process.env.CHATMUX_LIVE_NOTIFY = previous;
  }
});

test('does not consume INPUT transitions that were not preceded by RUN', () => {
  const previous = process.env.CHATMUX_LIVE_NOTIFY;
  const target = new Proxy({}, {
    get: () => { throw new Error('notification target must not be resolved'); },
  });
  try {
    process.env.CHATMUX_LIVE_NOTIFY = '1';
    assert.doesNotThrow(() => notifyTmuxInputRequiredIfWatched(
      target as never,
      'screen-occurrence',
      { state: 'needs_input', previous: 'unknown', changedAt: Date.now() },
    ));
  } finally {
    if (previous === undefined) delete process.env.CHATMUX_LIVE_NOTIFY;
    else process.env.CHATMUX_LIVE_NOTIFY = previous;
  }
});
