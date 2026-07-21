import { BrowserView } from 'electron';

import {
  getTargetOrigin,
  getTargetPartition,
  isTargetUrlAllowed,
  LOCAL_TARGET_ID,
} from './targetSessions.js';

const TARGET_LOAD_TIMEOUT_MS = 20000;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPlaceholderHtml(title, message, logs = []) {
  const logHtml = logs.length
    ? `<pre>${logs.map(escapeHtml).join('\n')}</pre>`
    : '<pre>Waiting for process output...</pre>';
  return [
    '<!doctype html><meta charset="utf-8">',
    '<style>',
    'html,body{margin:0;height:100%;background:#0a0a0a;color:#fafafa;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    'body{padding:28px;overflow:hidden}',
    '.shell{height:100%;display:flex;flex-direction:column;gap:16px}',
    '.box{display:flex;align-items:center;gap:10px;color:#d4d4d4;flex:0 0 auto}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#0b60ea;box-shadow:0 0 0 6px rgba(11,96,234,.15)}',
    'pre{margin:0;flex:1;overflow:auto;border:1px solid #262626;border-radius:10px;background:#050505;color:#d4d4d4;padding:14px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;white-space:pre-wrap;user-select:text}',
    '</style>',
    '<div class="shell">',
    `<div class="box"><span class="dot"></span><span>${escapeHtml(message || `Opening ${title}...`)}</span></div>`,
    logHtml,
    '</div>',
  ].join('');
}

function getTargetTabId(target) {
  const origin = getTargetOrigin(target);

  if (target?.kind === 'local') {
    if (target.id !== LOCAL_TARGET_ID) {
      throw new Error('Local target must use the local target id.');
    }
    return { id: LOCAL_TARGET_ID, origin, partition: getTargetPartition(target) };
  }

  if (target?.kind === 'remote') {
    const targetId = String(target.id || '');
    const partition = getTargetPartition(target);
    return {
      id: `remote:${targetId}`,
      origin,
      partition,
    };
  }

  throw new Error('A content view requires a local or remote target.');
}

function normalizeTarget(target) {
  const address = getTargetTabId(target);
  const name = String(target.name || '').trim();
  if (!name) {
    throw new Error('Target must have a name.');
  }
  return {
    kind: target.kind,
    id: target.kind === 'local' ? LOCAL_TARGET_ID : String(target.id),
    name,
    url: address.origin,
    tabId: address.id,
    partition: address.partition,
  };
}

