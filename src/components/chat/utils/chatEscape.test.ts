import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatEscapeHandler } from './chatEscape';

test('native select and option Escape cannot trigger chat abort or cancel native handling', () => {
  let aborts = 0;
  const handler = createChatEscapeHandler(() => { aborts += 1; });
  for (const tag of ['SELECT', 'OPTION']) {
    const target = Object.assign(new EventTarget(), {
      tagName: tag,
      closest: (selector: string) => selector === 'select' ? { tagName: 'SELECT' } : null,
    });
    target.addEventListener('keydown', handler as EventListener, { capture: true });
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape', repeat: false });
    target.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(aborts, 0);
});

test('ordinary Escape still aborts once; repeated, consumed, and other keys do not', () => {
  let aborts = 0;
  const target = new EventTarget();
  target.addEventListener('keydown', createChatEscapeHandler(() => { aborts += 1; }) as EventListener, { capture: true });
  const send = (key: string, repeat = false, prevented = false) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key, repeat });
    if (prevented) event.preventDefault();
    target.dispatchEvent(event);
    return event;
  };
  send('Enter');
  send('Escape', true);
  send('Escape', false, true);
  assert.equal(aborts, 0);
  assert.equal(send('Escape').defaultPrevented, true);
  assert.equal(aborts, 1);
});
