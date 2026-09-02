import assert from 'node:assert/strict';
import test from 'node:test';

import { createLoginLimiter, normalizePeerAddress } from './login-limiter.js';

test('the login limiter locks a peer and username after the configured failures, then releases after the window', () => {
  let nowMs = 1_000;
  const limiter = createLoginLimiter({ limit: 3, usernameLimit: 10, windowMs: 60_000, now: () => nowMs });
  assert.equal(limiter.retryAfterSeconds('10.0.0.5', 'owner'), 0);
  for (let attempt = 0; attempt < 3; attempt += 1) limiter.recordFailure('10.0.0.5', 'owner');
  assert.equal(limiter.retryAfterSeconds('10.0.0.5', 'owner'), 60);
  assert.equal(limiter.retryAfterSeconds('10.0.0.6', 'owner'), 0, 'another peer is not locked by the first');
  nowMs += 60_000;
  assert.equal(limiter.retryAfterSeconds('10.0.0.5', 'owner'), 0, 'the window expires');
  limiter.recordFailure('10.0.0.5', 'owner');
  limiter.clear('10.0.0.5', 'owner');
  assert.equal(limiter.retryAfterSeconds('10.0.0.5', 'owner'), 0, 'a successful login clears the counters');
});

test('rotating the peer address cannot exceed the per-username backstop', () => {
  const limiter = createLoginLimiter({ limit: 3, usernameLimit: 5, windowMs: 60_000, now: () => 1_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) limiter.recordFailure(`10.0.0.${attempt}`, 'owner');
  assert.ok(limiter.retryAfterSeconds('10.0.0.99', 'owner') > 0, 'a fresh address is still refused for this username');
  assert.equal(limiter.retryAfterSeconds('10.0.0.99', 'someone-else'), 0, 'other usernames are unaffected');
});

test('the limiter bounds its memory and normalizes IPv4-mapped peers', () => {
  let nowMs = 1_000;
  const limiter = createLoginLimiter({ maxEntries: 50, windowMs: 60_000, now: () => nowMs });
  for (let attempt = 0; attempt < 500; attempt += 1) limiter.recordFailure(`10.1.${attempt}.1`, `user-${attempt}`);
  assert.ok(limiter.size() <= 50, `size ${limiter.size()} stays under the cap`);
  nowMs += 60_000;
  limiter.recordFailure('10.9.9.9', 'late');
  assert.ok(limiter.size() <= 50);
  assert.equal(normalizePeerAddress('::ffff:192.168.1.10'), '192.168.1.10');
  assert.equal(normalizePeerAddress(undefined), 'unknown-peer');
  limiter.recordFailure('::ffff:192.168.1.10', 'owner');
  limiter.recordFailure('192.168.1.10', 'owner');
  limiter.recordFailure('192.168.1.10', 'owner');
  const strict = createLoginLimiter({ limit: 3, windowMs: 60_000, now: () => nowMs });
  strict.recordFailure('::ffff:192.168.1.10', 'owner'); strict.recordFailure('192.168.1.10', 'owner'); strict.recordFailure('192.168.1.10', 'owner');
  assert.ok(strict.retryAfterSeconds('192.168.1.10', 'owner') > 0, 'mapped and plain forms share one bucket');
});
