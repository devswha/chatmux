import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import {
  clearSession as clearSessionMarker,
  forgetLegacyStoredToken,
  getSessionSnapshot,
  isCurrentSessionSnapshot,
  markSessionActive,
  subscribeSession,
  type SessionSnapshot,
} from '../../../utils/authToken';
import { AUTH_ERROR_MESSAGES } from '../constants';
import type {
  AuthActionResult,
  AuthContextValue,
  AuthProviderProps,
  AuthSessionPayload,
  AuthStatusPayload,
  AuthUser,
  AuthUserPayload,
  AuthMode,
  OnboardingStatusPayload,
} from '../types';
import { parseJsonSafely, resolveApiErrorMessage } from '../utils';

const AuthContext = createContext<AuthContextValue | null>(null);

// Builds before cookie-only sessions kept the JWT in localStorage; drop that
// copy on first load. The cookie set at the same login keeps the user signed in.
forgetLegacyStoredToken();

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [sessionGeneration, setSessionGeneration] = useState<number>(() => getSessionSnapshot().generation);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mutationRef = useRef(0);
  const onboardingAbortRef = useRef<AbortController | null>(null);
  const bootstrapAbortRef = useRef<AbortController | null>(null);

  const isCurrent = useCallback((snapshot: SessionSnapshot, mutation: number) =>
    mutationRef.current === mutation && isCurrentSessionSnapshot(snapshot), []);

  const resetOnboarding = useCallback(() => {
    onboardingAbortRef.current?.abort();
    onboardingAbortRef.current = null;
    setHasCompletedOnboarding(true);
  }, []);

  // The server confirmed a session: the httpOnly cookie is the credential, the
  // browser only records that it exists.
  const setSession = useCallback((nextUser: AuthUser) => {
    resetOnboarding();
    setUser(nextUser);
    markSessionActive();
  }, [resetOnboarding]);

  const clearSession = useCallback(() => {
    resetOnboarding();
    setUser(null);
    clearSessionMarker();
  }, [resetOnboarding]);

  useEffect(() => subscribeSession((snapshot) => {
    setSessionGeneration(snapshot.generation);
    resetOnboarding();
  }), [resetOnboarding]);

  const checkOnboardingStatus = useCallback(async (snapshot = getSessionSnapshot(), mutation = mutationRef.current) => {
    if (!snapshot.active) return;
    onboardingAbortRef.current?.abort();
    const controller = new AbortController();
    onboardingAbortRef.current = controller;

    try {
      const response = await api.user.onboardingStatus({ signal: controller.signal });
      if (!isCurrent(snapshot, mutation) || controller.signal.aborted || !response.ok) return;
      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      if (isCurrent(snapshot, mutation) && !controller.signal.aborted) {
        setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
      }
    } catch (caughtError) {
      if (!isCurrent(snapshot, mutation) || controller.signal.aborted) return;
      console.error('Error checking onboarding status:', caughtError);
      setHasCompletedOnboarding(true);
    } finally {
      if (onboardingAbortRef.current === controller) onboardingAbortRef.current = null;
    }
  }, [isCurrent]);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  useEffect(() => {
    const controller = new AbortController();
    bootstrapAbortRef.current = controller;
    const snapshot = getSessionSnapshot();
    const mutation = mutationRef.current;

    const checkAuthStatus = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const statusResponse = await api.auth.status({ signal: controller.signal });
        if (!statusResponse.ok) {
          throw new Error(`Auth status request failed with HTTP ${statusResponse.status}`);
        }
        const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);
        if (!isCurrent(snapshot, mutation) || controller.signal.aborted) return;
        setAuthMode(statusPayload?.authMode ?? null);

        // Passwordless modes have no local token. Resolve the server-authorized
        // owner directly so HTTP and WebSocket use the same request identity.
        if (statusPayload?.authMode === 'none' || statusPayload?.authMode === 'tailscale') {
          setNeedsSetup(false);
          if (statusPayload.authMode === 'tailscale' && !statusPayload.isConfigured) {
            setUser(null);
            setError(AUTH_ERROR_MESSAGES.tailscaleNotConfigured);
            return;
          }
          if (statusPayload.authMode === 'tailscale' && !statusPayload.isAuthenticated) {
            setUser(null);
            setError(AUTH_ERROR_MESSAGES.tailscaleAccessDenied);
            return;
          }
          const ownerResponse = await api.auth.user({ signal: controller.signal });
          if (!isCurrent(snapshot, mutation) || controller.signal.aborted) return;
          if (ownerResponse.ok) {
            const ownerPayload = await parseJsonSafely<AuthUserPayload>(ownerResponse);
            if (!isCurrent(snapshot, mutation) || controller.signal.aborted) return;
            if (ownerPayload?.user) {
              setUser(ownerPayload.user);
              return;
            }
          }
          setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
          return;
        }

        if (statusPayload?.needsSetup) {
          setNeedsSetup(true);
          return;
        }
        setNeedsSetup(false);

        // Password mode: the only credential is the httpOnly cookie, which this
        // code cannot see, so ask the server whether it still names a user. A
        // 401 simply means "signed out"; it is not an error to surface.
        const userResponse = await api.auth.user({ signal: controller.signal });
        if (!isCurrent(snapshot, mutation) || controller.signal.aborted) return;
        if (!userResponse.ok) {
          clearSession();
          return;
        }

        const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
        if (!isCurrent(snapshot, mutation) || controller.signal.aborted) return;
        if (!userPayload?.user) {
          clearSession();
          return;
        }

        setUser(userPayload.user);
        markSessionActive();
        await checkOnboardingStatus(getSessionSnapshot(), mutation);
      } catch (caughtError) {
        if (!isCurrent(snapshot, mutation) || controller.signal.aborted) return;
        console.error('[Auth] Auth status check failed:', caughtError);
        setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
      } finally {
        if (bootstrapAbortRef.current === controller) {
          bootstrapAbortRef.current = null;
        }
        if (isCurrent(snapshot, mutation) && !controller.signal.aborted) setIsLoading(false);
      }
    };

    void checkAuthStatus();
    return () => {
      controller.abort();
      if (bootstrapAbortRef.current === controller) {
        bootstrapAbortRef.current = null;
      }
    };
  }, [checkOnboardingStatus, clearSession, isCurrent, sessionGeneration]);

  const authenticate = useCallback(async (
    request: () => Promise<Response>,
    fallbackMessage: string,
  ): Promise<AuthActionResult> => {
    bootstrapAbortRef.current?.abort();
    bootstrapAbortRef.current = null;
    setIsLoading(false);
    const mutation = mutationRef.current + 1;
    mutationRef.current = mutation;
    const snapshot = getSessionSnapshot();
    try {
      setError(null);
      const response = await request();
      const payload = await parseJsonSafely<AuthSessionPayload>(response);
      if (!isCurrent(snapshot, mutation)) return { success: false, error: fallbackMessage };
      // The response body still carries a token for API clients; the browser
      // ignores it and relies on the Set-Cookie the same response delivered.
      if (!response.ok || !payload?.user) {
        const message = resolveApiErrorMessage(payload, fallbackMessage);
        setError(message);
        return { success: false, error: message };
      }

      setSession(payload.user);
      setNeedsSetup(false);
      await checkOnboardingStatus(getSessionSnapshot(), mutation);
      return { success: true };
    } catch (caughtError) {
      if (!isCurrent(snapshot, mutation)) return { success: false, error: fallbackMessage };
      console.error('Authentication error:', caughtError);
      setError(AUTH_ERROR_MESSAGES.networkError);
      return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
    }
  }, [checkOnboardingStatus, isCurrent, setSession]);

  const login = useCallback<AuthContextValue['login']>((username, password) =>
    authenticate(() => api.auth.login(username, password), AUTH_ERROR_MESSAGES.loginFailed), [authenticate]);

  const register = useCallback<AuthContextValue['register']>((username, password) =>
    authenticate(() => api.auth.register(username, password), AUTH_ERROR_MESSAGES.registrationFailed), [authenticate]);

  const logout = useCallback(() => {
    // The cookie goes with the request; the server bumps the token version so
    // every copy of this session, cookie or otherwise, stops working.
    const logoutRequest = getSessionSnapshot().active ? api.auth.logout() : null;

    mutationRef.current += 1;
    bootstrapAbortRef.current?.abort();
    bootstrapAbortRef.current = null;
    setIsLoading(false);
    clearSession();
    setNeedsSetup(false);
    setError(null);

    void logoutRequest?.catch((caughtError: unknown) => {
      console.error('Logout endpoint error:', caughtError);
    });
  }, [clearSession]);

  const contextValue = useMemo<AuthContextValue>(() => ({
    user,
    authMode,
    isLoading,
    needsSetup,
    hasCompletedOnboarding,
    error,
    login,
    register,
    logout,
    refreshOnboardingStatus,
  }), [authMode, error, hasCompletedOnboarding, isLoading, login, logout, needsSetup, refreshOnboardingStatus, register, user]);

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
