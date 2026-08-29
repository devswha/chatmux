import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { FleetChallengeReplayGuard } from '../protocol/auth.js';
import { decodeFleetFrame, FLEET_MAX_FRAME_BYTES } from '../protocol/codec.js';
import { validateFleetDialTarget, validateFleetUpgrade } from '../protocol/transport-policy.js';

const HOST_ID = '123e4567-e89b-42d3-a456-426614174000';

test('Given fleet dial policy, when transport mode and URL disagree, then admission fails closed', () => {
  const rejected = [
    validateFleetDialTarget('ws://192.0.2.1/fleet-ws', 'ssh-loopback'),
    validateFleetDialTarget('ws://127.0.0.1/fleet-ws', 'direct-wss'),
    validateFleetDialTarget('wss://peer.example/fleet-ws', 'ssh-loopback'),
    validateFleetDialTarget('ws://127.0.0.1/other', 'ssh-loopback'),
    validateFleetDialTarget('ws://127.1/fleet-ws', 'ssh-loopback'),
    validateFleetDialTarget('ws://2130706433/fleet-ws', 'ssh-loopback'),
    validateFleetDialTarget('ws://0x7f000001/fleet-ws', 'ssh-loopback'),
    validateFleetDialTarget('ws://127.0.0.1./fleet-ws', 'ssh-loopback'),
    validateFleetDialTarget('ws://[0:0:0:0:0:0:0:1]/fleet-ws', 'ssh-loopback'),
    validateFleetDialTarget('ws://user@127.0.0.1/fleet-ws', 'ssh-loopback'),
  ];

  assert.ok(rejected.every((result) => !result.ok && result.reason === 'transport_target_mismatch'));
  assert.deepEqual(validateFleetDialTarget('wss://peer.example/fleet-ws', 'direct-wss'), { ok: true });
  assert.deepEqual(validateFleetDialTarget('ws://127.0.0.1/fleet-ws', 'ssh-loopback'), { ok: true });
  assert.deepEqual(validateFleetDialTarget('ws://[::1]/fleet-ws', 'ssh-loopback'), { ok: true });
});

test('Given a raw direct URL, when its WSS scheme has uppercase characters, then admission fails before normalization', () => {
  for (const target of ['WSS://peer.example/fleet-ws', 'WsS://peer.example/fleet-ws', 'wSs://peer.example/fleet-ws']) {
    assert.deepEqual(validateFleetDialTarget(target, 'direct-wss'), {
      ok: false,
      reason: 'transport_target_mismatch',
    });
  }
  assert.deepEqual(validateFleetDialTarget('wss://peer.example:8443/fleet-ws', 'direct-wss'), { ok: true });
});

test('Given a machine upgrade, when browser metadata or credentials are present, then it is rejected before dispatch', () => {
  let dispatcherCount = 0;
  const attempts = [
    { url: '/fleet-ws', headers: { origin: 'https://chat.example' } },
    { url: '/fleet-ws?token=secret', headers: {} },
    { url: '/fleet-ws', headers: { cookie: 'chatmux=secret' } },
    { url: '/fleet-ws', headers: { authorization: 'Bearer jwt-value' } },
    { url: '/ws', headers: {} },
  ];

  for (const attempt of attempts) {
    const result = validateFleetUpgrade(attempt);
    if (result.ok) dispatcherCount += 1;
    assert.equal(result.ok, false);
  }
  assert.deepEqual(validateFleetUpgrade({ url: '/fleet-ws', headers: {} }), { ok: true });
  assert.equal(dispatcherCount, 0);
});

test('Given malformed or oversized fleet frames, when decoding occurs, then schema dispatch is impossible', () => {
  const malformed = [
    Buffer.from('{'),
    Buffer.from(JSON.stringify({ kind: 'heartbeat', connectionGeneration: 1, sentAtMs: 1, extra: true })),
    Buffer.from(JSON.stringify({
      kind: 'auth.hello', role: 'hub', installationId: HOST_ID, processEpoch: 'epoch',
      connectionId: randomUUID(), nonce: 'A'.repeat(43), protocolVersions: ['fleet/1'],
      capabilities: ['arbitrary.shell'], transportMode: 'direct-wss',
    })),
  ];

  for (const frame of malformed) assert.throws(() => decodeFleetFrame(frame));
  assert.throws(() => decodeFleetFrame(Buffer.alloc(FLEET_MAX_FRAME_BYTES + 1)), /frame exceeds size limit/);
});

test('Given one connection identity, when its signed challenge is reused, then replay is rejected', () => {
  const guard = new FleetChallengeReplayGuard();
  const challenge = `${HOST_ID}:${randomUUID()}`;

  assert.equal(guard.reserve(challenge), true);
  assert.equal(guard.reserve(challenge), false);
});
