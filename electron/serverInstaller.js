import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CHECKOUT_ROOT = path.join(os.homedir(), '.local', 'share', 'chatmux');
const DEFAULT_STATE_ROOT = path.join(os.homedir(), '.chatmux');
const SERVER_ENTRY_RELATIVE_PATH = path.join('dist-server', 'server', 'index.js');

/**
 * Resolves the server built from the current ChatMux checkout.
 *
 * Desktop source runs never download or install a separate server bundle. The
 * repository lifecycle manager owns installation; this class only verifies
 * that its current checkout has a built server entry.
 */
export class ServerInstaller {
  constructor({
    appRoot = process.env.CHATMUX_INSTALL_DIR || DEFAULT_CHECKOUT_ROOT,
    stateRoot = DEFAULT_STATE_ROOT,
    onLog,
  } = {}) {
    this.appRoot = path.resolve(appRoot);
    this.stateRoot = path.resolve(stateRoot);
    this.onLog = typeof onLog === 'function' ? onLog : () => {};
  }

  getServerEntry() {
    return path.join(this.appRoot, SERVER_ENTRY_RELATIVE_PATH);
  }

  getInstallationStatePath() {
    return path.join(this.stateRoot, 'local-server.json');
  }

  async getInstallationState() {
    const serverEntry = this.getServerEntry();
    try {
      await fs.access(serverEntry);
      return {
        appRoot: this.appRoot,
        serverEntry,
        statePath: this.getInstallationStatePath(),
        ready: true,
      };
    } catch {
      return {
        appRoot: this.appRoot,
        serverEntry,
        statePath: this.getInstallationStatePath(),
        ready: false,
      };
    }
  }

  async isInstalled() {
    return (await this.getInstallationState()).ready;
  }

  async ensureInstalled() {
    const state = await this.getInstallationState();
    if (state.ready) {
      this.onLog(`Using ChatMux server from ${state.serverEntry}`);
      return state.serverEntry;
    }

    throw new Error([
      `ChatMux server is not built at ${state.serverEntry}.`,
      `Build the current checkout at ${state.appRoot} with \`npm run build:server\` before opening ChatMux Local.`,
    ].join(' '));
  }
}

export { DEFAULT_CHECKOUT_ROOT, DEFAULT_STATE_ROOT, SERVER_ENTRY_RELATIVE_PATH };
