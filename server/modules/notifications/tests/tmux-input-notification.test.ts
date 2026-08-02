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
