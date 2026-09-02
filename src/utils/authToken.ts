/**
 * Browser session marker.
 *
 * The password-mode credential is the httpOnly `chatmux_auth` cookie the server
 * sets on login and slides while it is used. It is deliberately unreadable from
 * JavaScript: an XSS in a UI that renders agent output must not be able to
 * lift a token that lives for up to a year. The browser therefore never stores
 * the JWT; this module only remembers whether a session is believed to be
 * active, plus a generation counter so a response from before a login or
 * logout cannot overwrite state from after it.
 */
export const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

export type SessionSnapshot = {
  active: boolean;
  generation: number;
};

type SessionListener = (snapshot: SessionSnapshot) => void;

let active = false;
let generation = 0;
const listeners = new Set<SessionListener>();

/**
 * Older builds persisted the JWT itself under `auth-token`. Remove it once so
 * a leftover copy cannot be read by anything else on the origin; the cookie
 * set at the same login keeps the user signed in.
 */
export const forgetLegacyStoredToken = (): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    // Storage may be unavailable (private mode, blocked site data); nothing to remove then.
  }
};

const notify = () => {
  const snapshot = getSessionSnapshot();
  for (const listener of listeners) listener(snapshot);
};

export const getSessionSnapshot = (): SessionSnapshot => ({ active, generation });

/**
 * Only a login or logout event invalidates in-flight work, so the generation
 * alone decides. Confirming that the cookie session already existed changes
 * `active` without starting a new generation and keeps earlier work current.
 */
export const isCurrentSessionSnapshot = (snapshot: SessionSnapshot): boolean =>
  getSessionSnapshot().generation === snapshot.generation;

/** Records a new session the user just created (login or register): a new generation. */
export const markSessionActive = (): SessionSnapshot => {
  if (active) return getSessionSnapshot();
  active = true;
  generation += 1;
  notify();
  return getSessionSnapshot();
};

/**
 * Records that the bootstrap probe found the cookie session still valid. Not
 * a new generation: nothing the user did happened, so work started before the
 * probe stays current and the bootstrap does not re-trigger itself.
 */
export const confirmSession = (): SessionSnapshot => {
  if (active) return getSessionSnapshot();
  active = true;
  notify();
  return getSessionSnapshot();
};

/** Records that no session is believed to exist (logout, or a rejected probe). */
export const clearSession = (): SessionSnapshot => {
  if (!active) return getSessionSnapshot();
  active = false;
  generation += 1;
  notify();
  return getSessionSnapshot();
};

export const subscribeSession = (listener: SessionListener): (() => void) => {
  listeners.add(listener);
  listener(getSessionSnapshot());
  return () => listeners.delete(listener);
};
