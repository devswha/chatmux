import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useKeyboardViewportInset } from './useKeyboardViewportInset';

test('keyboard inset initializes from the visible viewport and is released on unmount', () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const properties = new Map<string, string>();
  const viewport = Object.assign(new EventTarget(), { height: 480 });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    innerHeight: 800, visualViewport: viewport,
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    documentElement: { style: {
      setProperty: (key: string, value: string) => properties.set(key, value),
      removeProperty: (key: string) => properties.delete(key),
    } },
  } });
  function Probe() { useKeyboardViewportInset(); return null; }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    act(() => { renderer = TestRenderer.create(createElement(Probe)); });
    assert.equal(properties.get('--keyboard-height'), '320px');
    viewport.height = 600;
    act(() => { viewport.dispatchEvent(new Event('resize')); });
    assert.equal(properties.get('--keyboard-height'), '200px');
    act(() => { renderer!.unmount(); });
    assert.equal(properties.has('--keyboard-height'), false);
    viewport.height = 800;
    viewport.dispatchEvent(new Event('resize'));
    assert.equal(properties.has('--keyboard-height'), false, 'unmounted listener is removed');
    act(() => { renderer = TestRenderer.create(createElement(Probe)); });
    assert.equal(properties.get('--keyboard-height'), '0px');
  } finally {
    act(() => { renderer?.unmount(); });
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
