import { pathToFileURL } from 'node:url';

import { BrowserWindow, Menu, Tray, clipboard, nativeImage, nativeTheme, session, webContents as electronWebContents } from 'electron';

import {
  clearTargetSessionData,
  getTargetOrigin,
  getTargetPartition,
  isTargetUrlAllowed,
} from './targetSessions.js';
import { ViewHost } from './viewHost.js';

const TITLEBAR_HEIGHT = 44;
const ALLOWED_TARGET_PERMISSIONS = new Set(['notifications']);
const SETTINGS_SHEETS = new Set(['desktop-settings', 'local-settings']);

function getWebContentsProcessId(contents) {
  return {
    osProcessId: typeof contents.getOSProcessId === 'function' ? contents.getOSProcessId() : null,
    processId: typeof contents.getProcessId === 'function' ? contents.getProcessId() : null,
  };
}

export class DesktopWindowManager {
  constructor({
    appName,
    getWindowIconPath,
    getLauncherPath,
    getPreloadPath,
    openExternalUrl,
    getTargetState,
    getLocalState,
    getRemoteTargetMenuItems,
    actions,
    tabs,
  }) {
    this.appName = appName;
    this.getWindowIconPath = getWindowIconPath;
    this.getLauncherPath = getLauncherPath;
    this.getPreloadPath = getPreloadPath;
    this.openExternalUrl = openExternalUrl;
    this.getTargetState = getTargetState;
    this.getLocalState = getLocalState;
    this.getRemoteTargetMenuItems = getRemoteTargetMenuItems;
    this.actions = actions;
    this.tabs = tabs;

    this.mainWindow = null;
    this.settingsWindow = null;
    this.tray = null;
    this.launcherLoaded = false;
    this.targetsByPartition = new Map();
    this.configuredPermissionPartitions = new Set();
    this.viewHost = new ViewHost({
      appName: this.appName,
      getMainWindow: () => this.mainWindow,
      getContentViewBounds: () => this.getContentViewBounds(),
      getPreloadPath: this.getPreloadPath,
      openExternalUrl: this.openExternalUrl,
      showError: this.actions.showError,
    });
  }

  getMainWindow() {
    return this.mainWindow;
  }

  getTrayImage() {
    const image = nativeImage.createFromPath(this.getWindowIconPath());
    return image.resize({ width: 18, height: 18 });
  }

  getContentViewBounds() {
    if (!this.mainWindow) return { x: 0, y: TITLEBAR_HEIGHT, width: 0, height: 0 };
    const [width, height] = this.mainWindow.getContentSize();
    return {
      x: 0,
      y: TITLEBAR_HEIGHT,
      width,
      height: Math.max(0, height - TITLEBAR_HEIGHT),
    };
  }

  detachActiveContentView() {
    this.viewHost.detachAll();
  }

  async showTabPlaceholder(target, message) {
    const tabId = this.tabs.getTabIdForTarget(target);
    await this.viewHost.showTabPlaceholder(tabId, target, message);
  }

  async showLocalStartupTarget(target, logs) {
    const tabId = this.tabs.getTabIdForTarget(target);
    this.configureTargetPermissions(target);
    await this.viewHost.showLocalStartupTarget(tabId, target, logs);
  }

  async showContentTarget(target) {
    getTargetOrigin(target);
    this.configureTargetPermissions(target);
    const tabId = this.tabs.getTabIdForTarget(target);
    const finalUrl = await this.viewHost.showContentTarget(tabId, target);
    if (!isTargetUrlAllowed(target, finalUrl)) {
      throw new Error(`Refusing navigation outside the registered target origin: ${finalUrl}`);
    }
    return finalUrl;
  }

  destroyTabView(tabId) {
    this.viewHost.destroyTabView(tabId);
  }

  emitTargetState() {
    const state = this.getTargetState();
    if (this.mainWindow && !this.mainWindow.webContents.isDestroyed()) {
      this.mainWindow.webContents.send('chatmux-desktop:state:changed', state);
    }
    if (this.settingsWindow && !this.settingsWindow.webContents.isDestroyed()) {
      this.settingsWindow.webContents.send('chatmux-desktop:state:changed', state);
    }
  }

