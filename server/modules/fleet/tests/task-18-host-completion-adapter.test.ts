import assert from 'node:assert/strict';
import test from 'node:test';

import { createFleetCompletionHubAdapter } from '@/modules/fleet/completion/hub-adapter.js';

import type { FleetCompletionReady } from '../../../../shared/fleet-completion.js';

const HOST = '11111111-1111-4111-8111-111111111111';
const EVENT = {
  version: 'completion/1', target: { kind: 'app', hostId: HOST, localId: 'session' },
  provider: 'claude', occurrenceKey: 'turn', preferenceClass: 'stop',
  hostLabel: 'peer-supplied-label', sessionLabel: 'Agent',
} as const;

function harness(state: 'online' | 'offline' | 'revoked' = 'online') {
  const recorded: FleetCompletionReady[] = [];
  const adapter = createFleetCompletionHubAdapter({
    status: () => ({ state, capabilities: ['completion.event'] }),
    hostLabel: () => 'trusted-studio',
    ownerId: () => 7,
    record: (_ownerId, event) => { recorded.push(event); return { kind: 'created', decisionIds: [1] }; },
    wake: () => undefined,
  });
  return { adapter, recorded };
}

test('Given an authenticated online peer completion, when accepted, then trusted host metadata replaces peer prose', () => {
  const subject = harness();

  const result = subject.adapter.accept(HOST, EVENT);

  assert.equal(result, 'created');
  assert.equal(subject.recorded[0]?.hostLabel, 'trusted-studio');
});

test('Given an offline or revoked peer, when completion frames arrive, then central outbox remains untouched', () => {
  for (const state of ['offline', 'revoked'] as const) {
    const subject = harness(state);
    assert.equal(subject.adapter.accept(HOST, EVENT), 'ignored');
    assert.deepEqual(subject.recorded, []);
  }
});

test('Given a completion body names another installation, when accepted, then it fails closed without retargeting', () => {
  const subject = harness();

  assert.equal(subject.adapter.accept(HOST, {
    ...EVENT,
    target: { ...EVENT.target, hostId: '22222222-2222-4222-8222-222222222222' },
  }), 'ignored');
  assert.deepEqual(subject.recorded, []);
});

test('Given a payload contains path-bearing diagnostics, when parsed, then nothing is persisted or logged', () => {
  const subject = harness();

  assert.equal(subject.adapter.accept(HOST, { ...EVENT, transcriptPath: '/home/secret/transcript.jsonl' }), 'ignored');
  assert.deepEqual(subject.recorded, []);
});
