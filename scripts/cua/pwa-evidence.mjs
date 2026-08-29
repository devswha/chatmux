#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const outputRoot = path.resolve(
  process.env.CUA_EVIDENCE_DIR
    ?? path.join(repositoryRoot, '.omo', 'cua', 'pwa'),
);
const chromeUserDataDir = path.resolve(
  process.env.CUA_CHROME_USER_DATA_DIR
    ?? path.join(os.homedir(), '.config', 'google-chrome'),
);
const chromeProfile = process.env.CUA_CHROME_PROFILE ?? 'Default';

function isLoopbackHostname(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname.endsWith('.localhost');
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function fetchSummary(baseUrl, pathname) {
  try {
    const response = await fetch(new URL(pathname, baseUrl), {
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    });
    const body = await response.text();
    return {
      pathname,
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type'),
      body,
    };
  } catch (error) {
    return {
      pathname,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      body: '',
    };
  }
}

async function matchingDesktopEntries(hostname) {
  const directory = path.join(os.homedir(), '.local', 'share', 'applications');
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.desktop')) continue;
    const filePath = path.join(directory, entry.name);
    const text = await readFile(filePath, 'utf8');
    if (!text.toLowerCase().includes('chatmux') && !text.includes(hostname)) continue;
    matches.push({
      file: filePath,
      name: text.match(/^Name=(.+)$/m)?.[1] ?? null,
      hasAppLaunchCommand: /^(?:Exec=.*(?:--app=|--app-id=)|StartupWMClass=)/m.test(text),
    });
  }
  return matches;
}

async function notificationPermission(hostname) {
  const preferencesPath = path.join(chromeUserDataDir, chromeProfile, 'Preferences');
  const preferences = await readJson(preferencesPath);
  const exceptions = preferences?.profile?.content_settings?.exceptions?.notifications ?? {};
  const match = Object.entries(exceptions).find(([pattern]) => pattern.includes(hostname));
  if (!match) return { profile: preferences ? chromeProfile : null, permission: 'default' };
  const [pattern, value] = match;
  const setting = value?.setting;
  return {
    profile: chromeProfile,
    originPattern: pattern,
    permission: setting === 1 ? 'granted' : setting === 2 ? 'denied' : 'default',
  };
}

const tailscale = await readJson(path.join(outputRoot, 'tailscale-https.json'));
const baseUrl = process.env.CUA_PWA_BASE_URL ?? tailscale?.baseUrl ?? null;
if (!baseUrl) throw new Error('No PWA base URL. Run cua:tailscale:evidence or set CUA_PWA_BASE_URL.');
const parsedBaseUrl = new URL(baseUrl);
const hostname = parsedBaseUrl.hostname;
const loopback = isLoopbackHostname(hostname);
const secureContext = parsedBaseUrl.protocol === 'https:'
  || (parsedBaseUrl.protocol === 'http:' && loopback);
