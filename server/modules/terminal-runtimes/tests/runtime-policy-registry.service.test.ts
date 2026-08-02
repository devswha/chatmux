import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeCapabilities } from '../../../../shared/terminal-runtime.js';
import { RuntimeOperationPolicyService } from '../runtime-operation-policy.service.js';
import { RuntimeRegistryService, type RuntimeAdapter } from '../runtime-registry.service.js';

const sourceId = 'hsrc_jtP2rWhblZ6tcCJRjhr3bA' as const;
const all: RuntimeCapabilities = { discovery: true, output: true, actions: true, attach: true, create: false };

test('configured policy starts fail-closed until a valid policy is loaded', () => {
  const policy = new RuntimeOperationPolicyService(all, [sourceId], '/unavailable/herdr-policy.json');
  assert.deepEqual(policy.capabilities(sourceId), { discovery: false, output: false, actions: false, attach: false, create: false });
});

test('registry separates Herdr read authorization from action authorization', async () => {
  const calls: string[] = [];
  const adapter: RuntimeAdapter = {
    runtime: 'herdr',
    sourceDescriptors: async () => [],
    capabilities: () => ({ discovery: true, output: true, actions: false, attach: true, create: false }),
    discover: async () => [],
    read: async () => { calls.push('read'); return { ansi: 'safe', truncated: false }; },
    send: async () => { calls.push('send'); return true; },
    controllerArgv: async () => { calls.push('attach'); return { command: 'herdr', args: [], release: () => undefined }; },
  };
  const registry = new RuntimeRegistryService();
  registry.register(adapter);
  const ref = { runtime: 'herdr' as const, sourceId, targetId: 'htgt_jtP2rWhblZ6tcCJRjhr3bA' };

  assert.deepEqual(await registry.read(ref), { ansi: 'safe', truncated: false });
  assert.equal(await registry.send(ref, 'do not send'), false);
  assert.ok(await registry.controllerArgv(ref, 80, 24));
  assert.deepEqual(calls, ['read', 'attach']);
});

test('registry preserves adapter-provided per-source discovery failures', async () => {
  const secondSource = 'hsrc_abcdefghijklmnopqrstuv';
  const registry = new RuntimeRegistryService();
  registry.register({
    runtime: 'herdr',
    sourceDescriptors: async () => [
      { runtime: 'herdr', sourceId, readiness: 'ready' },
      { runtime: 'herdr', sourceId: secondSource, readiness: 'offline' },
    ],
    discover: async () => {
      throw new Error('flattened discovery must not run');
    },
    discoverOutcomes: async () => [
      {
        runtime: 'herdr',
        sourceId,
        ok: true,
        terminals: [{ runtime: 'herdr', sourceId, targetId: 'htgt_jtP2rWhblZ6tcCJRjhr3bA', targetClass: 'attach-only', admissionCapability: 'capability-123456' }],
      },
      { runtime: 'herdr', sourceId: secondSource, ok: false, terminals: [] },
    ],
  });
  const outcomes = await registry.discoverOutcomes();
  assert.deepEqual(outcomes.map(({ sourceId: id, ok, terminals }) => ({ id, ok, count: terminals.length })), [
    { id: sourceId, ok: true, count: 1 },
    { id: secondSource, ok: false, count: 0 },
  ]);
});
test('registry uses one adapter discovery scan without repeating descriptor or discovery calls', async () => {
  let scans = 0;
  let legacyCalls = 0;
  const registry = new RuntimeRegistryService();
  registry.register({
    runtime: 'herdr',
    sourceDescriptors: async () => { legacyCalls += 1; return []; },
    discover: async () => { legacyCalls += 1; return []; },
    scanDiscovery: async () => {
      scans += 1;
      return {
        sources: [{ runtime: 'herdr', sourceId, readiness: 'ready' }],
        outcomes: [{ runtime: 'herdr', sourceId, ok: true, terminals: [] }],
      };
    },
  });
  const scan = await registry.scanDiscovery();
  assert.equal(scans, 1);
  assert.equal(legacyCalls, 0);
  assert.equal(scan.sources.length, 1);
  assert.equal(scan.outcomes.length, 1);
});
