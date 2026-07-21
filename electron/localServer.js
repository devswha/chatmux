import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { ServerInstaller } from './serverInstaller.js';

const DEFAULT_PORT = 3001;
const HOST = '127.0.0.1';
const DISPLAY_HOST = 'localhost';
const HEALTH_TIMEOUT_MS = 3000;
const HEALTH_MAX_RESPONSE_BYTES = 16 * 1024;
const SERVER_START_TIMEOUT_MS = 30000;
const SERVER_STOP_GRACE_MS = 3000;
const MAX_STARTUP_LOG_LINES = 300;
const LOCAL_SERVER_URL_ENV = 'CHATMUX_LOCAL_SERVER_URL';
const LOCAL_SERVER_PORT_ENV = 'CHATMUX_LOCAL_SERVER_PORT';

function requestJson(url, timeoutMs = HEALTH_TIMEOUT_MS, {
  httpGet = http.get,
  maxResponseBytes = HEALTH_MAX_RESPONSE_BYTES,
} = {}) {
  return new Promise((resolve) => {
    let req;
    let res;
    let timer;
    let settled = false;
    let responseBytes = 0;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const abort = () => {
      req?.destroy();
      res?.destroy();
      finish({ ok: false, json: null });
    };

    timer = setTimeout(abort, timeoutMs);
    req = httpGet(url, (response) => {
      res = response;
      let body = '';

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > maxResponseBytes) {
          abort();
          return;
        }
        body += chunk;
      });
      res.on('end', () => {
        if (settled) return;
        try {
          finish({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            json: JSON.parse(body),
          });
        } catch {
          finish({ ok: false, json: null });
        }
      });
      res.on('error', () => finish({ ok: false, json: null }));
    });

    req.on('error', () => finish({ ok: false, json: null }));
  });
}

async function isChatMuxAppServer(baseUrl, requestOptions) {
  const response = await requestJson(`${baseUrl}/health`, HEALTH_TIMEOUT_MS, requestOptions);
  return response.ok
    && response.json?.status === 'ok'
    && response.json?.product === 'chatmux'
    && response.json?.protocolVersion === 1
    && typeof response.json?.version === 'string'
    && Boolean(response.json.version.trim());
}

function isPortAvailable(port, host = HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : DEFAULT_PORT;
      server.close(() => resolve(port));
    });
    server.listen(0, HOST);
  });
}

function getDesktopPath() {
  const currentPath = process.env.PATH || '';
  const home = os.homedir();
  const commonPaths = process.platform === 'win32'
    ? []
    : [
        path.join(home, '.local', 'bin'),
        path.join(home, '.bun', 'bin'),
        '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
      ];

  return [...commonPaths, currentPath].filter(Boolean).join(path.delimiter);
}

function getNodeRuntime(usePackagedElectronRuntime) {
  if (process.env.CHATMUX_NODE_PATH) {
    return { command: process.env.CHATMUX_NODE_PATH, env: {}, label: 'CHATMUX_NODE_PATH' };
  }

  if (usePackagedElectronRuntime && process.versions.electron) {
    return {
      command: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      label: `Electron ${process.versions.electron} Node ${process.versions.node}`,
    };
  }

  if (process.env.npm_node_execpath) {
    return { command: process.env.npm_node_execpath, env: {}, label: 'npm_node_execpath' };
  }

  return { command: 'node', env: {}, label: 'PATH node' };
}

function stripTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function getDisplayUrl(baseUrl) {
  const parsed = new URL(baseUrl);
  if (parsed.hostname === HOST) parsed.hostname = DISPLAY_HOST;
  return stripTrailingSlash(parsed.toString());
}

function isLoopbackHost(hostname) {
  return hostname === HOST || hostname === DISPLAY_HOST || hostname === '[::1]';
}

function getConfiguredLocalUrl() {
  const rawUrl = process.env[LOCAL_SERVER_URL_ENV];
  if (rawUrl && rawUrl.trim()) {
    let parsed;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      throw new Error(`${LOCAL_SERVER_URL_ENV} must be a valid loopback HTTP URL.`);
    }

    if (
      parsed.protocol !== 'http:'
      || !isLoopbackHost(parsed.hostname)
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      throw new Error(`${LOCAL_SERVER_URL_ENV} must be a loopback HTTP origin without credentials or a path.`);
    }

    return stripTrailingSlash(parsed.toString());
  }

  const rawPort = process.env[LOCAL_SERVER_PORT_ENV];
  if (!rawPort) return `http://${HOST}:${DEFAULT_PORT}`;
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== rawPort) {
    throw new Error(`${LOCAL_SERVER_PORT_ENV} must be an integer between 1 and 65535.`);
  }
  return `http://${HOST}:${port}`;
}

