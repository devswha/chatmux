import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_OPTIONS,
} from '../constants/constants';

import { ensureXtermFocusStyles } from './terminalStyles';

test('terminal typography prefers installed Nerd Fonts with platform monospace fallbacks', () => {
  assert.equal(TERMINAL_OPTIONS.fontFamily, TERMINAL_FONT_FAMILY);
  assert.match(TERMINAL_FONT_FAMILY, /^"JetBrainsMono Nerd Font",/);
  assert.match(TERMINAL_FONT_FAMILY, /"MesloLGS NF"/);
  assert.match(TERMINAL_FONT_FAMILY, /ui-monospace/);
  assert.doesNotMatch(TERMINAL_FONT_FAMILY, /Courier New/i);
  assert.match(TERMINAL_FONT_FAMILY, /Liberation Mono/);
});

test('xterm helper and IME text inherit the same responsive terminal font', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let appendedStyle: { id?: string; type?: string; innerText?: string } | null = null;
  const fakeDocument = {
    getElementById: () => null,
    createElement: () => ({}),
    head: {
      appendChild: (style: typeof appendedStyle) => {
        appendedStyle = style;
      },
    },
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: fakeDocument,
  });

  try {
    ensureXtermFocusStyles();
    const style = appendedStyle as { id?: string; innerText?: string } | null;
    assert.ok(style);
    assert.equal(style.id, 'shell-xterm-style');
    assert.match(style.innerText ?? '', /ui-monospace/);
    assert.match(style.innerText ?? '', /--shell-terminal-font-size/);
    assert.match(style.innerText ?? '', /\.composition-view/);
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  }
});
