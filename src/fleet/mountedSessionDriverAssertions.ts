import assert from 'node:assert/strict';

import { localHostId, subscribeHostIdentity } from './hostIdentity';

const IDENTITY_TIMEOUT_MS = 2_000;

export function mountedValue<Value>(
  value: Value | null | undefined,
  message?: string,
): Value {
  assert.ok(value, message);
  return value;
}

/**
 * Resolves on the identity store's own change notification. Subscribed before
 * the app mounts, so the bootstrap fetch cannot land before we are listening.
 */
export function identityArrival(expected: string): Promise<void> {
  if (localHostId() === expected) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`local host identity ${expected} never arrived`));
    }, IDENTITY_TIMEOUT_MS);
    const unsubscribe = subscribeHostIdentity(() => {
      if (localHostId() !== expected) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}
