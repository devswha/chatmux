export const LOCAL_TARGET_ID = 'local';
export const LOCAL_TARGET_PARTITION = 'persist:chatmux-local';

const OPAQUE_TARGET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TARGET_STORAGE_TYPES = Object.freeze([
  'appcache',
  'cookies',
  'filesystem',
  'indexdb',
  'localstorage',
  'shadercache',
  'websql',
  'serviceworkers',
  'cachestorage',
  'sharedworkers',
  'trusttokens',
  'interestgroups',
  'codecache',
]);

function requireOpaqueTargetId(target) {
  const id = String(target?.id || '');
  if (!OPAQUE_TARGET_ID.test(id)) {
    throw new Error('Remote target must have an opaque UUID id.');
  }
  return id;
}

export function getTargetPartition(target) {
  if (target?.kind === 'local') {
    return LOCAL_TARGET_PARTITION;
  }
  return `persist:chatmux-target-${requireOpaqueTargetId(target)}`;
}

export function getTargetOrigin(target) {
  let parsed;
  try {
    parsed = new URL(String(target?.url || ''));
  } catch {
    throw new Error('Target must have a valid HTTP(S) origin.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || String(target.url) !== parsed.origin) {
    throw new Error('Target URL must be its exact HTTP(S) origin.');
  }

  return parsed.origin;
}

export function isTargetUrlAllowed(target, candidateUrl) {
  try {
    const candidate = new URL(String(candidateUrl));
    return ['http:', 'https:'].includes(candidate.protocol)
      && candidate.origin === getTargetOrigin(target);
  } catch {
    return false;
  }
}

function getCookieUrl(cookie) {
  const host = String(cookie?.domain || '').replace(/^\./, '');
  if (!host) return null;

  try {
    return new URL(`${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`).toString();
  } catch {
    return null;
  }
}

async function clearCookies(targetSession) {
  const cookies = await targetSession.cookies.get({});
  await Promise.all(cookies.map(async (cookie) => {
    const cookieUrl = getCookieUrl(cookie);
    if (cookieUrl) {
      await targetSession.cookies.remove(cookieUrl, cookie.name);
    }
  }));
}

/**
 * Clears every credential-bearing store in one dedicated target partition.
 * Callers must await this before loading an edited target's new origin or
 * deleting its registry record.
 */
export async function clearTargetSessionData(target, getSessionForPartition) {
  if (typeof getSessionForPartition !== 'function') {
    throw new TypeError('A session resolver is required to clear target data.');
  }

  const targetSession = getSessionForPartition(getTargetPartition(target));
  if (!targetSession?.cookies?.get || !targetSession?.cookies?.remove) {
    throw new Error('Target session does not support cookie cleanup.');
  }

  await clearCookies(targetSession);
  await targetSession.clearCache();
  await targetSession.clearStorageData({ storages: TARGET_STORAGE_TYPES });
  if (typeof targetSession.clearAuthCache === 'function') {
    await targetSession.clearAuthCache();
  }
}
