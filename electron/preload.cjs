const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { contextBridge, ipcRenderer } = require('electron');

const IPC_PREFIX = 'chatmux-desktop:';

function invoke(action, ...args) {
  return ipcRenderer.invoke(`${IPC_PREFIX}${action}`, ...args);
}

function onStateChanged(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('State change listener must be a function.');
  }

  const listener = (_event, state) => callback(state);
  ipcRenderer.on(`${IPC_PREFIX}state:changed`, listener);
  return () => {
    ipcRenderer.removeListener(`${IPC_PREFIX}state:changed`, listener);
  };
}
const launcherUrl = pathToFileURL(path.join(__dirname, 'launcher', 'index.html'));
const SETTINGS_SHEETS = new Set(['desktop-settings', 'local-settings']);

function isCanonicalLauncherDocument() {
  try {
    const currentUrl = new URL(window.location.href);
    const isLauncherPath = currentUrl.protocol === launcherUrl.protocol
      && currentUrl.host === launcherUrl.host
      && currentUrl.pathname === launcherUrl.pathname;
    if (!isLauncherPath) return false;
    if (currentUrl.search === '') return true;

    const queryKeys = [...currentUrl.searchParams.keys()];
    return queryKeys.length === 2
      && queryKeys.includes('modal')
      && queryKeys.includes('sheet')
      && currentUrl.searchParams.get('modal') === '1'
      && SETTINGS_SHEETS.has(currentUrl.searchParams.get('sheet'));
  } catch {
    return false;
  }
}


if (isCanonicalLauncherDocument()) {
  contextBridge.exposeInMainWorld('chatmuxAppDesktop', {
    getState: () => invoke('state:get'),
    onStateChanged,
    openLocal: () => invoke('local:open'),
    listRemoteServers: () => invoke('remote-servers:list'),
    createRemoteServer: (server) => invoke('remote-servers:create', server),
    updateRemoteServer: (targetId, input) => invoke('remote-servers:update', { id: targetId, ...input }),
    deleteRemoteServer: (targetId) => invoke('remote-servers:delete', targetId),
    testRemoteServer: (targetId) => invoke('remote-servers:test', targetId),
    openRemoteServer: (targetId) => invoke('remote-servers:open', targetId),
    selectRemoteServer: (targetId) => invoke('remote-servers:select', targetId),
  });
}
