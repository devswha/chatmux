import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { safeLocalStorage } from '../utils/chatStorage';
import {
  CHAT_COMPOSER_MAX_HEIGHT,
  CHAT_COMPOSER_MAX_VIEWPORT_RATIO,
  clampChatComposerHeight,
  parseStoredChatComposerHeight,
} from '../utils/chatComposerResize';

const CHAT_COMPOSER_HEIGHT_STORAGE_KEY = 'chat_composer_height_px';

function viewportHeight(): number {
  if (typeof window === 'undefined') return 960;
  return window.visualViewport?.height ?? window.innerHeight;
}

export function useChatComposerHeight(textareaRef: RefObject<HTMLTextAreaElement>) {
  // The resize handle derives its ARIA values and keyboard steps during render.
  // Publish viewport changes without overwriting the user's preferred height.
  const [, setViewportHeight] = useState(viewportHeight);
  const [manualHeight, setManualHeightState] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null;
    const stored = parseStoredChatComposerHeight(
      safeLocalStorage.getItem(CHAT_COMPOSER_HEIGHT_STORAGE_KEY),
    );
    return stored === null
      ? null
      : clampChatComposerHeight(
          stored,
          CHAT_COMPOSER_MAX_HEIGHT / CHAT_COMPOSER_MAX_VIEWPORT_RATIO,
        );
  });
  const manualHeightRef = useRef<number | null>(manualHeight);

  const applyManualHeight = useCallback((target: HTMLTextAreaElement): number | null => {
    if (manualHeightRef.current === null) return null;
    const nextHeight = clampChatComposerHeight(manualHeightRef.current, viewportHeight());
    target.style.height = `${nextHeight}px`;
    return nextHeight;
  }, []);

  const setManualHeight = useCallback((height: number): number => {
    const nextHeight = clampChatComposerHeight(height, viewportHeight());
    manualHeightRef.current = nextHeight;
    setManualHeightState(nextHeight);
    safeLocalStorage.setItem(CHAT_COMPOSER_HEIGHT_STORAGE_KEY, String(nextHeight));
    if (textareaRef.current) {
      textareaRef.current.style.height = `${nextHeight}px`;
    }
    return nextHeight;
  }, [textareaRef]);

  const resetManualHeight = useCallback(() => {
    manualHeightRef.current = null;
    setManualHeightState(null);
    safeLocalStorage.removeItem(CHAT_COMPOSER_HEIGHT_STORAGE_KEY);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [textareaRef]);

  useEffect(() => {
    if (textareaRef.current) {
      applyManualHeight(textareaRef.current);
    }
  }, [applyManualHeight, manualHeight, textareaRef]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleViewportResize = () => {
      setViewportHeight(viewportHeight());
      if (textareaRef.current) {
        applyManualHeight(textareaRef.current);
      }
    };
    window.addEventListener('resize', handleViewportResize);
    window.visualViewport?.addEventListener('resize', handleViewportResize);
    return () => {
      window.removeEventListener('resize', handleViewportResize);
      window.visualViewport?.removeEventListener('resize', handleViewportResize);
    };
  }, [applyManualHeight, textareaRef]);

  return {
    manualHeight,
    manualHeightRef,
    applyManualHeight,
    setManualHeight,
    resetManualHeight,
  };
}
