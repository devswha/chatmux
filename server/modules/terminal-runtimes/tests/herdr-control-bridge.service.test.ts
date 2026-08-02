import assert from 'node:assert/strict';
import test from 'node:test';

import type { PublicTerminalTarget } from '../../../../shared/terminal-runtime.js';
import { HerdrAdmissionService, HerdrControlBridgeService } from '../herdr-control-bridge.service.js';

const target: Extract<PublicTerminalTarget, { runtime: 'herdr' }> = {
  runtime: 'herdr', sourceId: 'hsrc_jtP2rWhblZ6tcCJRjhr3bA', targetId: 'htgt_jtP2rWhblZ6tcCJRjhr3bA', targetClass: 'attach-only', admissionCapability: 'capability-123456',
};

function registry() {
  let valid = true;
  let busy = false;
  let releases = 0;
  return {
    service: {
      read: async () => valid ? { ansi: 'visible', truncated: false } : null,
      verify: async () => valid,
      targetProfile: async () => ({ targetClass: 'attach-only' as const, process: null }),
      controllerArgv: async () => busy ? null : (busy = true, { command: '/opt/herdr/herdr', args: ['terminal', 'session', 'control'], release: () => { busy = false; releases += 1; } }),
    },
    invalidate: () => { valid = false; },
    releases: () => releases,
  };
}

test('Herdr admission is principal-bound, single-use, and expires after 60 seconds', async () => {
  let now = 0;
  const admissions = new HerdrAdmissionService(() => now);
  const fake = registry();
  const bridge = new HerdrControlBridgeService(fake.service as never, admissions);
  assert.equal(admissions.grant(target.admissionCapability, 'alice', target), true);
  assert.equal(await bridge.acquireController({ target, principal: 'bob', admissionCapability: target.admissionCapability, cols: 80, rows: 24 }), null);
  assert.equal(admissions.grant(target.admissionCapability, 'alice', target), true);
  const lease = await bridge.acquireController({ target, principal: 'alice', admissionCapability: target.admissionCapability, cols: 80, rows: 24 });
  assert.ok(lease);
  assert.equal(await bridge.acquireController({ target, principal: 'alice', admissionCapability: target.admissionCapability, cols: 80, rows: 24 }), null);
  now = 60_001;
  assert.equal(await lease.assertFreshIdentity(), true);
  lease.release();
  assert.equal(admissions.grant(target.admissionCapability, 'alice', target), true);
  now = 120_002;
  assert.equal(await bridge.acquireController({ target, principal: 'alice', admissionCapability: target.admissionCapability, cols: 80, rows: 24 }), null);
});

test('Herdr controller does not take over a busy lease and continuously revalidates identity', async () => {
  const admissions = new HerdrAdmissionService();
  const fake = registry();
  const bridge = new HerdrControlBridgeService(fake.service as never, admissions);
  admissions.grant(target.admissionCapability, 'alice', target);
  const lease = await bridge.acquireController({ target, principal: 'alice', admissionCapability: target.admissionCapability, cols: 80, rows: 24 });
  assert.ok(lease);
  admissions.grant(target.admissionCapability, 'alice', target);
  assert.equal(await bridge.acquireController({ target, principal: 'alice', admissionCapability: target.admissionCapability, cols: 80, rows: 24 }), null);
  fake.invalidate();
  assert.equal(await lease.assertFreshIdentity(), false);
  lease.release();
  assert.equal(fake.releases(), 1);
});

test('Herdr observation never acquires a controller lease', async () => {
  const fake = registry();
  const bridge = new HerdrControlBridgeService(fake.service as never, new HerdrAdmissionService());
  const frames: unknown[] = [];
  const observation = await bridge.observe({ target, principal: 'alice', emitFrame: (frame) => frames.push(frame) });
  assert.ok(observation);
  assert.equal(frames.length, 1);
  observation.release();
});
test('Herdr denies client target-class confusion before consuming admission', async () => {
  const fake = registry();
  const admissions = new HerdrAdmissionService();
  const bridge = new HerdrControlBridgeService(fake.service as never, admissions);
  const confused = { ...target, targetClass: 'local-agent' as const, process: { pid: 9, startedAtMs: 1 } };
  assert.equal(await bridge.acquireController({ target: confused, principal: 'alice', cols: 80, rows: 24 }), null);
  assert.equal(admissions.grant(target.admissionCapability, 'alice', target), true);
});

test('Herdr releaseAll immediately revokes active resources and releases each lease once', async () => {
  const fake = registry();
  const admissions = new HerdrAdmissionService();
  const bridge = new HerdrControlBridgeService(fake.service as never, admissions);
  admissions.grant(target.admissionCapability, 'alice', target);
  const lease = await bridge.acquireController({ target, principal: 'alice', admissionCapability: target.admissionCapability, cols: 80, rows: 24 });
  assert.ok(lease);
  let revoked = 0;
  lease.onRevoke(() => { revoked += 1; });
  await bridge.releaseAll();
  await bridge.releaseAll();
  assert.equal(revoked, 1);
  assert.equal(fake.releases(), 1);
  assert.equal(await lease.assertFreshIdentity(), false);
});
test('Herdr releaseAll awaits revocation teardown while synchronously denying new writes', async () => {
  const fake = registry();
  const admissions = new HerdrAdmissionService();
  const bridge = new HerdrControlBridgeService(fake.service as never, admissions);
  admissions.grant(target.admissionCapability, 'alice', target);
  const lease = await bridge.acquireController({ target, principal: 'alice', admissionCapability: target.admissionCapability, cols: 80, rows: 24 });
  assert.ok(lease);
  let finishTeardown: (() => void) | null = null;
  lease.onRevoke(() => new Promise<void>((resolve) => { finishTeardown = resolve; }));
  let finished = false;
  const releasing = bridge.releaseAll().then(() => { finished = true; });
  assert.equal(lease.assertWriteAllowed(), false);
  await Promise.resolve();
  assert.equal(finished, false);
  (finishTeardown as (() => void) | null)?.();
  await releasing;
  assert.equal(finished, true);
  assert.equal(fake.releases(), 1);
});
test('Herdr dispose awaits an already-started controller revocation', async () => {
  const fake = registry();
  const admissions = new HerdrAdmissionService();
  const bridge = new HerdrControlBridgeService(fake.service as never, admissions);
  admissions.grant(target.admissionCapability, 'alice', target);
  const lease = await bridge.acquireController({ target, principal: 'alice', admissionCapability: target.admissionCapability, cols: 80, rows: 24 });
  assert.ok(lease);
  let finishRevocation: (() => void) | null = null;
  lease.onRevoke(() => new Promise<void>((resolve) => { finishRevocation = resolve; }));
  void lease.release();
  let disposed = false;
  const disposal = bridge.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  (finishRevocation as (() => void) | null)?.();
  await disposal;
  assert.equal(disposed, true);
  assert.equal(fake.releases(), 1);
});