function getPortFromUrl(baseUrl) {
  const parsed = new URL(baseUrl);
  return parsed.port ? Number.parseInt(parsed.port, 10) : 80;
}

async function waitForChatMuxAppServer(baseUrl, timeoutMs, shouldContinue = () => true) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs && shouldContinue()) {
    if (await isChatMuxAppServer(baseUrl)) return true;
    if (!shouldContinue()) return false;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

export class LocalServerController {
  constructor({
    appRoot,
    settingsPath,
    isPackaged = false,
    appVersion,
    onChange,
    spawnImpl = spawn,
    killImpl = process.kill.bind(process),
    platform = process.platform,
    taskkillImpl,
  }) {
    this.appRoot = appRoot;
    this.settingsPath = settingsPath;
    this.isPackaged = isPackaged;
    this.appVersion = appVersion;
    this.onChange = onChange;
    this.localServerUrl = null;
    this.localServerPort = null;
    this.ownedServerProcess = null;
    this.localServerStartPromise = null;
    this.isStopping = false;
    this.shutdownPromise = null;
    this.ownedServerStopPromise = null;
    this.localServerStartOwner = null;
    this.spawnImpl = spawnImpl;
    this.killImpl = killImpl;
    this.platform = platform;
    this.taskkillImpl = taskkillImpl || ((pid, force) => {
      const taskkill = this.spawnImpl('taskkill', [
        '/pid',
        String(pid),
        '/T',
        ...(force ? ['/F'] : []),
      ], { stdio: 'ignore', windowsHide: true });
      taskkill.on?.('error', () => {});
    });
    this.startupLogs = [];
    this.desktopSettings = {
      keepLocalServerRunning: false,
      themeMode: 'system',
    };
  }

  getSettings() {
    return this.desktopSettings;
  }

  getLocalServerUrl() {
    return this.localServerUrl;
  }

  getShareableWebUrl() {
    return this.localServerUrl;
  }

  getHealthCheckUrl() {
    if (!this.localServerPort) return this.localServerUrl;
    return `http://${HOST}:${this.localServerPort}`;
  }

  appendStartupLog(line) {
    const text = String(line || '').trimEnd();
    if (!text) return;
    const timestamp = new Date().toLocaleTimeString();
    this.startupLogs.push(`[${timestamp}] ${text}`);
    if (this.startupLogs.length > MAX_STARTUP_LOG_LINES) {
      this.startupLogs.splice(0, this.startupLogs.length - MAX_STARTUP_LOG_LINES);
    }
    this.onChange?.();
  }

  getStartupLogs() {
    return [...this.startupLogs];
  }

  getPendingTarget() {
    let url = `http://${DISPLAY_HOST}:${DEFAULT_PORT}`;
    try {
      url = getDisplayUrl(getConfiguredLocalUrl());
    } catch {
      // The explicit Open action reports malformed configuration.
    }
    return {
      kind: 'local',
      name: 'ChatMux Local',
      url: this.localServerUrl || url,
    };
  }

  async loadDesktopSettings() {
    try {
      const raw = await fs.readFile(this.settingsPath, 'utf8');
      const stored = JSON.parse(raw);
      this.desktopSettings = {
        keepLocalServerRunning: Boolean(stored.keepLocalServerRunning),
        themeMode: stored.themeMode === 'light' || stored.themeMode === 'dark' ? stored.themeMode : 'system',
      };
    } catch {
      this.desktopSettings = {
        keepLocalServerRunning: false,
        themeMode: 'system',
      };
    }
  }

  async saveDesktopSettings(nextSettings = this.desktopSettings) {
    this.desktopSettings = {
      keepLocalServerRunning: Boolean(nextSettings.keepLocalServerRunning),
      themeMode: nextSettings.themeMode === 'light' || nextSettings.themeMode === 'dark' ? nextSettings.themeMode : 'system',
    };
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    await fs.writeFile(this.settingsPath, JSON.stringify(this.desktopSettings, null, 2), 'utf8');
    this.onChange?.();
  }

  async updateDesktopSetting(key, value) {
    if (!Object.prototype.hasOwnProperty.call(this.desktopSettings, key)) {
      throw new Error(`Unknown desktop setting: ${key}`);
    }

    const nextValue = key === 'themeMode' ? value : Boolean(value);
    await this.saveDesktopSettings({ ...this.desktopSettings, [key]: nextValue });
    return {
      desktopSettings: this.desktopSettings,
    };
  }

  async resolveServerEntry() {
    const installer = new ServerInstaller({
      appRoot: this.appRoot,
      onLog: (line) => this.appendStartupLog(line),
    });
    return installer.ensureInstalled();
  }

  startLocalServer(port, serverEntry) {
    const runtime = getNodeRuntime(this.isPackaged);
    const serverCwd = this.appRoot;
    const command = `${runtime.command} ${serverEntry}`;

    this.appendStartupLog(`$ ${command}`);
    this.appendStartupLog(`runtime: ${runtime.label}`);
    this.appendStartupLog(`cwd: ${serverCwd}`);
    this.appendStartupLog(`HOST=${HOST} SERVER_PORT=${port} NODE_ENV=production`);

    const child = this.spawnImpl(runtime.command, [serverEntry], {
      cwd: serverCwd,
      detached: true,
      env: {
        ...process.env,
        ...runtime.env,
        HOST,
        SERVER_PORT: String(port),
        [LOCAL_SERVER_PORT_ENV]: String(port),
        NODE_ENV: 'production',
        PATH: getDesktopPath(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.ownedServerProcess = child;

    child.once('error', (error) => {
      this.appendStartupLog(`failed to start process: ${error.message}`);
      if (this.ownedServerProcess === child) {
        this.ownedServerProcess = null;
        this.localServerUrl = null;
        this.localServerPort = null;
        this.onChange?.();
      }
    });

    child.stdout?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) this.appendStartupLog(line);
    });

    child.stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) this.appendStartupLog(`stderr: ${line}`);
    });

    child.once('exit', (code, signal) => {
      this.appendStartupLog(`process exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`);
      if (this.ownedServerProcess === child) {
        console.error(`ChatMux local server exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`);
        this.ownedServerProcess = null;
        this.localServerUrl = null;
        this.localServerPort = null;
        this.onChange?.();
      }
    });
    return child;
  }

  async resolveLocalServerUrl() {
    this.localServerStartOwner = null;
    const devUrl = process.env.ELECTRON_DEV_URL;
    const configuredUrl = getConfiguredLocalUrl();
    const configuredPort = getPortFromUrl(configuredUrl);

    if (devUrl) {
      const ready = await waitForChatMuxAppServer(
        configuredUrl,
        SERVER_START_TIMEOUT_MS,
        () => !this.isStopping,
      );
      if (!ready) {
        throw new Error(`Development server did not become ready at ${getDisplayUrl(configuredUrl)}.`);
      }
      this.localServerPort = configuredPort;
      return devUrl;
    }

    // This health check is made only as part of the user-triggered Local Open
    // action. It allows a separately started loopback ChatMux server to stay
    // in charge of its own lifecycle.
    if (await isChatMuxAppServer(configuredUrl)) {
      this.localServerPort = configuredPort;
      const displayUrl = getDisplayUrl(configuredUrl);
      this.appendStartupLog(`Using ChatMux Local at ${displayUrl}`);
      return displayUrl;
    }

    let port = configuredPort;
    if (!await isPortAvailable(port, HOST)) {
      if (process.env[LOCAL_SERVER_URL_ENV] || process.env[LOCAL_SERVER_PORT_ENV]) {
        throw new Error(`ChatMux Local is unavailable at ${getDisplayUrl(configuredUrl)}.`);
      }
      port = await getFreePort();
    }

    const serverEntry = await this.resolveServerEntry();
    const serverUrl = `http://${HOST}:${port}`;
    const displayUrl = `http://${DISPLAY_HOST}:${port}`;
    this.localServerPort = port;
    if (this.isStopping) {
      throw new Error('ChatMux Local startup was cancelled.');
    }
    const child = this.startLocalServer(port, serverEntry);
    this.localServerStartOwner = child;

    const ready = await waitForChatMuxAppServer(
      serverUrl,
      SERVER_START_TIMEOUT_MS,
      () => !this.isStopping,
    );
    if (!ready) {
      const recentLogs = this.getStartupLogs().slice(-20).join('\n');
      await this.stopOwnedServerProcess();
      if (this.isStopping) {
        throw new Error('ChatMux Local startup was cancelled.');
      }
      this.localServerPort = null;
      throw new Error([
        `ChatMux Local did not become ready at ${displayUrl}.`,
        recentLogs ? `Recent startup output:\n${recentLogs}` : 'No startup output was captured.',
      ].join('\n\n'));
    }

    if (
      this.ownedServerProcess !== child
      || !this.isChildRunning(child)
    ) {
      throw new Error('ChatMux Local exited during startup.');
    }
    this.appendStartupLog(`ChatMux Local ready at ${displayUrl}`);
    return displayUrl;
  }

  async ensureLocalServer() {
    if (this.isStopping) {
      throw new Error('ChatMux Local is shutting down.');
    }
    if (this.localServerUrl) return this.localServerUrl;
    if (!this.localServerStartPromise) {
      const startup = this.resolveLocalServerUrl().then((url) => {
        if (this.isStopping) {
          throw new Error('ChatMux Local startup was cancelled.');
        }
        const startOwner = this.localServerStartOwner;
        if (
          startOwner
          && (
            this.ownedServerProcess !== startOwner
            || !this.isChildRunning(startOwner)
          )
        ) {
          throw new Error('ChatMux Local exited during startup.');
        }
        this.localServerUrl = url;
        return url;
      });
      this.localServerStartPromise = startup;
      startup.finally(() => {
        if (this.localServerStartPromise === startup) {
          this.localServerStartPromise = null;
          this.localServerStartOwner = null;
        }
      }).catch(() => {});
    }
    return this.localServerStartPromise;
  }

  async getResolvedTarget() {
    await this.ensureLocalServer();
    return {
      kind: 'local',
      name: 'ChatMux Local',
      url: this.localServerUrl,
    };
  }

  async loadLocalTarget() {
    return {
      pendingTarget: this.getPendingTarget(),
      target: await this.getResolvedTarget(),
    };
  }

  hasOwnedServer() {
    return Boolean(this.ownedServerProcess);
  }

  hasLifecycleWork() {
    return Boolean(this.ownedServerProcess || this.localServerStartPromise);
  }

  async detachOwnedServerWhenReady() {
    const startup = this.localServerStartPromise;
    if (startup) {
      await startup.catch(() => {});
    }
    this.detachOwnedServer();
  }

  detachOwnedServer() {
    if (!this.ownedServerProcess) return;
    this.ownedServerProcess.unref();
    this.ownedServerProcess = null;
  }

  isChildRunning(child) {
    return child.exitCode == null && child.signalCode == null;
  }

  signalOwnedChildTree(child, signal) {
    if (this.ownedServerProcess !== child || !this.isChildRunning(child) || !Number.isInteger(child.pid) || child.pid <= 0) {
      return false;
    }

    try {
      if (this.platform === 'win32') {
        this.taskkillImpl(child.pid, signal === 'SIGKILL');
      } else {
        this.killImpl(-child.pid, signal);
      }
      return true;
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        this.appendStartupLog(`failed to stop process: ${error.message}`);
      }
      return false;
    }
  }

  waitForChildExit(child, timeoutMs = SERVER_STOP_GRACE_MS) {
    if (!this.isChildRunning(child)) return Promise.resolve(true);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.removeListener?.('exit', onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      child.once('exit', onExit);
    });
  }

  async stopOwnedServerProcess() {
    if (this.ownedServerStopPromise) return this.ownedServerStopPromise;

    const child = this.ownedServerProcess;
    if (!child) return;

    const stop = (async () => {
      this.signalOwnedChildTree(child, 'SIGTERM');
      let exited = await this.waitForChildExit(child);
      if (!exited) {
        this.signalOwnedChildTree(child, 'SIGKILL');
        exited = await this.waitForChildExit(child);
      }

      if (exited && this.ownedServerProcess === child) this.ownedServerProcess = null;
    })();

    this.ownedServerStopPromise = stop;
    try {
      await stop;
    } finally {
      if (this.ownedServerStopPromise === stop) this.ownedServerStopPromise = null;
    }
  }

  async shutdownOwnedServer() {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.isStopping = true;
    const shutdown = (async () => {
      const startup = this.localServerStartPromise;
      const earlyStop = this.stopOwnedServerProcess();
      if (startup) {
        await startup.catch(() => {});
      }
      await earlyStop;
      await this.stopOwnedServerProcess();
    })();

    this.shutdownPromise = shutdown;
    try {
      await shutdown;
    } finally {
      if (this.shutdownPromise === shutdown) this.shutdownPromise = null;
    }
  }
}

export {
  DEFAULT_PORT,
  HEALTH_MAX_RESPONSE_BYTES,
  HEALTH_TIMEOUT_MS,
  HOST,
  isChatMuxAppServer,
  requestJson,
};