const browserNotification = await readJson(path.join(outputRoot, 'pwa-notification-browser.json'));
let notificationArtifactPresent = false;
try {
  await readFile(path.join(outputRoot, 'os-notification-delivered.png'));
  notificationArtifactPresent = true;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const browserNotificationMatches = browserNotification?.origin === parsedBaseUrl.origin;
const serviceWorkerActive = browserNotificationMatches
  && browserNotification?.serviceWorker?.active === true
  && browserNotification?.serviceWorker?.scriptURL === `${parsedBaseUrl.origin}/sw.js`;
const deepLinkQualified = browserNotificationMatches
  && /^\/hosts\/[0-9a-f-]{36}\/session\//.test(browserNotification?.notification?.navigation?.href ?? '')
  && browserNotification?.deepLink?.served === true;
const osNotificationDelivered = browserNotificationMatches
  && browserNotification?.notificationApiCreated === true
  && browserNotification?.osNotifyDbusObserved === true
  && notificationArtifactPresent;
const documentResponse = await fetchSummary(baseUrl, '/');
const manifestPath = documentResponse.body.match(
  /<link[^>]+rel=["'][^"']*manifest[^"']*["'][^>]+href=["']([^"']+)["']/i,
)?.[1] ?? documentResponse.body.match(
  /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*manifest[^"']*["']/i,
)?.[1] ?? null;
const manifestResponse = manifestPath
  ? await fetchSummary(baseUrl, manifestPath)
  : { pathname: null, ok: false, body: '' };
let manifest = null;
try {
  manifest = JSON.parse(manifestResponse.body);
} catch {
  // A malformed manifest is reported by the validation checks below.
}
const serviceWorkerResponse = await fetchSummary(baseUrl, '/sw.js');
const requiredIcon = manifest?.icons?.find(({ sizes }) => sizes?.split(/\s+/).includes('192x192'));
const iconResponse = requiredIcon
  ? await fetchSummary(baseUrl, requiredIcon.src)
  : { pathname: null, ok: false, body: '' };
const [desktopEntries, storedNotifications] = await Promise.all([
  matchingDesktopEntries(hostname),
  notificationPermission(hostname),
]);
const notifications = browserNotificationMatches && browserNotification?.permission === 'granted'
  ? { ...storedNotifications, permission: 'granted', source: 'live-browser-cdp' }
  : storedNotifications;
const checks = {
  secure_context: secureContext,
  document_served: documentResponse.ok && documentResponse.contentType?.includes('text/html'),
  manifest_linked: Boolean(manifestPath),
  manifest_valid: Boolean(
    manifestResponse.ok
      && manifest?.name
      && manifest?.start_url
      && manifest?.display === 'standalone'
      && Array.isArray(manifest?.icons),
  ),
  service_worker_served: Boolean(
    serviceWorkerResponse.ok
      && serviceWorkerResponse.body.includes('self.addEventListener'),
  ),
  install_icon_served: iconResponse.ok,
  pwa_installed: desktopEntries.some(({ hasAppLaunchCommand }) => hasAppLaunchCommand),
  notification_permission_granted: notifications.permission === 'granted',
  service_worker_active: serviceWorkerActive,
  host_qualified_deep_link: deepLinkQualified,
  os_notification_delivered: osNotificationDelivered,
};
const installable = Object.entries(checks)
  .filter(([name]) => ![
    'pwa_installed',
    'notification_permission_granted',
    'os_notification_delivered',
  ].includes(name))
  .every(([, ok]) => ok);
const actualEnvironmentOk = checks.pwa_installed
  && checks.notification_permission_granted
  && checks.service_worker_active
  && checks.host_qualified_deep_link
  && checks.os_notification_delivered;
const evidence = {
  capturedAt: new Date().toISOString(),
  baseUrl,
  checks,
  installable,
  actualEnvironmentOk,
  transport: {
    protocol: parsedBaseUrl.protocol,
    loopback,
    secureContext,
  },
  desktopEntries,
  notifications,
  osNotification: {
    delivered: osNotificationDelivered,
    artifact: osNotificationDelivered ? 'os-notification-delivered.png' : null,
    browserEvidence: browserNotificationMatches ? 'pwa-notification-browser.json' : null,
  },
  resources: [documentResponse, manifestResponse, serviceWorkerResponse, iconResponse].map((entry) => ({
    pathname: entry.pathname,
    ok: entry.ok,
    status: entry.status ?? null,
    contentType: entry.contentType ?? null,
    error: entry.error ?? null,
  })),
  blocker: actualEnvironmentOk
    ? null
    : 'Install the ChatMux PWA, grant notification permission, and capture delivered OS notification evidence in an unlocked desktop browser.',
};
const outputPath = path.join(outputRoot, 'pwa-environment.json');
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
  outputPath,
  installable,
  actualEnvironmentOk,
  checks,
  notifications,
  blocker: evidence.blocker,
}, null, 2)}\n`);
if (!installable) process.exitCode = 1;
