import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import '../../../i18n/config';

import ChatComposerResizeHandle from '../view/subcomponents/ChatComposerResizeHandle';

import { useChatComposerHeight } from './useChatComposerHeight';

test('viewport changes keep the resize handle and keyboard steps aligned with the visible textarea', () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let storedHeight: string | null = '400';
  const viewport = Object.assign(new EventTarget(), { height: 600 });
  const page = Object.assign(new EventTarget(), { innerHeight: 600, visualViewport: viewport });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: page });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => storedHeight,
    setItem: (_key: string, value: string) => { storedHeight = value; },
    removeItem: () => { storedHeight = null; },
  } });
  const textareaRef = { current: { style: { height: '' } } as HTMLTextAreaElement };
  function Probe() {
    const height = useChatComposerHeight(textareaRef);
    return createElement(ChatComposerResizeHandle, {
      textareaRef, textareaHeight: height.manualHeight,
      onHeightChange: height.setManualHeight, onHeightReset: height.resetManualHeight,
    });
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    act(() => { renderer = TestRenderer.create(createElement(Probe)); });
    const separator = () => renderer!.root.findByProps({ role: 'separator' });
    assert.equal(textareaRef.current.style.height, '300px');
    assert.equal(separator().props['aria-valuenow'], 300);
    viewport.height = 1000;
    act(() => { viewport.dispatchEvent(new Event('resize')); });
    assert.equal(textareaRef.current.style.height, '400px');
    assert.equal(separator().props['aria-valuenow'], 400);
    assert.equal(separator().props['aria-valuemax'], 480);
    assert.equal(storedHeight, '400', 'viewport changes preserve the preferred height');
    act(() => { separator().props.onKeyDown({ key: 'ArrowUp', preventDefault() {} }); });
    assert.equal(textareaRef.current.style.height, '424px');
    viewport.height = 400;
    act(() => { viewport.dispatchEvent(new Event('resize')); });
    assert.equal(separator().props['aria-valuenow'], 200);
    act(() => { separator().props.onKeyDown({ key: 'ArrowDown', preventDefault() {} }); });
    assert.equal(textareaRef.current.style.height, '176px');
    // Android-style layout viewport changes also update the handle without a
    // visual viewport event.
    viewport.height = 300;
    act(() => { page.dispatchEvent(new Event('resize')); });
    assert.equal(separator().props['aria-valuenow'], 150);
    act(() => { renderer!.unmount(); });
    const heightBeforeResize = textareaRef.current.style.height;
    viewport.height = 800;
    viewport.dispatchEvent(new Event('resize'));
    page.dispatchEvent(new Event('resize'));
    assert.equal(textareaRef.current.style.height, heightBeforeResize);
  } finally {
    act(() => { renderer?.unmount(); });
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
