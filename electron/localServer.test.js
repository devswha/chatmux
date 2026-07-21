import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  HEALTH_MAX_RESPONSE_BYTES,
  LocalServerController,
  isChatMuxAppServer,
  requestJson,
} from './localServer.js';

function createResponse({ statusCode = 200 } = {}) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.destroyed = false;
  response.setEncoding = () => {};
  response.destroy = () => { response.destroyed = true; };
  return response;
}

function fakeHttpGet() {
  const response = createResponse();
  const request = new EventEmitter();
  request.destroyed = false;
  request.destroy = () => { request.destroyed = true; };
  return { request, response };
}

function createChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function createController(options = {}) {
  return new LocalServerController({
    appRoot: '/app',
    settingsPath: '/settings.json',
    onChange: () => {},
    ...options,
  });
}

test('health checks require the complete ChatMux identity', async () => {
  const probe = async (body) => {
    const transport = fakeHttpGet();
    const result = isChatMuxAppServer('http://127.0.0.1:3001', {
      httpGet: (url, callback) => {
        callback(transport.response);
        queueMicrotask(() => transport.response.emit('data', JSON.stringify(body)));
        queueMicrotask(() => transport.response.emit('end'));
        return transport.request;
      },
    });
    return result;
  };

  assert.equal(await probe({
    status: 'ok',
    product: 'chatmux',
    protocolVersion: 1,
    version: '1.0.0',
  }), true);
  assert.equal(await probe({ status: 'ok' }), false);
  assert.equal(await probe({ status: 'ok', product: 'chatmux', protocolVersion: '1' }), false);
  assert.equal(await probe({ status: 'ok', product: 'chatmux', protocolVersion: 1, version: ' ' }), false);
});

test('health requests abort both streams on an absolute deadline and response cap', async () => {
  const slow = fakeHttpGet();
  let dripTimer;
  const timeout = requestJson('http://127.0.0.1:3001/health', 10, {
    httpGet: (url, callback) => {
      callback(slow.response);
      dripTimer = setInterval(() => slow.response.emit('data', '{}'), 1);
      return slow.request;
    },
  });
  const timeoutResult = await timeout;
  clearInterval(dripTimer);
  assert.deepEqual(timeoutResult, { ok: false, json: null });
  assert.equal(slow.request.destroyed, true);
  assert.equal(slow.response.destroyed, true);

  const large = fakeHttpGet();
  const capped = requestJson('http://127.0.0.1:3001/health', 100, {
    httpGet: (url, callback) => {
      callback(large.response);
      queueMicrotask(() => large.response.emit('data', 'x'.repeat(HEALTH_MAX_RESPONSE_BYTES + 1)));
      return large.request;
    },
  });
  const capResult = await capped;
  assert.deepEqual(capResult, { ok: false, json: null });
  assert.equal(large.request.destroyed, true);
  assert.equal(large.response.destroyed, true);
});

test('concurrent opens share one startup promise', async () => {
  const controller = createController();
  let starts = 0;
  let resolveStartup;
  controller.resolveLocalServerUrl = () => {
    starts += 1;
    return new Promise((resolve) => { resolveStartup = resolve; });
  };

  const first = controller.ensureLocalServer();
  const second = controller.ensureLocalServer();
  assert.equal(starts, 1);
  resolveStartup('http://localhost:3001');
  assert.equal(await first, 'http://localhost:3001');
  assert.equal(await second, 'http://localhost:3001');
});

test('stale child exit callbacks cannot clear newer process ownership', () => {
  const children = [createChild(101), createChild(102)];
  const controller = createController({ spawnImpl: () => children.shift() });
  controller.startLocalServer(3001, '/server.js');
  const first = controller.ownedServerProcess;
  controller.startLocalServer(3002, '/server.js');
  const second = controller.ownedServerProcess;

  first.exitCode = 0;
  first.emit('exit', 0, null);
  assert.equal(controller.ownedServerProcess, second);
});

test('owned server exit invalidates the cached endpoint so reopening can restart', () => {
  const child = createChild(202);
  const controller = createController({ spawnImpl: () => child });
  controller.startLocalServer(3001, '/server.js');
  controller.localServerUrl = 'http://localhost:3001';
  controller.localServerPort = 3001;

  child.exitCode = 1;
  child.emit('exit', 1, null);

  assert.equal(controller.ownedServerProcess, null);
  assert.equal(controller.localServerUrl, null);
  assert.equal(controller.localServerPort, null);
});

test('startup cannot recache an endpoint after its owned process exits', async () => {
  const child = createChild(203);
  const controller = createController();
  controller.resolveLocalServerUrl = async () => {
    controller.ownedServerProcess = child;
    controller.localServerStartOwner = child;
    child.exitCode = 1;
    controller.ownedServerProcess = null;
    return 'http://localhost:3001';
  };

  await assert.rejects(controller.ensureLocalServer(), /exited during startup/);
  assert.equal(controller.localServerUrl, null);
});

test('shutdown escalates only the owned detached process group and clears ownership after exit', async () => {
  const child = createChild(303);
  const signals = [];
  const controller = createController({
    killImpl: (pid, signal) => signals.push([pid, signal]),
    platform: 'linux',
  });
  controller.ownedServerProcess = child;
  let waits = 0;
  controller.waitForChildExit = async () => {
    waits += 1;
    if (waits === 2) {
      child.exitCode = 0;
      child.emit('exit', 0, 'SIGKILL');
      return true;
    }
    return false;
  };

  await controller.shutdownOwnedServer();
  assert.deepEqual(signals, [[-303, 'SIGTERM'], [-303, 'SIGKILL']]);
  assert.equal(controller.ownedServerProcess, null);
});

test('shutdown owns and cancels a pending startup lifecycle', async () => {
  const controller = createController();
  let resolveStartup;
  controller.resolveLocalServerUrl = () => new Promise((resolve) => {
    resolveStartup = resolve;
  });

  const startup = controller.ensureLocalServer();
  const shutdown = controller.shutdownOwnedServer();
  assert.equal(controller.hasLifecycleWork(), true);
  assert.ok(resolveStartup);
  resolveStartup('http://localhost:3001');

  await shutdown;
  await assert.rejects(startup, /cancelled/);
  assert.equal(controller.hasLifecycleWork(), false);
  await assert.rejects(controller.ensureLocalServer(), /shutting down/);
});
