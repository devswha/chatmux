import express from 'express';
import bcrypt from 'bcrypt';

import { userDb } from '../modules/database/index.js';
import { getConnection } from '../modules/database/connection.js';
import {
  AUTH_COOKIE_NAME,
  AUTH_MODE,
  TOKEN_MAX_AGE_MS,
  authenticateToken,
  generateToken,
  incrementTokenVersion,
  isAuthDisabled,
  isTailscaleAuth
} from '../middleware/auth.js';
import {
  authenticateTailscaleRequest,
  getTailscaleAccessConfig
} from '../tailscale-auth.js';

const router = express.Router();
const db = getConnection();
const getAuthCookieOptions = (req) => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: req.secure === true,
  path: '/',
  maxAge: TOKEN_MAX_AGE_MS
});

const setAuthCookie = (req, res, token) => {
  res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions(req));
};

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
    
    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username must be at least 3 characters, password at least 6 characters' });
    }
    
    // Use a transaction to prevent race conditions
    db.prepare('BEGIN').run();
    try {
      // Check if users already exist (only allow one user)
      const hasUsers = userDb.hasUsers();
      if (hasUsers) {
        db.prepare('ROLLBACK').run();
        return res.status(403).json({ error: 'User already exists. This is a single-user system.' });
      }
      
      // Hash password
      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      
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
    
    // Get user from database
    const user = userDb.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
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
