import type { VerifyClientCallbackSync, WebSocket } from 'ws';

import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { AUTH_COOKIE_NAME, getBearerToken, parseCookieHeader } from '@/middleware/auth.js';

export type WebSocketAuthDependencies = {
  /** Same-site guard shared with the HTTP API; runs before any credential is read. */
  checkCrossSite?: (request: AuthenticatedWebSocketRequest) => { ok: true } | { ok: false; error: string };
  authenticateWebSocket: (
    token: string | null,
    request: AuthenticatedWebSocketRequest,
  ) => {
    id?: string | number;
    userId?: string | number;
    username?: string;
    [key: string]: unknown;
  } | null;
};

function principalKey(user: AuthenticatedWebSocketRequest['user']): string {
  return JSON.stringify([
    user?.id ?? user?.userId ?? null, user?.username ?? null,
    user?.tailscaleLogin ?? null, user?.tailscaleRole ?? null, user?.authSource ?? null,
  ]);
}

/** Re-read revocation/allowlist state; a connection never changes its principal. */
export function createWebSocketAuthorizationCheck(
  socket: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: WebSocketAuthDependencies,
): () => boolean {
  const admitted = principalKey(request.user);
  const token = getBearerToken(request.headers.authorization)
    ?? parseCookieHeader(request.headers.cookie)[AUTH_COOKIE_NAME] ?? null;
  let revoked = false;
  return () => {
    if (revoked || socket.readyState !== socket.OPEN) return false;
    try {
      const current = dependencies.authenticateWebSocket(token, request);
      if (current !== null && principalKey(current) === admitted) return true;
    } catch {
      // An unreadable auth store is not authority to keep an existing socket.
    }
    revoked = true;
    socket.close(1008, 'Authentication is no longer valid.');
    return false;
  };
}

/**
 * Authenticates websocket upgrade requests before the `connection` handler runs.
 */
export function verifyWebSocketClient(
  info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0],
  dependencies: WebSocketAuthDependencies
): boolean {
  const request = info.req as AuthenticatedWebSocketRequest;
  const upgradeUrl = new URL(request.url ?? '/', 'http://localhost');
  console.log('WebSocket connection attempt to:', upgradeUrl.pathname);

  const crossSite = dependencies.checkCrossSite?.(request);
  if (crossSite && !crossSite.ok) {
    console.log('[WARN] WebSocket upgrade rejected:', crossSite.error);
    return false;
  }

  if (upgradeUrl.searchParams.has('token')) {
    console.log('[WARN] WebSocket authentication failed');
    return false;
  }

  const token =
    getBearerToken(request.headers.authorization) ??
    parseCookieHeader(request.headers.cookie)[AUTH_COOKIE_NAME] ??
    null;

  const user = dependencies.authenticateWebSocket(token, request);
  if (!user) {
    console.log('[WARN] WebSocket authentication failed');
    return false;
  }

  request.user = user;
  console.log('[OK] WebSocket authenticated for user:', user.username);
  return true;
}
