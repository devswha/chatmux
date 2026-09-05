/**
 * Adjusts the app container to stay above the virtual keyboard on iOS Safari.
 * On Chrome for Android the layout viewport already shrinks when the keyboard
 * opens, so inset-0 adjusts automatically. On iOS the layout viewport stays
 * full-height and the keyboard overlays it — track the keyboard height via the
 * Visual Viewport API and expose it as a CSS variable that shifts the
 * container's bottom edge up. Split from the former `AppContent.tsx`.
 */

import { useEffect } from 'react';

export function useKeyboardViewportInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Only resize matters — keyboard open/close changes vv.height.
      // Do NOT listen to scroll: on iOS Safari, scrolling content changes
      // vv.offsetTop which would make --keyboard-height fluctuate during
      // normal scrolling, causing the container to bounce up and down.
      const kb = Math.max(0, window.innerHeight - vv.height);
      document.documentElement.style.setProperty('--keyboard-height', `${kb}px`);
    };
    update();
    vv.addEventListener('resize', update);
    return () => {
      vv.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--keyboard-height');
    };
  }, []);
}
