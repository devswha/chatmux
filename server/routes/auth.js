import express from 'express';
import bcrypt from 'bcrypt';

import { userDb } from '../modules/database/index.js';
import { getConnection } from '../modules/database/connection.js';
import {
  AUTH_COOKIE_NAME,
  AUTH_MODE,
  authenticateToken,
  generateToken,
  getAuthCookieOptions,
  incrementTokenVersion,
  isAuthDisabled,
  isTailscaleAuth,
  setAuthCookie
} from '../middleware/auth.js';
import {
  authenticateTailscaleRequest,
  getTailscaleAccessConfig
} from '../tailscale-auth.js';
import { MIN_PASSWORD_LENGTH, isAcceptablePassword } from '../shared/password-policy.js';

import { createLoginLimiter, limiterClientAddress } from './login-limiter.js';

// An unknown username must cost the same bcrypt work as a wrong password so the
// response time does not reveal which of the two it was.
const TIMING_EQUALIZER_HASH = bcrypt.hashSync('chatmux-unknown-user', 12);

const router = express.Router();
const db = getConnection();

// Keyed on the real client: X-Forwarded-For is honoured only from a loopback
// proxy, so a direct LAN client cannot rotate it (see login-limiter.js).
const loginLimiter = createLoginLimiter();
const peerAddress = (req) => limiterClientAddress(req);

const clearAuthCookie = (req, res) => {
  const { maxAge, ...options } = getAuthCookieOptions(req);
  res.clearCookie(AUTH_COOKIE_NAME, options);
};

// Passwordless modes disable credential endpoints entirely.
const rejectWhenPasswordless = (req, res, next) => {
  if (isAuthDisabled() || isTailscaleAuth()) {
    return res.status(404).json({ error: `Credential authentication is disabled (CHATMUX_AUTH=${AUTH_MODE}).` });
  }
  next();
};

// Check auth status and setup requirements
router.get('/status', async (req, res) => {
  try {
    if (isAuthDisabled()) {
      return res.json({ authMode: AUTH_MODE, needsSetup: false, isAuthenticated: true });
    }
    if (isTailscaleAuth()) {
      const access = getTailscaleAccessConfig();
      const identity = authenticateTailscaleRequest(req);
      return res.json({
        authMode: AUTH_MODE,
        needsSetup: false,
        isConfigured: Boolean(access.owner),
        isAuthenticated: Boolean(identity),
        identity: identity?.login ?? null
      });
    }
    const hasUsers = await userDb.hasUsers();
    res.json({
      authMode: AUTH_MODE,
      needsSetup: !hasUsers,
      isAuthenticated: false
    });
  } catch (error) {
    console.error('Auth status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User registration (setup) - only allowed if no users exist
router.post('/register', rejectWhenPasswordless, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    if (username.length < 3 || !isAcceptablePassword(password)) {
      return res.status(400).json({ error: `Username must be at least 3 characters, password at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    // Hash before opening the transaction: the connection is shared, and a
    // BEGIN held across an await would pull every other request's writes into
    // this transaction (and a concurrent register would hit a nested BEGIN).
    const passwordHash = await bcrypt.hash(password, 12);

    // Use a transaction to prevent race conditions
    db.prepare('BEGIN').run();
    try {
      // Check if users already exist (only allow one user)
      const hasUsers = userDb.hasUsers();
      if (hasUsers) {
        db.prepare('ROLLBACK').run();
        return res.status(403).json({ error: 'User already exists. This is a single-user system.' });
      }

      // Create user
      const user = userDb.createUser(username, passwordHash);
      
      // Generate token
      const token = generateToken(user);
      
      db.prepare('COMMIT').run();

      // Update last login (non-fatal, outside transaction)
      userDb.updateLastLogin(user.id);
      setAuthCookie(req, res, token);

      res.json({
        success: true,
        user: { id: user.id, username: user.username },
        token
      });
    } catch (error) {
      db.prepare('ROLLBACK').run();
      throw error;
    }
    
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// User login
router.post('/login', rejectWhenPasswordless, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const retryAfterSeconds = loginLimiter.retryAfterSeconds(peerAddress(req), username);
    if (retryAfterSeconds > 0) {
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'Too many failed login attempts. Try again later.' });
    }
    
    // Get user from database
    const user = userDb.getUserByUsername(username);
    if (!user) {
      await bcrypt.compare(password, TIMING_EQUALIZER_HASH);
      loginLimiter.recordFailure(peerAddress(req), username);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      loginLimiter.recordFailure(peerAddress(req), username);
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    loginLimiter.clear(peerAddress(req), username);

    // Generate token
    const token = generateToken(user);
    
    // Update last login
    userDb.updateLastLogin(user.id);
    setAuthCookie(req, res, token);
    
    res.json({
      success: true,
      user: { id: user.id, username: user.username },
      token
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user (protected route)
router.get('/user', authenticateToken, (req, res) => {
  res.json({
    user: req.user
  });
});

router.post('/logout', authenticateToken, (req, res) => {
  if (isAuthDisabled() || isTailscaleAuth()) {
    return res.json({ success: true, message: 'Password authentication is disabled; nothing to log out.' });
  }
  incrementTokenVersion(req.user.id);
  clearAuthCookie(req, res);
  res.json({ success: true, message: 'Logged out successfully' });
});

export default router;
