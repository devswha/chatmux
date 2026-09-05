import { useCallback, useEffect, useRef, useState } from 'react';

import {
  browserPinStorage,
  PINNED_SESSIONS_KEY,
  pinnedSessionKey,
  readPinnedSessions,
  togglePinnedSession,
  writePinnedSessions,
  type PinnedSession,
} from './pinnedSessions';

export function usePinnedSessions() {
  const [pins, setPins] = useState(() => readPinnedSessions(browserPinStorage()));
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const pinsRef = useRef(pins);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== PINNED_SESSIONS_KEY) return;
      const storage = browserPinStorage();
      if (storage === null || (event.storageArea !== null && event.storageArea !== storage)) return;
      const next = readPinnedSessions(storage);
      pinsRef.current = next;
      setPins(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggle = useCallback((pin: PinnedSession) => {
    const next = togglePinnedSession(pinsRef.current, pin);
    if (next === pinsRef.current) return;
    pinsRef.current = next;
    setPins(next);
    setStorageUnavailable(!writePinnedSessions(browserPinStorage(), next));
  }, []);

  const unpin = useCallback((pin: PinnedSession) => {
    if (pinsRef.current.some((candidate) => pinnedSessionKey(candidate) === pinnedSessionKey(pin))) toggle(pin);
  }, [toggle]);

  return { pins, toggle, unpin, storageUnavailable };
}
