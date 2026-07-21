import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';

import { DesktopWindowManager } from './desktopWindow.js';
import { LocalServerController } from './localServer.js';
import { normalizeRemoteServerUrl, RemoteServersStore, probeRemoteServer } from './remoteServers.js';
import { TabsController } from './tabs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_NAME = 'ChatMux';
const APP_USER_MODEL_ID = 'chatmux';
const APP_PROTOCOL = 'chatmux';

const tabs = new TabsController();
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

let activeTarget = { kind: 'launcher', name: APP_NAME, url: null };
let desktopWindow = null;
let localServer = null;
let remoteServers = null;
let isQuitting = false;
const pendingAppUrls = [];
let appUrlHandlingReady = false;

function getAppRoot() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
}

function getLauncherPath() {
  return path.join(__dirname, 'launcher', 'index.html');
}

function getPreloadPath() {
  return path.join(__dirname, 'preload.cjs');
}

function getWindowIconPath() {
  if (process.platform === 'darwin') {
    return path.join(getAppRoot(), 'electron', 'assets', 'logo-macos.png');
  }
  return path.join(getAppRoot(), 'public', 'logo-512.png');
}

function getRemoteServersStorePath() {
  return path.join(app.getPath('userData'), 'remote-servers.json');
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function getDisplayTargetName() {
  return activeTarget?.name || APP_NAME;
}

function getLocalState() {
  return {
    desktopSettings: localServer.getSettings(),
    localServerRunning: Boolean(localServer.getLocalServerUrl()),
    localWebUrl: localServer.getLocalServerUrl(),
    shareableWebUrl: localServer.getShareableWebUrl(),
  };
}

function getRemoteServersState() {
  return remoteServers?.getSnapshot() || {
    version: 1,
    selectedId: null,
    servers: [],
  };
}

function getDesktopState() {
  const localState = getLocalState();
  const targetState = getRemoteServersState();
  return {
    activeTarget,
    desktopSettings: localState.desktopSettings,
    localWebUrl: localState.localWebUrl,
    shareableWebUrl: localState.shareableWebUrl,
    localServerRunning: localState.localServerRunning,
    localStartupLogs: localServer.getStartupLogs(),
    tabs: tabs.getSerializableTabs(),
    activeTabId: tabs.activeTabId,
    remoteServers: targetState.servers,
    selectedRemoteServerId: targetState.selectedId,
  };
}
function getTargetState() {
  return getDesktopState();
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function validateExternalUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error('External URL is invalid.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('External URLs must not include credentials.');
  }
  if (parsed.protocol === 'https:' && parsed.hostname) return parsed.href;
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return parsed.href;
  if (parsed.protocol === 'mailto:' && !parsed.hostname && parsed.pathname) return parsed.href;
  throw new Error('External URL scheme or host is not allowed.');
}


async function openExternalUrl(url) {
  await shell.openExternal(validateExternalUrl(url));
}

async function showError(title, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${title}: ${message}`);
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'error',
    title,
    message: title,
    detail: message,
  });
}

function isExpectedNavigationAbort(error) {
  const message = error instanceof Error ? error.message : String(error);
  return error?.code === 'ERR_ABORTED' || message.includes('ERR_ABORTED') || message.includes('(-3)');
}

function syncDesktopState() {
  if (!desktopWindow) return;
  desktopWindow.buildAppMenu();
  desktopWindow.emitTargetState();
  if (activeTarget?.kind === 'local' && !localServer?.getLocalServerUrl()) {
    void desktopWindow.showLocalStartupTarget(localServer.getPendingTarget(), localServer.getStartupLogs())
      .catch((error) => {
        if (isExpectedNavigationAbort(error)) return;
        void showError('Could not update local startup log', error);
      });
  }
}

function setActiveTarget(target) {
  activeTarget = target;
}

function getDiagnosticsText() {
  const localState = getLocalState();
  const targetState = getRemoteServersState();
  return JSON.stringify({
    app: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    appPath: getAppRoot(),
    userDataPath: app.getPath('userData'),
    remoteServersPath: getRemoteServersStorePath(),
    activeTarget,
    remoteServerCount: targetState.servers.length,
    selectedRemoteServerId: targetState.selectedId,
    localServerUrl: localState.localWebUrl,
    localServerPort: localServer.localServerPort,
    localWebUrl: localState.localWebUrl,
    shareableWebUrl: localState.shareableWebUrl,
    desktopSettings: localState.desktopSettings,
  }, null, 2);
}

async function copyDiagnostics() {
  clipboard.writeText(getDiagnosticsText());
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'info',
    title: 'Diagnostics copied',
    message: 'ChatMux diagnostics were copied to the clipboard.',
  });
}

async function copyLocalWebUrl() {
  await localServer.ensureLocalServer();
  const localUrl = localServer.getLocalServerUrl();

  if (!localUrl) {
    throw new Error('Local ChatMux URL is not available yet.');
  }

  clipboard.writeText(localUrl);
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'info',
    title: 'Web URL copied',
    message: 'Local web URL copied.',
    detail: `${localUrl}\n\nThis URL works on this computer.`,
  });
  return getDesktopState();
}

async function openLocalWebUi() {
  await localServer.ensureLocalServer();
  const url = localServer.getShareableWebUrl() || localServer.getLocalServerUrl();
  if (!url) {
    throw new Error('Local ChatMux URL is not available yet.');
  }

  await openExternalUrl(url);
  return getDesktopState();
}

async function updateDesktopSetting(key, value) {
  await localServer.updateDesktopSetting(key, value);
  syncDesktopState();
  return getDesktopState();
}

async function openLocalTarget() {
  const existingTab = tabs.getTab('local');
  if (existingTab && localServer.getLocalServerUrl()) {
    await desktopWindow.showTarget(await localServer.getResolvedTarget());
    return getDesktopState();
  }

  const pendingTarget = localServer.getPendingTarget();
  tabs.upsertTarget(pendingTarget);
  setActiveTarget(pendingTarget);
  await desktopWindow.showLocalStartupTarget(pendingTarget, localServer.getStartupLogs());
  desktopWindow.emitTargetState();

  const target = await localServer.getResolvedTarget();
  setActiveTarget(target);
  await desktopWindow.showTarget(target);
  return getDesktopState();
}

async function getRemoteTarget(targetId) {
  const target = await remoteServers.get(targetId);
  if (!target) {
    throw new Error('Remote target not found.');
  }
  return target;
}

async function testTarget(targetId) {
  const target = await getRemoteTarget(targetId);
  return {
    target,
    health: await probeRemoteServer(target),
  };
}

async function openTarget(targetId) {
  const target = await getRemoteTarget(targetId);
  const health = await probeRemoteServer(target);
  await remoteServers.select(target.id);
  const remoteTarget = { kind: 'remote', ...target };
  tabs.upsertTarget(remoteTarget);
  setActiveTarget(remoteTarget);
  await desktopWindow.showTarget(remoteTarget);
  return {
    state: getDesktopState(),
    health,
  };
}

async function saveTarget(input) {
  const target = await remoteServers.create(input);
  return {
    target,
    state: getRemoteServersState(),
  };
}

async function updateTarget(targetId, input) {
  const previousTarget = await getRemoteTarget(targetId);
  const nextUrl = Object.hasOwn(input ?? {}, 'url')
    ? normalizeRemoteServerUrl(input.url)
    : previousTarget.url;

  if (previousTarget.url !== nextUrl) {
    await desktopWindow?.clearTargetSessionForOriginChange?.(
      { kind: 'remote', ...previousTarget },
      { kind: 'remote', ...previousTarget, url: nextUrl },
    );
  }

  const target = await remoteServers.update(targetId, input);
  const remoteTarget = { kind: 'remote', ...target };
  const activeTabId = tabs.activeTabId;
  const tabId = tabs.getTabIdForTarget(remoteTarget);
  if (tabs.getTab(tabId)) {
    tabs.upsertTarget(remoteTarget);
    if (activeTabId !== tabId) tabs.activate(activeTabId);
  }
  if (activeTarget?.kind === 'remote' && activeTarget.id === target.id) {
    setActiveTarget(remoteTarget);
  }
  return {
    target,
    state: getRemoteServersState(),
  };
}

async function deleteTarget(targetId) {
  const target = await getRemoteTarget(targetId);
  const tabId = tabs.getTabIdForTarget({ kind: 'remote', id: target.id });
  const tab = tabs.getTab(tabId);

  if (desktopWindow?.clearTargetSession) {
    await desktopWindow.clearTargetSession({ kind: 'remote', ...target });
  } else if (tab) {
    desktopWindow?.destroyTabView(tab.id);
  }

  await remoteServers.delete(targetId);
  tabs.remove(tabId);
  if (activeTarget?.kind === 'remote' && activeTarget.id === target.id) {
    await desktopWindow?.showLauncher();
  } else {
    syncDesktopState();
  }
  return {
    target,
    state: getRemoteServersState(),
  };
}

async function selectTarget(targetId) {
  const target = await remoteServers.select(targetId);
  return {
    target,
    state: getRemoteServersState(),
  };
}

async function showTargetPicker() {
  const targetState = getRemoteServersState();
  const choices = ['Local ChatMux', ...targetState.servers.map((target) => target.name)];
  const response = await dialog.showMessageBox(desktopWindow?.getMainWindow(), {
    type: 'question',
    buttons: [...choices, 'Cancel'],
    defaultId: 0,
    cancelId: choices.length,
    title: 'Switch ChatMux target',
    message: 'Choose where this desktop window should connect.',
  });

  if (response.response === choices.length) return getDesktopState();
  if (response.response === 0) return openLocalTarget();
  await openTarget(targetState.servers[response.response - 1].id);
  return getDesktopState();
}

function getRemoteTargetMenuItems() {
  const targetState = getRemoteServersState();
  if (!targetState.servers.length) {
    return [{ label: 'No remote targets saved', enabled: false }];
  }

  return targetState.servers.map((target) => ({
    label: target.name,
    click: () => void openTarget(target.id)
      .catch((error) => showError('Could not open remote target', error)),
  }));
}

function isNarrowAppAction(url) {
  try {
    const parsed = new URL(url);
    const keys = [...parsed.searchParams.keys()];
    return parsed.protocol === `${APP_PROTOCOL}:`
      && parsed.hostname === 'open'
      && parsed.pathname === '/'
      && keys.length === 1
      && keys[0] === 'targetId'
      && Boolean(parsed.searchParams.get('targetId'));
  } catch {
    return false;
  }
}

async function handleAppUrl(url) {
  if (!isNarrowAppAction(url)) return;
  const targetId = new URL(url).searchParams.get('targetId');
  try {
    await openTarget(targetId);
  } catch (error) {
    await showError('Could not open remote target', error);
  }
}

async function handleAppUrlSafely(url) {
  try {
    await handleAppUrl(url);
  } catch (error) {
    console.error('Deep-link handling failed:', error);
  }
}

let appUrlHandlingChain = Promise.resolve();
function enqueueAppUrl(url) {
  if (!isNarrowAppAction(url)) return;
  if (!appUrlHandlingReady) {
    pendingAppUrls.push(url);
    return;
  }
  appUrlHandlingChain = appUrlHandlingChain
    .then(() => handleAppUrlSafely(url));
}

async function drainPendingAppUrls() {
  while (pendingAppUrls.length) {
    await handleAppUrlSafely(pendingAppUrls.shift());
  }
}


function registerProtocolHandler() {
  const appEntry = path.join(getAppRoot(), 'electron', 'main.js');
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [appEntry]);
  } else {
    app.setAsDefaultProtocolClient(APP_PROTOCOL);
  }
}

function assertTrustedIpcSender(event) {
  const sender = event?.sender;
  const mainContents = desktopWindow?.getMainWindow()?.webContents;
  const settingsContents = desktopWindow?.settingsWindow?.webContents;
  if (sender !== mainContents && sender !== settingsContents) {
    throw new Error('Desktop IPC sender is not a registered launcher window.');
  }

  const frame = event?.senderFrame;
  if (!frame?.isMainFrame) {
    throw new Error('Desktop IPC is restricted to the launcher main frame.');
  }

  const allowSettingsQuery = sender === settingsContents;
  if (!desktopWindow?.isCanonicalLauncherUrl(frame.url, allowSettingsQuery)) {
    throw new Error('Desktop IPC is restricted to the canonical local launcher.');
  }
}

function ipcResponse(handler) {
  return async (...args) => {
    try {
      assertTrustedIpcSender(args[0]);
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

function registerIpcHandlers() {
  ipcMain.handle('chatmux-desktop:state:get', ipcResponse(() => getDesktopState()));
  ipcMain.handle('chatmux-desktop:copy-diagnostics', ipcResponse(() => copyDiagnostics()));
  ipcMain.handle('chatmux-desktop:copy-local-web-url', ipcResponse(() => copyLocalWebUrl()));
  ipcMain.handle('chatmux-desktop:local:open', ipcResponse(() => openLocalTarget()));
  ipcMain.handle('chatmux-desktop:open-local-web-ui', ipcResponse(() => openLocalWebUi()));
  ipcMain.handle('chatmux-desktop:reload-active-tab', ipcResponse(() => desktopWindow.reloadActiveTab()));
  ipcMain.handle('chatmux-desktop:show-target-picker', ipcResponse(() => showTargetPicker()));
  ipcMain.handle('chatmux-desktop:show-launcher', ipcResponse(async () => {
    await desktopWindow.showLauncher();
    return getDesktopState();
  }));
  ipcMain.handle('chatmux-desktop:show-desktop-settings', ipcResponse(() => desktopWindow.showDesktopSettings()));
  ipcMain.handle('chatmux-desktop:show-local-settings', ipcResponse(() => desktopWindow.showLocalSettings()));
  ipcMain.handle('chatmux-desktop:close-settings-window', ipcResponse(() => {
    desktopWindow.closeSettingsWindow();
    return getDesktopState();
  }));
  ipcMain.handle('chatmux-desktop:switch-tab', ipcResponse((_event, tabId) => desktopWindow.switchDesktopTab(tabId)));
  ipcMain.handle('chatmux-desktop:close-tab', ipcResponse((_event, tabId) => desktopWindow.closeDesktopTab(tabId)));
  ipcMain.handle('chatmux-desktop:update-setting', ipcResponse((_event, key, value) => updateDesktopSetting(key, value)));

  ipcMain.handle('chatmux-desktop:remote-servers:list', ipcResponse(async () => {
    const state = await remoteServers.getState();
    return { servers: state.servers, selectedId: state.selectedId };
  }));
  ipcMain.handle('chatmux-desktop:remote-servers:create', ipcResponse((_event, input) => saveTarget(input)));
  ipcMain.handle('chatmux-desktop:remote-servers:update', ipcResponse((_event, input) => {
    const { id, ...changes } = input ?? {};
    return updateTarget(id, changes);
  }));
  ipcMain.handle('chatmux-desktop:remote-servers:delete', ipcResponse((_event, targetId) => deleteTarget(targetId)));
  ipcMain.handle('chatmux-desktop:remote-servers:select', ipcResponse((_event, targetId) => selectTarget(targetId)));
  ipcMain.handle('chatmux-desktop:remote-servers:test', ipcResponse((_event, targetId) => testTarget(targetId)));
  ipcMain.handle('chatmux-desktop:remote-servers:open', ipcResponse((_event, targetId) => openTarget(targetId)));
}

function registerAppEvents() {

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (desktopWindow) {
        void desktopWindow.createWindow();
      } else {
        void createDesktopWindow();
      }
      return;
    }

    const window = desktopWindow?.getMainWindow();
    if (window) {
      window.show();
      window.focus();
    }
  });

  app.on('before-quit', (event) => {
    if (isQuitting || !localServer?.hasLifecycleWork()) return;

    event.preventDefault();
    isQuitting = true;
    const lifecycleWork = localServer.getSettings().keepLocalServerRunning
      ? localServer.detachOwnedServerWhenReady()
      : localServer.shutdownOwnedServer();
    void lifecycleWork.finally(() => app.quit());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

async function createDesktopWindow() {
  desktopWindow = new DesktopWindowManager({
    appName: APP_NAME,
    getWindowIconPath,
    getLauncherPath,
    getPreloadPath,
    openExternalUrl,
    getDesktopState,
    getTargetState,
    getLocalState,
    getDisplayTargetName,
    getRemoteTargetMenuItems,
    tabs,
    actions: {
      copyDiagnostics,
      copyText: (text) => clipboard.writeText(text),
      deleteTarget,
      getActiveTarget: () => activeTarget,
      openLocalTarget,
      openLocalWebUi,
      openTarget,
      saveTarget,
      setActiveTarget,
      showError,
      showTargetPicker,
      testTarget,
      updateDesktopSetting,
      updateTarget,
      copyLocalWebUrl,
    },
  });

  desktopWindow.createTray();
  await desktopWindow.createWindow();
}

function registerSingleInstance() {
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
    return false;
  }

  app.on('second-instance', (_event, argv) => {
    const appUrl = argv.find((arg) => arg.startsWith(`${APP_PROTOCOL}://`));
    if (appUrl) {
      enqueueAppUrl(appUrl);
    }

    const window = desktopWindow?.getMainWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });

  return true;
}

async function bootstrap() {
  app.name = APP_NAME;
  app.setName(APP_NAME);
  process.title = APP_NAME;

  await app.whenReady();
  app.setName(APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: APP_NAME,
  });

  localServer = new LocalServerController({
    appRoot: getAppRoot(),
    settingsPath: getSettingsPath(),
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    onChange: syncDesktopState,
  });
  remoteServers = new RemoteServersStore({
    storePath: getRemoteServersStorePath(),
    onChange: syncDesktopState,
  });

  await localServer.loadDesktopSettings();
  await remoteServers.load();

  registerProtocolHandler();
  registerIpcHandlers();
  registerAppEvents();
  const initialAppUrl = process.argv.find((arg) => arg.startsWith(`${APP_PROTOCOL}://`));
  if (initialAppUrl) {
    enqueueAppUrl(initialAppUrl);
  }
  await createDesktopWindow();
  await drainPendingAppUrls();
  appUrlHandlingReady = true;
}
function registerEarlyOpenUrlHandler() {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    enqueueAppUrl(url);
  });
}
registerEarlyOpenUrlHandler();

if (registerSingleInstance()) {
  bootstrap().catch(async (error) => {
    await showError('ChatMux failed to start', error);
    app.quit();
  });
}