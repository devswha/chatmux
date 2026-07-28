import express from 'express';

import {
  apiKeysDb,
  completionAppAlias,
  completionAppIdentityKey,
  completionExternalGenerationAlias,
  completionExternalGenerationIdentityFromSession,
  completionExternalGenerationIdentityKey,
  completionNotificationTargetsDb,
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
} from '../modules/database/index.js';
import { AUTH_MODE } from '../middleware/auth.js';
import {
  allowTailscaleUser,
  getTailscaleAccessConfig,
  revokeTailscaleUser
} from '../tailscale-auth.js';
import { getPublicKey } from '../services/vapid-keys.js';
import { getExternalCliSessionsDetailed } from '../modules/providers/index.js';
import {
  completionTargetResolver,
  wakeCompletionOutboxDispatcher,
} from '../modules/notifications/index.js';

const router = express.Router();
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const completionStatusDetailedDiscovery = (req) => (
  typeof req.app.locals.completionStatusDetailedDiscovery === 'function'
    ? req.app.locals.completionStatusDetailedDiscovery
    : getExternalCliSessionsDetailed
);

const deviceState = (userId, endpoint) => {
  const registered = typeof endpoint === 'string' && endpoint.length > 0
    && pushSubscriptionsDb.getPushSubscriptions(userId).some((subscription) => subscription.endpoint === endpoint);
  return {
    supported: true,
    registered,
    setupRequired: notificationPreferencesDb.isCompletionWebPushSetupRequired(userId),
    reason: registered ? null : (typeof endpoint === 'string' && endpoint.length > 0
      ? 'endpoint_not_registered'
      : 'device_endpoint_missing'),
  };
};

const boundedString = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum;

