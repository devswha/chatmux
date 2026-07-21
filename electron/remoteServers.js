import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const REMOTE_SERVERS_STORE_VERSION = 1;
export const REMOTE_SERVER_PROBE_TIMEOUT_MS = 3_000;
export const REMOTE_HEALTH_MAX_RESPONSE_BYTES = 16 * 1024;

const MAX_REMOTE_SERVER_NAME_LENGTH = 80;
const OPAQUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function clone(value) {
  return structuredClone(value);
}

function createEmptyState() {
  return {
    version: REMOTE_SERVERS_STORE_VERSION,
    selectedId: null,
    servers: [],
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateName(name) {
  if (typeof name !== 'string') {
    throw new Error('Remote server name must be a string.');
  }

  const normalized = name.trim();
  if (!normalized || normalized.length > MAX_REMOTE_SERVER_NAME_LENGTH || /[\u0000-\u001F\u007F]/.test(normalized)) {
    throw new Error(`Remote server name must be 1 to ${MAX_REMOTE_SERVER_NAME_LENGTH} visible characters.`);
  }

  return normalized;
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function isExpectedHealthResponse(value) {
  return isPlainObject(value)
    && value.status === 'ok'
    && value.product === 'chatmux'
    && typeof value.protocolVersion === 'number'
    && Number.isSafeInteger(value.protocolVersion)
    && value.protocolVersion === 1
    && typeof value.version === 'string'
    && Boolean(value.version.trim());
}

async function readCappedResponseBody(
  response,
  maxBytes = REMOTE_HEALTH_MAX_RESPONSE_BYTES,
  rejectResponse = () => {},
) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined) {
    const declaredBytes = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      rejectResponse();
      await response.body?.cancel?.().catch(() => {});
      throw new Error('Remote server health probe response exceeded the size limit.');
    }
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    rejectResponse();
    throw new Error('Remote server health probe returned an invalid response body.');
  }

  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        rejectResponse();
        throw new Error('Remote server health probe returned an invalid response body.');
      }
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        rejectResponse();
        await reader.cancel().catch(() => {});
        throw new Error('Remote server health probe response exceeded the size limit.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock?.();
  }
}

export function normalizeRemoteServerUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('Remote server URL is required.');
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error('Remote server URL must be a valid HTTP(S) origin.');
  }

  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname))
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== '/') {
    throw new Error('Remote server URL must be a credentialless HTTPS origin, or an exact loopback HTTP origin, without a path, query, or fragment.');
  }

  return parsed.origin;
}

function validateOpaqueId(id) {
  if (typeof id !== 'string' || !OPAQUE_ID_PATTERN.test(id)) {
    throw new Error('Remote server ID is invalid.');
  }
  return id;
}

function normalizeServerInput(input, { requireAllFields = true } = {}) {
  if (!isPlainObject(input)) {
    throw new Error('Remote server input must be an object.');
  }

  const allowedFields = new Set(['name', 'url']);
  for (const key of Object.keys(input)) {
    if (!allowedFields.has(key)) {
      throw new Error(`Remote server field is not allowed: ${key}.`);
    }
  }

  if (requireAllFields && (!Object.hasOwn(input, 'name') || !Object.hasOwn(input, 'url'))) {
    throw new Error('Remote server name and URL are required.');
  }

  const normalized = {};
  if (Object.hasOwn(input, 'name')) normalized.name = validateName(input.name);
  if (Object.hasOwn(input, 'url')) normalized.url = normalizeRemoteServerUrl(input.url);
  if (!Object.keys(normalized).length) {
    throw new Error('At least one remote server field is required.');
  }
  return normalized;
}