function isSafeExternalUrl(url) {
  try {
    const parsed = new URL(String(url));
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

async function loadUrlWithTimeout(webContents, url, timeoutMs = TARGET_LOAD_TIMEOUT_MS) {
  let timedOut = false;
  let timeout = null;
  const loadPromise = webContents.loadURL(url);
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      try {
        webContents.stop();
      } catch {
        // Ignore teardown races while reporting the original timeout.
      }
      reject(new Error(`Timed out loading ${url} after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
  });

  try {
    await Promise.race([loadPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      loadPromise.catch(() => {});
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class ViewHost {
  constructor({ appName, getMainWindow, getContentViewBounds, getPreloadPath, openExternalUrl, showError }) {
    this.appName = appName;
    this.getMainWindow = getMainWindow;
    this.getContentViewBounds = getContentViewBounds;
    this.getPreloadPath = getPreloadPath;
    this.openExternalUrl = openExternalUrl;
    this.showError = showError;
    this.activeContentView = null;
    this.tabViews = new Map();
  }

  openUrlExternally(url) {
    if (!isSafeExternalUrl(url)) return;
    try {
      Promise.resolve(this.openExternalUrl(url))
        .catch((error) => this.showError('Could not open external link', error));
    } catch (error) {
      this.showError('Could not open external link', error);
    }
  }

  configureChildWebContents(webContents, getTarget, allowInternalNavigation = () => false) {
    webContents.setWindowOpenHandler(({ url }) => {
      this.openUrlExternally(url);
      return { action: 'deny' };
    });

    if (typeof getTarget !== 'function') return;

    const guardNavigation = (event, url, openExternal) => {
      if (allowInternalNavigation(url)) return;

      const target = getTarget();
      if (target && isTargetUrlAllowed(target, url)) return;

      event.preventDefault();
      if (openExternal) this.openUrlExternally(url);
    };

    webContents.on('will-navigate', (event, url) => {
      guardNavigation(event, url, true);
    });
    webContents.on('will-frame-navigate', (event, url, isMainFrame) => {
      if (!isMainFrame) guardNavigation(event, url, false);
    });
    webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
      guardNavigation(event, url, isMainFrame !== false);
    });
  }

  detachAll() {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      for (const view of mainWindow.getBrowserViews()) {
        mainWindow.removeBrowserView(view);
      }
    } catch {
      // BrowserViews may already be gone during BrowserWindow teardown.
    }
    this.activeContentView = null;
  }

  detachActiveView() {
    const mainWindow = this.getMainWindow();
    const view = this.activeContentView;
    if (!mainWindow || mainWindow.isDestroyed() || !view) return false;
    try {
      if (mainWindow.getBrowserViews().includes(view)) {
        mainWindow.removeBrowserView(view);
      }
    } catch {
      return false;
    }
    this.activeContentView = null;
    return true;
  }

  getActiveView() {
    const view = this.activeContentView;
    if (!view || view.webContents.isDestroyed()) return null;
    return view;
  }

  openActiveViewDevTools() {
    const view = this.getActiveView();
    if (!view) return false;
    view.webContents.openDevTools({ mode: 'detach' });
    return true;
  }

  reloadActiveView() {
    const view = this.getActiveView();
    if (!view || !isTargetUrlAllowed(view.__chatmuxTarget, view.webContents.getURL())) return false;
    view.webContents.reloadIgnoringCache();
    return true;
  }

  getTabViewDiagnostics() {
    const mainWindow = this.getMainWindow();
    const attachedViews = new Set();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        for (const view of mainWindow.getBrowserViews()) {
          attachedViews.add(view);
        }
      } catch {
        // Ignore teardown races while gathering best-effort diagnostics.
      }
    }

    return Array.from(this.tabViews.entries()).map(([tabId, view]) => {
      const { webContents } = view;
      const destroyed = webContents.isDestroyed();
      return {
        tabId,
        webContentsId: destroyed ? null : webContents.id,
        url: destroyed ? null : webContents.getURL(),
        title: destroyed ? null : webContents.getTitle(),
        osProcessId: destroyed || typeof webContents.getOSProcessId !== 'function' ? null : webContents.getOSProcessId(),
        processId: destroyed || typeof webContents.getProcessId !== 'function' ? null : webContents.getProcessId(),
        attached: attachedViews.has(view),
        active: this.activeContentView === view,
        destroyed,
      };
    });
  }

  bindTargetToView(view, tabId, target) {
    const normalizedTarget = normalizeTarget(target);
    if (tabId !== normalizedTarget.tabId) {
      throw new Error('Tab id does not match the target id.');
    }
    if (
      view.__chatmuxTarget
      && (
        view.__chatmuxTarget.id !== normalizedTarget.id
        || view.__chatmuxTarget.kind !== normalizedTarget.kind
        || view.__chatmuxTarget.url !== normalizedTarget.url
        || view.__chatmuxPartition !== normalizedTarget.partition
      )
    ) {
      throw new Error('A tab view cannot be rebound to another target or origin.');
    }

    view.__chatmuxTarget = normalizedTarget;
    return normalizedTarget;
  }

  getOrCreateTabView(tabId, target) {
    const normalizedTarget = normalizeTarget(target);
    if (tabId !== normalizedTarget.tabId) {
      throw new Error('Tab id does not match the target id.');
    }

    let view = this.tabViews.get(tabId);
    if (view?.webContents.isDestroyed()) {
      if (this.activeContentView === view) this.activeContentView = null;
      this.tabViews.delete(tabId);
      view = null;
    }
    if (view) {
      this.bindTargetToView(view, tabId, normalizedTarget);
      return view;
    }

    view = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
        partition: normalizedTarget.partition,
      },
    });
    view.__chatmuxTarget = normalizedTarget;
    view.__chatmuxPartition = normalizedTarget.partition;
    view.__chatmuxAllowPlaceholderNavigation = false;
    this.configureChildWebContents(
      view.webContents,
      () => view.__chatmuxTarget,
      (url) => view.__chatmuxAllowPlaceholderNavigation
        && String(url).startsWith('data:text/html;charset=utf-8,'),
    );
    this.tabViews.set(tabId, view);
    return view;
  }

  async loadPlaceholder(view, html) {
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    view.__chatmuxAllowPlaceholderNavigation = true;
    try {
      await view.webContents.loadURL(url);
    } finally {
      view.__chatmuxAllowPlaceholderNavigation = false;
    }
  }

  attach(view) {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (this.activeContentView && this.activeContentView !== view) {
      this.detachAll();
    }
    this.activeContentView = view;
    try {
      if (!mainWindow.getBrowserViews().includes(view)) {
        mainWindow.addBrowserView(view);
      }
    } catch {
      return;
    }
    view.setBounds(this.getContentViewBounds());
    view.setAutoResize({ width: true, height: true });
  }

  resizeActiveView() {
    if (this.activeContentView) {
      this.activeContentView.setBounds(this.getContentViewBounds());
    }
  }

  async showTabPlaceholder(tabId, target, message) {
    const view = this.getOrCreateTabView(tabId, target);
    this.attach(view);
    const html = buildPlaceholderHtml(view.__chatmuxTarget.name || this.appName, message);
    await this.loadPlaceholder(view, html);
    view.__chatmuxStartupHtml = html;
    view.__chatmuxLoadedOrigin = null;
  }

  async showLocalStartupTarget(tabId, target, logs) {
    const view = this.getOrCreateTabView(tabId, target);
    if (view.__chatmuxLoadingOrigin) return;
    this.attach(view);
    const html = buildPlaceholderHtml(view.__chatmuxTarget.name || this.appName, 'Starting ChatMux Local...', logs);
    if (view.__chatmuxStartupHtml === html) return;
    await this.loadPlaceholder(view, html);
    view.__chatmuxStartupHtml = html;
    view.__chatmuxLoadedOrigin = null;
  }

  async showContentTarget(tabId, target) {
    const view = this.getOrCreateTabView(tabId, target);
    const targetOrigin = view.__chatmuxTarget.url;
    this.attach(view);

    if (view.__chatmuxLoadedOrigin !== targetOrigin) {
      view.__chatmuxLoadingOrigin = targetOrigin;
      try {
        await loadUrlWithTimeout(view.webContents, targetOrigin);
        const loadedUrl = view.webContents.getURL();
        if (!isTargetUrlAllowed(view.__chatmuxTarget, loadedUrl)) {
          throw new Error(`Refusing navigation outside the registered target origin: ${loadedUrl}`);
        }
        view.__chatmuxLoadedOrigin = targetOrigin;
        view.__chatmuxStartupHtml = null;
      } finally {
        if (view.__chatmuxLoadingOrigin === targetOrigin) {
          view.__chatmuxLoadingOrigin = null;
        }
      }
    }

    const currentUrl = view.webContents.getURL();
    if (!isTargetUrlAllowed(view.__chatmuxTarget, currentUrl)) {
      throw new Error(`Refusing navigation outside the registered target origin: ${currentUrl}`);
    }
    return currentUrl;
  }

  reloadTab(tabId) {
    const view = this.tabViews.get(tabId);
    if (
      !view
      || view.webContents.isDestroyed()
      || !isTargetUrlAllowed(view.__chatmuxTarget, view.webContents.getURL())
    ) return false;
    view.webContents.reloadIgnoringCache();
    return true;
  }

  async navigateActiveView(url) {
    const view = this.getActiveView();
    if (!view || !isTargetUrlAllowed(view.__chatmuxTarget, url)) {
      throw new Error('Refusing navigation outside the active target origin.');
    }
    await loadUrlWithTimeout(view.webContents, url);
    const loadedUrl = view.webContents.getURL();
    if (!isTargetUrlAllowed(view.__chatmuxTarget, loadedUrl)) {
      throw new Error(`Refusing navigation outside the registered target origin: ${loadedUrl}`);
    }
    view.__chatmuxLoadedOrigin = view.__chatmuxTarget.url;
    view.__chatmuxStartupHtml = null;
    return true;
  }

  destroyTabView(tabId) {
    const view = this.tabViews.get(tabId);
    if (!view) return;
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        if (mainWindow.getBrowserViews().includes(view)) {
          mainWindow.removeBrowserView(view);
        }
      } catch {
        // Ignore teardown races; Electron owns final destruction during quit.
      }
    }
    if (this.activeContentView === view) {
      this.activeContentView = null;
    }
    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.destroy();
      }
    } catch {
      // The view may already be destroyed by its parent BrowserWindow.
    }
    this.tabViews.delete(tabId);
  }

  clear() {
    this.tabViews.clear();
    this.activeContentView = null;
  }
}
