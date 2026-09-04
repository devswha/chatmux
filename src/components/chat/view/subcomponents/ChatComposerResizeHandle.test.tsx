import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import '../../../../i18n/config';

import ChatComposerResizeHandle from './ChatComposerResizeHandle';

test('composer resize handle grows upward, supports keyboard changes, and resets', () => {
  const heights: number[] = [];
  let resets = 0;
  let renderer: ReactTestRenderer;
  const textareaRef = {
    current: {
      getBoundingClientRect: () => ({ height: 120 }),
    } as unknown as HTMLTextAreaElement,
  };

  act(() => {
    renderer = TestRenderer.create(createElement(ChatComposerResizeHandle, {
      textareaRef,
      textareaHeight: null,
      onHeightChange: (height) => { heights.push(height); },
      onHeightReset: () => { resets += 1; },
    }));
  });

  const handle = renderer!.root.findByProps({ role: 'separator' });
  const capturedPointers = new Set<number>();
  const currentTarget = {
    setPointerCapture: (pointerId: number) => { capturedPointers.add(pointerId); },
    hasPointerCapture: (pointerId: number) => capturedPointers.has(pointerId),
    releasePointerCapture: (pointerId: number) => { capturedPointers.delete(pointerId); },
  };
  const preventDefault = () => {};

  act(() => {
    handle.props.onPointerDown({
      button: 0,
      clientY: 300,
      currentTarget,
      pointerId: 7,
      pointerType: 'mouse',
      preventDefault,
    });
    handle.props.onPointerMove({
      clientY: 240,
      currentTarget,
      pointerId: 7,
      preventDefault,
    });
    handle.props.onPointerUp({ currentTarget, pointerId: 7 });
    handle.props.onKeyDown({ key: 'ArrowUp', shiftKey: false, preventDefault });
    handle.props.onKeyDown({ key: 'ArrowDown', shiftKey: true, preventDefault });
    handle.props.onKeyDown({ key: 'Home', shiftKey: false, preventDefault });
    handle.props.onDoubleClick();
  });

  assert.deepEqual(heights, [180, 144, 72]);
  assert.equal(resets, 2);
  assert.equal(capturedPointers.size, 0);
  assert.equal(handle.props['aria-valuemin'], 56);
  assert.equal(handle.props['aria-valuemax'], 480);

  act(() => { renderer!.unmount(); });
});
