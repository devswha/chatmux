import { useCallback, useRef } from 'react';

import { openPinnedSession, resolvePinnedSession, type PinInventory, type ResolvedPinnedSession } from './pinnedSessionInventory';
import { pinnedSessionKey, type PinnedSession } from './pinnedSessions';
import { usePinnedSessions } from './usePinnedSessions';

export function usePinnedSessionNavigation(inventory: PinInventory, onOpen: (target: ResolvedPinnedSession) => void) {
  const state = usePinnedSessions();
  const { pins, toggle } = state;
  // A retained handler must consult current inventory even after its row vanishes.
  const latest = useRef({ inventory, pins, onOpen });
  latest.current = { inventory, pins, onOpen };

  const openPin = useCallback((pin: PinnedSession) => {
    return openPinnedSession(pin, latest.current.inventory, latest.current.onOpen);
  }, []);

  const togglePin = useCallback((pin: PinnedSession) => {
    const current = latest.current;
    const isPinned = current.pins.some((candidate) => pinnedSessionKey(candidate) === pinnedSessionKey(pin));
    if (isPinned || resolvePinnedSession(pin, current.inventory) !== null) toggle(pin);
  }, [toggle]);

  return { ...state, openPin, togglePin };
}
