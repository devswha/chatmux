import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  createFleetPeerLifecycle,
  type FleetPeerRuntime,
} from '../peer/lifecycle.js';

class UpgradeServer extends EventEmitter {}

test('Given fleet is disabled, when lifecycle starts, then no fleet upgrade listener is registered', async () => {
  const server = new UpgradeServer();
  const lifecycle = createFleetPeerLifecycle({ enabled: false, server });

  await lifecycle.start();

  assert.equal(server.listenerCount('upgrade'), 0);
  assert.deepEqual(lifecycle.capabilities, []);
});

test('Given fleet is enabled, when lifecycle starts and stops, then routing and dependencies use safe ordering', async () => {
  const server = new UpgradeServer();
  const events: string[] = [];
  const runtime: FleetPeerRuntime = {
    capabilities: ['catalog.read'],
    start: () => { events.push('fleet:start'); },
    stop: async () => { events.push('fleet:stop'); },
  };
  const lifecycle = createFleetPeerLifecycle({
    enabled: true,
    server,
    createRuntime: async () => runtime,
  });

  await lifecycle.start();
  await lifecycle.stop();
  events.push('dependency:stop');

  assert.equal(server.listenerCount('upgrade'), 0);
  assert.deepEqual(lifecycle.capabilities, ['catalog.read']);
  assert.deepEqual(events, ['fleet:start', 'fleet:stop', 'dependency:stop']);
});

test('Given startup is still resolving, when shutdown begins, then the runtime is stopped without being started', async () => {
  const server = new UpgradeServer();
  const pending = Promise.withResolvers<FleetPeerRuntime>();
  const events: string[] = [];
  const lifecycle = createFleetPeerLifecycle({
    enabled: true,
    server,
    createRuntime: () => pending.promise,
  });

  const starting = lifecycle.start();
  const stopping = lifecycle.stop();
  pending.resolve({
    capabilities: [],
    start: () => { events.push('start'); },
    stop: async () => { events.push('stop'); },
  });
  await Promise.all([starting, stopping]);

  assert.deepEqual(events, ['stop']);
});

test('Given runtime creation fails, when startup cleanup runs, then cleanup completes without masking the startup error', async () => {
  const server = new UpgradeServer();
  const startupError = new FleetPeerRuntimeStartupError();
  const lifecycle = createFleetPeerLifecycle({
    enabled: true,
    server,
    createRuntime: async () => { throw startupError; },
  });

  await assert.rejects(lifecycle.start(), startupError);
  await lifecycle.stop();

  assert.equal(server.listenerCount('upgrade'), 0);
});

class FleetPeerRuntimeStartupError extends Error {}
