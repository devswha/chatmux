import jwt from 'jsonwebtoken';

import { userDb, appConfigDb } from '../modules/database/index.js';
import { authenticateTailscaleRequest } from '../tailscale-auth.js';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();
const AUTH_COOKIE_NAME = 'chatmux_auth';
const TOKEN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_MAX_AGE_MS = TOKEN_MAX_AGE_SECONDS * 1000;

/**
 * Self-host auth modes:
 *   'none'      — every HTTP/WebSocket request acts as the implicit owner.
 *   'password'  — the single-account JWT/cookie flow.
 *   'tailscale' — loopback requests act as the owner; Tailscale Serve requests
 *                 require a trusted identity header and a persisted allowlist.
 */
const resolveAuthMode = (value) => (
  value === 'password' || value === 'tailscale' ? value : 'none'
);
const AUTH_MODE = resolveAuthMode(process.env.CHATMUX_AUTH);
const isAuthDisabled = () => AUTH_MODE === 'none';
const isTailscaleAuth = () => AUTH_MODE === 'tailscale';

// Passwordless modes resolve every authorized request to one local owner row.
// The row still exists because per-user preferences and notifications hang off
// users.id. Its sentinel password hash can never be used by /login.
let implicitOwnerId = null;
const getImplicitOwner = () => {
  if (implicitOwnerId !== null) {
    const cached = userDb.getUserById(implicitOwnerId);
    if (cached) {
      return cached;
    }
    implicitOwnerId = null;
  }
  let owner = userDb.getFirstUser();
  if (!owner) {
    const created = userDb.createUser('owner', 'disabled:auth-mode-none');
    owner = userDb.getUserById(Number(created.id)) ?? { id: Number(created.id), username: created.username };
  }
  implicitOwnerId = owner.id;
  return owner;
};

const getTailscaleUser = (req) => {
  const identity = authenticateTailscaleRequest(req);
  if (!identity) return null;
  const owner = getImplicitOwner();
  return {
    ...owner,
    tailscaleLogin: identity.login,
    tailscaleName: identity.name,
    tailscaleRole: identity.role,
    authSource: identity.source
  };
};

const tokenVersionKey = (userId) => `auth_token_version:${userId}`;
const TOKEN_VERSION_SCHEMA_KEY = 'auth_token_version_schema';

const parseStoredTokenVersion = (value) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/**
 * @param {unknown} cookieHeader
 * @returns {Record<string, string>}
 */
const parseCookieHeader = (cookieHeader) => {
  if (typeof cookieHeader !== 'string') {
    return {};
  }

  return cookieHeader.split(';').reduce((cookies, entry) => {
    const separator = entry.indexOf('=');
    if (separator < 0) {
      return cookies;
    }

    const name = entry.slice(0, separator).trim();
    if (!name) {
      return cookies;
    }

    const value = entry.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
    return cookies;
  }, {});
};

const getBearerToken = (authorization) => {
  if (typeof authorization !== 'string') {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() || null : null;
};

const getRequestToken = (req) => {
  const bearerToken = getBearerToken(req.headers.authorization);
  if (bearerToken) {
    return bearerToken;
  }

  return parseCookieHeader(req.headers.cookie)[AUTH_COOKIE_NAME] || null;
};

const getTokenVersion = (userId) => {
  const key = tokenVersionKey(userId);
  const storedValue = appConfigDb.get(key);
  const parsedVersion = parseStoredTokenVersion(storedValue);
  if (parsedVersion !== null) {
    return parsedVersion;
  }

  if (storedValue !== null || appConfigDb.get(TOKEN_VERSION_SCHEMA_KEY) === '1') {
    throw new Error('Invalid or missing token revocation state');
  }

  // One-time upgrade path for installations that issued pre-version JWTs.
  appConfigDb.set(key, '0');
  appConfigDb.set(TOKEN_VERSION_SCHEMA_KEY, '1');
  return 0;
};

const incrementTokenVersion = (userId) => {
  const nextVersion = getTokenVersion(userId) + 1;
  appConfigDb.set(tokenVersionKey(userId), String(nextVersion));
  return nextVersion;
};

const isTokenVersionValid = (tokenVersion, currentVersion) => {
  const normalizedTokenVersion = tokenVersion === undefined ? 0 : tokenVersion;
  return Number.isSafeInteger(normalizedTokenVersion) &&
    normalizedTokenVersion >= 0 &&
    normalizedTokenVersion === currentVersion;
};

const getAuthenticatedUser = (token) => {
  const decoded = jwt.verify(token, JWT_SECRET);
  const user = userDb.getUserById(decoded.userId);
  if (!user || !isTokenVersionValid(decoded.tokenVersion, getTokenVersion(user.id))) {
    return null;
  }

  return user;
};

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }

  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// Request authentication middleware
const authenticateToken = async (req, res, next) => {
  if (isAuthDisabled()) {
    req.user = getImplicitOwner();
    return next();
  }
  if (isTailscaleAuth()) {
    const user = getTailscaleUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Access denied by Tailscale identity policy.' });
    }
    req.user = user;
    return next();
  }

  const token = getRequestToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const user = getAuthenticatedUser(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token.' });
    }

    req.user = user;
    next();
  } catch {
    console.error('Token verification failed');
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      tokenVersion: getTokenVersion(user.id)
    },
    JWT_SECRET,
    { expiresIn: TOKEN_MAX_AGE_SECONDS }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token, request) => {
  if (isAuthDisabled()) {
    const owner = getImplicitOwner();
    return { userId: owner.id, username: owner.username };
  }
  if (isTailscaleAuth()) {
    const user = getTailscaleUser(request);
    return user ? {
      userId: user.id,
      username: user.username,
      tailscaleLogin: user.tailscaleLogin,
      tailscaleRole: user.tailscaleRole,
      authSource: user.authSource
    } : null;
  }

  if (!token) {
    return null;
  }

  try {
    const user = getAuthenticatedUser(token);
    return user ? { userId: user.id, username: user.username } : null;
  } catch {
    console.error('WebSocket token verification failed');
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  parseCookieHeader,
  getBearerToken,
  getRequestToken,
  isTokenVersionValid,
  parseStoredTokenVersion,
  incrementTokenVersion,
  AUTH_COOKIE_NAME,
  AUTH_MODE,
  resolveAuthMode,
  isAuthDisabled,
  isTailscaleAuth,
  TOKEN_MAX_AGE_MS,
  JWT_SECRET
};