const validPushEndpoint = (endpoint) => {
  if (!boundedString(endpoint, 2048)) return false;
  try {
    const url = new URL(endpoint);
    // HTTP is allowed only for localhost browser-test subscriptions.
    return (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost'))
      && !url.username && !url.password;
  } catch {
    return false;
  }
};

const validBase64UrlKey = (key) => {
  if (!boundedString(key, 512) || !/^[A-Za-z0-9_-]+$/.test(key)) return false;
  const decoded = Buffer.from(key, 'base64url');
  return decoded.length > 0 && decoded.toString('base64url') === key;
};

const validExternalDescriptorSession = (session) => isRecord(session)
  && boundedString(session.kind, 32)
  && isRecord(session.tmux)
  && boundedString(session.tmux.socketPath, 1024)
  && boundedString(session.tmux.sessionId, 512)
  && boundedString(session.tmux.windowId, 128)
  && boundedString(session.tmux.paneId, 128)
  && Number.isSafeInteger(session.agentPid) && session.agentPid > 0
  && Number.isFinite(session.startedAtMs) && session.startedAtMs > 0;
const externalCompletionKinds = new Set(['claude', 'codex', 'opencode', 'omp']);
const validDetailedExternalSession = (session) => isRecord(session)
  && boundedString(session.kind, 32)
  && (!externalCompletionKinds.has(session.kind) || validExternalDescriptorSession(session));

const canManageTailscaleAccess = (req) => (
  req.user?.tailscaleRole === 'owner' || req.user?.tailscaleRole === 'local'
);

const requireTailscaleAccessManager = (req, res, next) => {
  if (AUTH_MODE !== 'tailscale') {
    return res.status(409).json({ error: 'Tailscale authentication is not enabled.' });
  }
  if (!canManageTailscaleAccess(req)) {
    return res.status(403).json({ error: 'Only the Tailscale owner can manage access.' });
  }
  next();
};

router.get('/access', (req, res) => {
  const canManage = AUTH_MODE === 'tailscale' && canManageTailscaleAccess(req);
  const config = canManage ? getTailscaleAccessConfig() : { owner: null, users: [] };
  res.json({
    authMode: AUTH_MODE,
    canManage,
    currentIdentity: req.user?.tailscaleLogin ?? null,
    role: req.user?.tailscaleRole ?? null,
    owner: config.owner,
    users: config.users
  });
});

router.post('/access/users', requireTailscaleAccessManager, (req, res) => {
  try {
    const config = allowTailscaleUser(req.body?.login);
    res.status(201).json({ owner: config.owner, users: config.users });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid Tailscale login.' });
  }
});

router.delete('/access/users/:login', requireTailscaleAccessManager, (req, res) => {
  try {
    const config = revokeTailscaleUser(req.params.login);
    res.json({ owner: config.owner, users: config.users });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid Tailscale login.' });
  }
});

// ===============================
// API Keys Management
// ===============================

// Get all API keys for the authenticated user
router.get('/api-keys', async (req, res) => {
  try {
    const apiKeys = apiKeysDb.getApiKeys(req.user.id);
    // Don't send the full API key in the list for security
    const sanitizedKeys = apiKeys.map(key => ({
      ...key,
      api_key: key.api_key.substring(0, 10) + '...'
    }));
    res.json({ apiKeys: sanitizedKeys });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// Create a new API key
router.post('/api-keys', async (req, res) => {
  try {
    const { keyName } = req.body;

    if (!keyName || !keyName.trim()) {
      return res.status(400).json({ error: 'Key name is required' });
    }

    const result = apiKeysDb.createApiKey(req.user.id, keyName.trim());
    res.json({
      success: true,
      apiKey: result
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// Delete an API key
router.delete('/api-keys/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params;
    const success = apiKeysDb.deleteApiKey(req.user.id, parseInt(keyId));

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error deleting API key:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// Toggle API key active status
router.patch('/api-keys/:keyId/toggle', async (req, res) => {
  try {
    const { keyId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = apiKeysDb.toggleApiKey(req.user.id, parseInt(keyId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error toggling API key:', error);
    res.status(500).json({ error: 'Failed to toggle API key' });
  }
});

// ===============================
// Generic Credentials Management
// ===============================

// Get all credentials for the authenticated user (optionally filtered by type)
router.get('/credentials', async (req, res) => {
  try {
    const { type } = req.query;
    const credentials = credentialsDb.getCredentials(req.user.id, type || null);
    // Don't send the actual credential values for security
    res.json({ credentials });
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// Create a new credential
router.post('/credentials', async (req, res) => {
  try {
    const { credentialName, credentialType, credentialValue, description } = req.body;

    if (!credentialName || !credentialName.trim()) {
      return res.status(400).json({ error: 'Credential name is required' });
    }

    if (!credentialType || !credentialType.trim()) {
      return res.status(400).json({ error: 'Credential type is required' });
    }

    if (!credentialValue || !credentialValue.trim()) {
      return res.status(400).json({ error: 'Credential value is required' });
    }

    const result = credentialsDb.createCredential(
      req.user.id,
      credentialName.trim(),
      credentialType.trim(),
      credentialValue.trim(),
      description?.trim() || null
    );

    res.json({
      success: true,
      credential: result
    });
  } catch (error) {
    console.error('Error creating credential:', error);
    res.status(500).json({ error: 'Failed to create credential' });
  }
});

// Delete a credential
router.delete('/credentials/:credentialId', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const success = credentialsDb.deleteCredential(req.user.id, parseInt(credentialId));

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error deleting credential:', error);
    res.status(500).json({ error: 'Failed to delete credential' });
  }
});

// Toggle credential active status
router.patch('/credentials/:credentialId/toggle', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = credentialsDb.toggleCredential(req.user.id, parseInt(credentialId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error toggling credential:', error);
    res.status(500).json({ error: 'Failed to toggle credential' });
  }
});

// ===============================
// Notification Preferences
// ===============================

router.get('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.getPreferences(req.user.id);
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error fetching notification preferences:', error);
    res.status(500).json({ error: 'Failed to fetch notification preferences' });
  }
});

router.put('/notification-preferences', async (req, res) => {
  try {
    const update = notificationPreferencesDb.updateCompletionPreferencesAndDeliveryState(
      req.user.id, req.body || {}, Date.now(),
    );
    if (update.wakeDispatcher) wakeCompletionOutboxDispatcher();
    res.json({ success: true, preferences: update.preferences });
  } catch (error) {
    console.error('Error saving notification preferences:', error);
    res.status(500).json({ error: 'Failed to save notification preferences' });
  }
});

router.post('/completion-notifications/status', async (req, res) => {
  try {
    const body = isRecord(req.body) ? req.body : {};
    const descriptors = body.descriptors ?? [];
    if (!Array.isArray(descriptors) || descriptors.length > 200) {
      return res.status(400).json({ error: 'descriptors must be an array of at most 200 items' });
    }

    const requested = new Map();
    for (const descriptor of descriptors) {
      if (!isRecord(descriptor)) return res.status(400).json({ error: 'Each descriptor must be an object' });
      if (descriptor.kind === 'app'
        && boundedString(descriptor.provider, 128) && boundedString(descriptor.sessionId, 512)) {
        const identity = { provider: descriptor.provider, sessionId: descriptor.sessionId };
        requested.set(completionAppIdentityKey(identity), {
          alias: completionAppAlias(identity), kind: 'app', ...identity,
        });
        continue;
      }
      if (descriptor.kind === 'external_generation' && validExternalDescriptorSession(descriptor.session)) {
        const identity = completionExternalGenerationIdentityFromSession(descriptor.session);
        if (identity) {
          requested.set(completionExternalGenerationIdentityKey(identity), {
            alias: completionExternalGenerationAlias(identity), kind: 'external_generation',
          });
          continue;
        }
      }
      return res.status(400).json({ error: 'Invalid completion notification descriptor' });
    }

    const externalRequested = [...requested.values()].some(
      (descriptor) => descriptor.kind === 'external_generation',
    );
    let externalByAlias = new Map();
    if (externalRequested) {
      let detailed;
      try {
        detailed = await completionStatusDetailedDiscovery(req)();
      } catch {
        return res.status(503).json({ error: 'discovery_unavailable' });
      }
      if (!isRecord(detailed) || detailed.ok !== true
        || !Array.isArray(detailed.sessions)
        || !detailed.sessions.every(validDetailedExternalSession)) {
        return res.status(503).json({ error: 'discovery_unavailable' });
      }
      const externalStatuses = completionTargetResolver.resolveExternalStatuses(detailed, req.user.id);
      externalByAlias = new Map(externalStatuses.map((status) => [status.alias, status]));
    }

    const targets = [];
    for (const [, descriptor] of requested) {
      if (descriptor.kind === 'app') {
        targets.push(completionTargetResolver.resolveAppDescriptor({
          provider: descriptor.provider,
          sessionId: descriptor.sessionId,
        }, req.user.id));
        continue;
      }
      targets.push(externalByAlias.get(descriptor.alias) ?? {
        alias: descriptor.alias,
        mappingState: 'none',
        reason: 'not_found',
      });
    }

    res.json({
      globalPaused: notificationPreferencesDb.isCompletionGlobalPaused(req.user.id),
      targets,
      device: deviceState(req.user.id, body.deviceEndpoint),
    });
  } catch (error) {
    console.error('Error fetching completion notification status:', error);
    res.status(500).json({ error: 'Failed to fetch completion notification status' });
  }
});

router.put('/completion-notifications', async (req, res) => {
  try {
    const mutation = req.body;
    if (!isRecord(mutation)
      || !boundedString(mutation.alias, 1024)
      || !Number.isInteger(mutation.expectedRevision) || mutation.expectedRevision < 0
      || !boundedString(mutation.mutationId, 128)
      || typeof mutation.watched !== 'boolean') {
      return res.status(400).json({ error: 'Invalid completion notification mutation' });
    }

    const result = completionNotificationTargetsDb.setWatch(req.user.id, mutation);
    if (!result.ok) {
      return res.status(result.reason === 'not_found' ? 404 : 409).json({
        error: result.reason,
        target: result.reason === 'revision_conflict' ? result.target : null,
        globalPaused: notificationPreferencesDb.isCompletionGlobalPaused(req.user.id),
        device: deviceState(req.user.id, req.body?.deviceEndpoint),
      });
    }
    res.json({
      target: result.target,
      globalPaused: result.globalPaused,
      device: deviceState(req.user.id, req.body?.deviceEndpoint),
    });
  } catch (error) {
    console.error('Error saving completion notification:', error);
    res.status(500).json({ error: 'Failed to save completion notification' });
  }
});
// ===============================
// Push Subscription Management
// ===============================

router.get('/push/vapid-public-key', async (req, res) => {
  try {
    const publicKey = getPublicKey();
    res.json({ publicKey });
  } catch (error) {
    console.error('Error fetching VAPID public key:', error);
    res.status(500).json({ error: 'Failed to fetch VAPID public key' });
  }
});

router.post('/push/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!validPushEndpoint(endpoint) || !isRecord(keys)
      || !validBase64UrlKey(keys.p256dh) || !validBase64UrlKey(keys.auth)) {
      return res.status(400).json({ error: 'Invalid push subscription' });
    }
    pushSubscriptionsDb.createPushSubscription(req.user.id, endpoint, keys.p256dh, keys.auth);
    const preferences = notificationPreferencesDb.getPreferences(req.user.id);
    const update = notificationPreferencesDb.updateCompletionPreferencesAndDeliveryState(
      req.user.id,
      { ...preferences, channels: { ...preferences.channels, webPush: true } },
      Date.now(),
      true,
    );
    if (update.wakeDispatcher) wakeCompletionOutboxDispatcher();
    res.json({ success: true, device: deviceState(req.user.id, endpoint) });
  } catch (error) {
    if (error?.code === 'endpoint_owned_by_another_user') {
      return res.status(409).json({ error: 'endpoint_owned_by_another_user' });
    }
    console.error('Error saving push subscription:', error);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

router.post('/push/register', async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!validPushEndpoint(endpoint) || !isRecord(keys)
      || !validBase64UrlKey(keys.p256dh) || !validBase64UrlKey(keys.auth)) {
      return res.status(400).json({ error: 'Invalid push subscription' });
    }
    pushSubscriptionsDb.createPushSubscription(req.user.id, endpoint, keys.p256dh, keys.auth);
    res.json({ success: true, device: deviceState(req.user.id, endpoint) });
  } catch (error) {
    if (error?.code === 'endpoint_owned_by_another_user') {
      return res.status(409).json({ error: 'endpoint_owned_by_another_user' });
    }
    console.error('Error registering push subscription:', error);
    res.status(500).json({ error: 'Failed to register push subscription' });
  }
});

router.post('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (typeof endpoint !== 'string' || !endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }
    pushSubscriptionsDb.deletePushSubscriptionForUser(req.user.id, endpoint);
    res.json({
      success: true,
      device: deviceState(req.user.id, endpoint),
    });
  } catch (error) {
    console.error('Error removing push subscription:', error);
    res.status(500).json({ error: 'Failed to remove push subscription' });
  }
});

export default router;