  emitLauncherCommand(command) {
    if (!this.mainWindow || this.mainWindow.webContents.isDestroyed()) return;
    this.mainWindow.webContents.send('chatmux-desktop:launcher-command', command);
  }

  emitSettingsCommand(command) {
    if (!this.settingsWindow || this.settingsWindow.webContents.isDestroyed()) return;
    this.settingsWindow.webContents.send('chatmux-desktop:launcher-command', command);
  }

  syncSettingsWindowBounds() {
    if (!this.mainWindow || !this.settingsWindow || this.settingsWindow.isDestroyed()) return;
    this.settingsWindow.setBounds(this.mainWindow.getBounds());
  }

  async ensureSettingsWindow(sheet = 'desktop-settings') {
    if (!this.mainWindow) return null;

    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.syncSettingsWindowBounds();
      this.emitSettingsCommand({ type: 'open-sheet', sheet });
      this.settingsWindow.focus();
      return this.settingsWindow;
    }

    this.settingsWindow = new BrowserWindow({
      parent: this.mainWindow,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      movable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });
    this.syncSettingsWindowBounds();
    this.viewHost.configureChildWebContents(this.settingsWindow.webContents);
    this.restrictLauncherNavigation(this.settingsWindow.webContents, true);
    this.settingsWindow.once('ready-to-show', () => this.settingsWindow?.show());
    this.settingsWindow.on('closed', () => {
      this.settingsWindow = null;
    });
    await this.settingsWindow.loadFile(this.getLauncherPath(), {
      query: { modal: '1', sheet },
    });
    return this.settingsWindow;
  }

  closeSettingsWindow() {
    if (!this.settingsWindow || this.settingsWindow.isDestroyed()) return;
    this.settingsWindow.close();
  }
  isCanonicalLauncherUrl(url, allowSettingsQuery = false) {
    try {
      const candidate = new URL(url);
      const launcher = pathToFileURL(this.getLauncherPath());
      if (
        candidate.protocol !== launcher.protocol
        || candidate.host !== launcher.host
        || candidate.pathname !== launcher.pathname
      ) {
        return false;
      }
      if (!allowSettingsQuery) {
        return candidate.search === '';
      }

      const queryKeys = [...candidate.searchParams.keys()];
      return queryKeys.length === 2
        && queryKeys.includes('modal')
        && queryKeys.includes('sheet')
        && candidate.searchParams.get('modal') === '1'
        && SETTINGS_SHEETS.has(candidate.searchParams.get('sheet'));
    } catch {
      return false;
    }
  }

  restrictLauncherNavigation(contents, allowSettingsQuery = false) {
    contents.on('will-navigate', (event, url) => {
      if (!this.isCanonicalLauncherUrl(url, allowSettingsQuery)) event.preventDefault();
    });
  }


  configureTargetPermissions(target) {
    const partition = getTargetPartition(target);
    this.targetsByPartition.set(partition, target);
    if (this.configuredPermissionPartitions.has(partition)) return;

    const targetSession = session.fromPartition(partition);
    const isAllowedPermission = (permission, requestingOrigin, details) => {
      const registeredTarget = this.targetsByPartition.get(partition);
      return Boolean(
        registeredTarget
        && ALLOWED_TARGET_PERMISSIONS.has(permission)
        && details?.isMainFrame === true
        && isTargetUrlAllowed(registeredTarget, requestingOrigin),
      );
    };

    targetSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      callback(isAllowedPermission(permission, details?.requestingUrl, details));
    });
    targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => (
      isAllowedPermission(permission, requestingOrigin, details)
    ));
    this.configuredPermissionPartitions.add(partition);
  }

  async clearTargetSession(target) {
    const partition = getTargetPartition(target);
    const tabId = this.tabs.getTabIdForTarget(target);
    this.destroyTabView(tabId);
    await clearTargetSessionData(target, (targetPartition) => session.fromPartition(targetPartition));
    this.targetsByPartition.delete(partition);
  }

  async clearTargetSessionForOriginChange(previousTarget, nextTarget) {
    if (getTargetOrigin(previousTarget) !== getTargetOrigin(nextTarget)) {
      await this.clearTargetSession(previousTarget);
    }
  }

  async showTarget(target, { trackTab = true } = {}) {
    if (!this.mainWindow) return null;
    getTargetOrigin(target);
    if (trackTab) {
      this.tabs.upsertTarget(target);
    }
    this.actions.setActiveTarget(target);
    this.buildAppMenu();
    this.mainWindow.setTitle(`${this.appName} - ${target.name}`);
    const finalUrl = await this.showContentTarget(target);
    this.emitTargetState();
    return finalUrl;
  }

  async showLauncher() {
    if (!this.mainWindow) return;
    const target = { kind: 'launcher', id: 'home', name: this.appName, url: null };
    this.tabs.upsertTarget(target);
    this.actions.setActiveTarget(target);
    this.detachActiveContentView();
    this.buildAppMenu();
    this.mainWindow.setTitle(this.appName);
    this.mainWindow.webContents.focus();
    if (!this.launcherLoaded) {
      await this.mainWindow.loadFile(this.getLauncherPath());
      this.launcherLoaded = true;
    } else {
      this.emitTargetState();
    }
  }

  async switchDesktopTab(tabId) {
    const tab = this.tabs.activate(tabId);
    if (!tab || !this.mainWindow) return this.getTargetState();

    if (tab.id === 'home' || tab.kind === 'launcher') {
      await this.showLauncher();
      return this.getTargetState();
    }

    if (!tab.target?.url) {
      throw new Error('This tab does not have a target URL.');
    }

    await this.showTarget(tab.target, { trackTab: false });
    return this.getTargetState();
  }

  async reloadActiveTab() {
    const activeTab = this.tabs.getActiveTab();
    if (!activeTab || activeTab.id === 'home' || activeTab.kind === 'launcher') {
      this.emitTargetState();
      return this.getTargetState();
    }

    const reloaded = this.viewHost.reloadTab(activeTab.id);
    if (!reloaded && activeTab.target?.url) {
      await this.showTarget(activeTab.target, { trackTab: false });
    }
    this.emitTargetState();
    return this.getTargetState();
  }

  async navigateActiveView(url) {
    const activeTarget = this.getTargetState().activeTarget;
    if (!activeTarget || !isTargetUrlAllowed(activeTarget, url)) {
      throw new Error('Refusing navigation outside the active target origin.');
    }
    const navigated = await this.viewHost.navigateActiveView(url);
    this.emitTargetState();
    return navigated;
  }

  openActiveTabDevTools() {
    if (this.viewHost.openActiveViewDevTools()) return;
    void this.actions.showError('No active target view', new Error('Switch to a target tab before opening active tab DevTools.'));
  }

  reloadActiveBrowserViewForDiagnostics() {
    if (this.viewHost.reloadActiveView()) return;
    void this.actions.showError('No active target view', new Error('Switch to a target tab before reloading the active view.'));
  }

  detachActiveBrowserViewForDiagnostics() {
    if (this.viewHost.detachActiveView()) return;
    void this.actions.showError('No active target view', new Error('Switch to a target tab before detaching the active view.'));
  }

  copyWebContentsDiagnostics() {
    const tabViewDiagnostics = this.viewHost.getTabViewDiagnostics();
    const tabViewByContentsId = new Map(
      tabViewDiagnostics
        .filter((item) => item.webContentsId != null)
        .map((item) => [item.webContentsId, item]),
    );

    const rows = electronWebContents.getAllWebContents().map((contents) => {
      const destroyed = contents.isDestroyed();
      const processIds = destroyed ? { osProcessId: null, processId: null } : getWebContentsProcessId(contents);
      const tabView = tabViewByContentsId.get(contents.id);
      let owner = 'unknown';
      if (this.mainWindow?.webContents?.id === contents.id) {
        owner = 'main-window';
      } else if (this.settingsWindow?.webContents?.id === contents.id) {
        owner = 'settings-window';
      } else if (tabView) {
        owner = `target-view:${tabView.tabId}`;
      }

      return {
        id: contents.id,
        owner,
        osProcessId: processIds.osProcessId,
        processId: processIds.processId,
        url: destroyed ? null : contents.getURL(),
        title: destroyed ? null : contents.getTitle(),
        destroyed,
        focused: destroyed || typeof contents.isFocused !== 'function' ? false : contents.isFocused(),
        attached: tabView ? tabView.attached : null,
        active: tabView ? tabView.active : null,
      };
    });

    const activeTab = this.tabs.getActiveTab();
    clipboard.writeText(JSON.stringify({
      generatedAt: new Date().toISOString(),
      activeTabId: this.tabs.activeTabId,
      activeTab: activeTab
        ? {
            id: activeTab.id,
            title: activeTab.title,
            kind: activeTab.kind,
            targetUrl: activeTab.target?.url || null,
          }
        : null,
      tabViews: tabViewDiagnostics,
      webContents: rows,
    }, null, 2));
  }

  async closeDesktopTab(tabId) {
    const tab = this.tabs.remove(tabId);
    if (!tab) return this.getTargetState();
    this.destroyTabView(tabId);
    if (this.tabs.activeTabId === 'home') {
      await this.showLauncher();
    } else {
      this.emitTargetState();
    }
    return this.getTargetState();
  }

  buildAppMenu() {
    if (!this.mainWindow) return;
    const localState = this.getLocalState();
    const remoteItems = this.getRemoteTargetMenuItems();
    const template = [
      {
        label: this.appName,
        submenu: [
          { label: `About ${this.appName}`, role: 'about' },
          { type: 'separator' },
          {
            label: 'Show Launcher',
            accelerator: 'CmdOrCtrl+Shift+L',
            click: () => void this.showLauncher().catch((error) => this.actions.showError('Could not show launcher', error)),
          },
          {
            label: 'Switch Target',
            accelerator: 'CmdOrCtrl+Shift+T',
            click: () => void this.actions.showTargetPicker().catch((error) => this.actions.showError('Could not switch target', error)),
          },
          {
            label: 'Diagnostics',
            submenu: [
              { label: 'Copy Diagnostics', click: () => void this.actions.copyDiagnostics() },
            ],
          },
          { type: 'separator' },
          { label: process.platform === 'darwin' ? `Hide ${this.appName}` : 'Hide', role: 'hide', visible: process.platform === 'darwin' },
          { label: 'Hide Others', role: 'hideOthers', visible: process.platform === 'darwin' },
          { label: 'Show All', role: 'unhide', visible: process.platform === 'darwin' },
          { type: 'separator', visible: process.platform === 'darwin' },
          { label: `Quit ${this.appName}`, accelerator: 'CmdOrCtrl+Q', role: 'quit' },
        ],
      },
      {
        label: 'Targets',
        submenu: [
          {
            label: 'Show Launcher',
            accelerator: 'CmdOrCtrl+Shift+L',
            click: () => void this.showLauncher().catch((error) => this.actions.showError('Could not show launcher', error)),
          },
          {
            label: 'Switch Target',
            accelerator: 'CmdOrCtrl+Shift+T',
            click: () => void this.actions.showTargetPicker().catch((error) => this.actions.showError('Could not switch target', error)),
          },
          { type: 'separator' },
          {
            label: 'Open Local',
            accelerator: 'CmdOrCtrl+L',
            click: () => void this.actions.openLocalTarget().catch((error) => this.actions.showError('Could not open Local', error)),
          },
          {
            label: 'Open Local in Browser',
            click: () => void this.actions.openLocalWebUi().catch((error) => this.actions.showError('Could not open Local in browser', error)),
          },
          {
            label: 'Copy Local URL',
            click: () => void this.actions.copyLocalWebUrl().catch((error) => this.actions.showError('Could not copy Local URL', error)),
          },
          { type: 'separator' },
          { label: 'Remote Targets', submenu: remoteItems },
          { type: 'separator' },
          {
            label: 'Keep Local Server Running After Quit',
            type: 'checkbox',
            checked: Boolean(localState.desktopSettings?.keepLocalServerRunning),
            click: (menuItem) => void this.actions.updateDesktopSetting('keepLocalServerRunning', menuItem.checked)
              .catch((error) => this.actions.showError('Could not update desktop setting', error)),
          },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { label: 'Open Active Target DevTools', click: () => this.openActiveTabDevTools() },
          { label: 'Copy WebContents Diagnostics', click: () => this.copyWebContentsDiagnostics() },
          { label: 'Reload Active Target View', click: () => this.reloadActiveBrowserViewForDiagnostics() },
          { label: 'Detach Active Target View', click: () => this.detachActiveBrowserViewForDiagnostics() },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front' }] : []),
        ],
      },
      {
        label: 'Help',
        submenu: [
          { label: 'Copy Diagnostics', click: () => void this.actions.copyDiagnostics() },
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    this.buildTrayMenu();
  }

  buildTrayMenu() {
    if (!this.tray) return;
    const localState = this.getLocalState();
    const template = [
      {
        label: 'Local',
        submenu: [
          {
            label: localState.localServerRunning ? 'Open Local' : 'Start Local',
            click: () => void this.actions.openLocalTarget().catch((error) => this.actions.showError('Could not open Local', error)),
          },
          {
            label: 'Open Local in Browser',
            click: () => void this.actions.openLocalWebUi().catch((error) => this.actions.showError('Could not open Local in browser', error)),
          },
          {
            label: 'Copy Local URL',
            click: () => void this.actions.copyLocalWebUrl().catch((error) => this.actions.showError('Could not copy Local URL', error)),
          },
        ],
      },
      { label: 'Remote Targets', submenu: this.getRemoteTargetMenuItems() },
      { type: 'separator' },
      { label: `Quit ${this.appName}`, role: 'quit' },
    ];

    const activeTarget = this.getTargetState().activeTarget;
    this.tray.setToolTip(`${this.appName}${activeTarget?.name ? ` - ${activeTarget.name}` : ''}`);
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  async showDesktopSettings() {
    if (!this.mainWindow) return this.getTargetState();
    await this.ensureSettingsWindow('desktop-settings');
    return this.getTargetState();
  }

  async showLocalSettings() {
    if (!this.mainWindow) return this.getTargetState();
    await this.ensureSettingsWindow('local-settings');
    return this.getTargetState();
  }

  createTray() {
    if (this.tray) return;
    this.tray = new Tray(this.getTrayImage());
    this.tray.on('click', () => {
      if (!this.mainWindow) return;
      if (this.mainWindow.isVisible()) {
        this.mainWindow.focus();
      } else {
        this.mainWindow.show();
      }
    });
    this.buildTrayMenu();
  }

  async createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 1024,
      minHeight: 720,
      show: false,
      backgroundColor: '#0f172a',
      title: this.appName,
      icon: this.getWindowIconPath(),
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 18, y: 14 } }
        : {
            titleBarOverlay: {
              color: nativeTheme.shouldUseDarkColors ? '#111111' : '#f7f8fa',
              symbolColor: nativeTheme.shouldUseDarkColors ? '#a1a1a1' : '#5b6470',
              height: TITLEBAR_HEIGHT,
            },
          }),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });
    this.restrictLauncherNavigation(this.mainWindow.webContents);

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow?.show();
    });

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternalUrl(url).catch((error) => this.actions.showError('Could not open external link', error));
      return { action: 'deny' };
    });

    this.mainWindow.on('resize', () => {
      this.viewHost.resizeActiveView();
      this.syncSettingsWindowBounds();
    });
    this.mainWindow.on('move', () => {
      this.syncSettingsWindowBounds();
    });
    this.mainWindow.on('closed', () => {
      this.viewHost.clear();
      this.settingsWindow = null;
      this.mainWindow = null;
      this.launcherLoaded = false;
    });

    this.buildAppMenu();
    await this.showLauncher();
  }
}
