import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import {
  clearAuthToken,
  getAuthTokenSnapshot,
  isCurrentAuthTokenSnapshot,
  setAuthToken,
  subscribeAuthToken,
  type TokenSnapshot,
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

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => getAuthTokenSnapshot().token);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mutationRef = useRef(0);
  const onboardingAbortRef = useRef<AbortController | null>(null);
  const bootstrapAbortRef = useRef<AbortController | null>(null);

  const isCurrent = useCallback((snapshot: TokenSnapshot, mutation: number) =>
    mutationRef.current === mutation && isCurrentAuthTokenSnapshot(snapshot), []);

  const resetOnboarding = useCallback(() => {
    onboardingAbortRef.current?.abort();
    onboardingAbortRef.current = null;
    setHasCompletedOnboarding(true);
  }, []);

  const setSession = useCallback((nextUser: AuthUser, nextToken: string) => {
    resetOnboarding();
    setUser(nextUser);
    setAuthToken(nextToken);
  }, [resetOnboarding]);

  const clearSession = useCallback(() => {
    resetOnboarding();
    setUser(null);
    clearAuthToken();
  }, [resetOnboarding]);

  useEffect(() => subscribeAuthToken((snapshot) => {
    setToken(snapshot.token);
    resetOnboarding();
  }), [resetOnboarding]);

  const checkOnboardingStatus = useCallback(async (snapshot = getAuthTokenSnapshot(), mutation = mutationRef.current) => {
    if (!snapshot.token) return;
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
    const snapshot = getAuthTokenSnapshot();
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
        if (!snapshot.token) return;

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
        await checkOnboardingStatus(snapshot, mutation);
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
  }, [checkOnboardingStatus, clearSession, isCurrent, token]);

  const authenticate = useCallback(async (
    request: () => Promise<Response>,
    fallbackMessage: string,
  ): Promise<AuthActionResult> => {
    bootstrapAbortRef.current?.abort();
    bootstrapAbortRef.current = null;
    setIsLoading(false);
    const mutation = mutationRef.current + 1;
    mutationRef.current = mutation;
    const snapshot = getAuthTokenSnapshot();
    try {
      setError(null);
      const response = await request();
      const payload = await parseJsonSafely<AuthSessionPayload>(response);
      if (!isCurrent(snapshot, mutation)) return { success: false, error: fallbackMessage };
      if (!response.ok || !payload?.token || !payload.user) {
        const message = resolveApiErrorMessage(payload, fallbackMessage);
        setError(message);
        return { success: false, error: message };
      }

      setSession(payload.user, payload.token);
      setNeedsSetup(false);
      await checkOnboardingStatus(getAuthTokenSnapshot(), mutation);
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
    const tokenToInvalidate = getAuthTokenSnapshot().token;
    const logoutRequest = tokenToInvalidate
      ? api.auth.logout({ headers: { Authorization: `Bearer ${tokenToInvalidate}` } })
      : null;

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
    token,
    authMode,
    isLoading,
    needsSetup,
    hasCompletedOnboarding,
    error,
    login,
    register,
    logout,
    refreshOnboardingStatus,
  }), [authMode, error, hasCompletedOnboarding, isLoading, login, logout, needsSetup, refreshOnboardingStatus, register, token, user]);

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