function validatePersistedState(value) {
  if (!isPlainObject(value)
    || value.version !== REMOTE_SERVERS_STORE_VERSION
    || !Array.isArray(value.servers)
    || (!Object.hasOwn(value, 'selectedId'))
    || (value.selectedId !== null && typeof value.selectedId !== 'string')
    || Object.keys(value).some((key) => !['version', 'selectedId', 'servers'].includes(key))) {
    throw new Error('Remote server store has an invalid format.');
  }

  const ids = new Set();
  const origins = new Set();
  const servers = value.servers.map((server) => {
    if (!isPlainObject(server) || Object.keys(server).length !== 3
      || !Object.hasOwn(server, 'id') || !Object.hasOwn(server, 'name') || !Object.hasOwn(server, 'url')) {
      throw new Error('Remote server store contains an invalid server record.');
    }

    const id = validateOpaqueId(server.id);
    const name = validateName(server.name);
    const url = normalizeRemoteServerUrl(server.url);
    if (server.name !== name || server.url !== url || ids.has(id) || origins.has(url)) {
      throw new Error('Remote server store contains non-canonical or duplicate records.');
    }
    ids.add(id);
    origins.add(url);
    return { id, name, url };
  });

  if (value.selectedId !== null && !ids.has(value.selectedId)) {
    throw new Error('Remote server store selected ID does not exist.');
  }

  return {
    version: REMOTE_SERVERS_STORE_VERSION,
    selectedId: value.selectedId,
    servers,
  };
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

export class RemoteServersStore {
  constructor({ storePath, fsImpl = fs, randomUUID = crypto.randomUUID, onChange } = {}) {
    if (typeof storePath !== 'string' || !storePath) {
      throw new Error('Remote server store path is required.');
    }

    this.storePath = storePath;
    this.fs = fsImpl;
    this.randomUUID = randomUUID;
    this.onChange = onChange;
    this.state = createEmptyState();
    this.loadPromise = null;
    this.operationQueue = Promise.resolve();
    this.loadError = null;
  }

  async load() {
    if (!this.loadPromise) {
      this.loadPromise = this.#load();
    }
    await this.loadPromise;
    return clone(this.state);
  }

  async list() {
    await this.#waitForCurrentOperations();
    return clone(this.state.servers);
  }

  async get(targetId) {
    await this.#waitForCurrentOperations();
    const id = validateOpaqueId(targetId);
    const server = this.state.servers.find((item) => item.id === id);
    return server ? clone(server) : null;
  }

  getSnapshot() {
    return clone(this.state);
  }

  async getState() {
    await this.#waitForCurrentOperations();
    return clone(this.state);
  }

  async create(input) {
    const normalized = normalizeServerInput(input);
    return this.#queueMutation((next) => {
      if (next.servers.some((server) => server.url === normalized.url)) {
        throw new Error('A remote server with this exact origin already exists.');
      }

      const server = {
        id: this.randomUUID(),
        ...normalized,
      };
      validateOpaqueId(server.id);
      next.servers.push(server);
      return server;
    });
  }

  async update(targetId, input) {
    const id = validateOpaqueId(targetId);
    const normalized = normalizeServerInput(input, { requireAllFields: false });
    return this.#queueMutation((next) => {
      const index = next.servers.findIndex((server) => server.id === id);
      if (index < 0) {
        throw new Error('Remote server not found.');
      }

      const updated = { ...next.servers[index], ...normalized };
      if (next.servers.some((server, serverIndex) => serverIndex !== index && server.url === updated.url)) {
        throw new Error('A remote server with this exact origin already exists.');
      }
      next.servers[index] = updated;
      return updated;
    });
  }

  async delete(targetId) {
    const id = validateOpaqueId(targetId);
    return this.#queueMutation((next) => {
      const index = next.servers.findIndex((server) => server.id === id);
      if (index < 0) {
        throw new Error('Remote server not found.');
      }

      const [removed] = next.servers.splice(index, 1);
      if (next.selectedId === id) next.selectedId = null;
      return removed;
    });
  }

  async select(targetId) {
    const id = validateOpaqueId(targetId);
    return this.#queueMutation((next) => {
      const server = next.servers.find((item) => item.id === id);
      if (!server) {
        throw new Error('Remote server not found.');
      }
      next.selectedId = id;
      return server;
    });
  }

  async #load() {
    try {
      const raw = await this.fs.readFile(this.storePath, 'utf8');
      this.state = validatePersistedState(JSON.parse(raw));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.state = createEmptyState();
        return;
      }
      this.loadError = new Error(`Remote server store is invalid: ${errorMessage(error)}`);
      throw this.loadError;
    }
  }

  async #waitForCurrentOperations() {
    await this.load();
    await this.operationQueue;
  }

  async #queueMutation(mutator) {
    const operation = this.operationQueue.then(async () => {
      await this.load();
      const next = clone(this.state);
      const result = mutator(next);
      await this.#writeAtomically(next);
      this.state = next;
      this.onChange?.(clone(this.state));
      return clone(result);
    });
    this.operationQueue = operation.catch(() => {});
    return operation;
  }

  async #writeAtomically(state) {
    const directory = path.dirname(this.storePath);
    const temporaryPath = path.join(directory, `.${path.basename(this.storePath)}.${this.randomUUID()}.tmp`);
    const serialized = `${JSON.stringify(state, null, 2)}\n`;

    await this.fs.mkdir(directory, { recursive: true });
    try {
      await this.fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await this.fs.rename(temporaryPath, this.storePath);
    } catch (error) {
      await this.fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

export async function probeRemoteServer(server, {
  fetchImpl = globalThis.fetch,
  timeoutMs = REMOTE_SERVER_PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Remote server health probe is unavailable.');
  }

  const origin = normalizeRemoteServerUrl(typeof server === 'string' ? server : server?.url);
  const controller = new AbortController();
  let rejectTimeout;
  let timedOut = false;
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new Error(`Remote server health probe timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`));
  }, timeoutMs);

  try {
    let response;
    try {
      response = await Promise.race([
        fetchImpl(`${origin}/health`, {
          method: 'GET',
          credentials: 'omit',
          redirect: 'manual',
          cache: 'no-store',
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
    } catch (error) {
      if (timedOut) {
        throw new Error(`Remote server health probe timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
      }
      throw new Error(`Remote server health probe failed: ${errorMessage(error)}`);
    }

    if (!response || typeof response.status !== 'number') {
      throw new Error('Remote server health probe returned an invalid response.');
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error('Remote server health probe rejected a redirect.');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Remote server health probe failed with HTTP ${response.status}.`);
    }

    let responseBody;
    try {
      responseBody = await Promise.race([
        readCappedResponseBody(
          response,
          REMOTE_HEALTH_MAX_RESPONSE_BYTES,
          () => controller.abort(),
        ),
        timeoutPromise,
      ]);
    } catch (error) {
      if (timedOut) {
        throw new Error(`Remote server health probe timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
      }
      throw error;
    }

    let health;
    try {
      health = JSON.parse(responseBody);
    } catch {
      throw new Error('Remote server health probe returned malformed JSON.');
    }
    if (!isExpectedHealthResponse(health)) {
      throw new Error('Remote server health probe returned an unexpected server identity.');
    }
    return health;
  } finally {
    clearTimeout(timeout);
  }
}
