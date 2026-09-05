import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SESSION_BINDING_INFERRED_CODE,
  assertProvenSessionBinding,
  isProvenSessionBinding,
} from '@/modules/providers/services/tmux-session-binding.service.js';
import { AppError } from '@/shared/utils.js';

test('session writes accept only tagged and observed evidence', () => {
  for (const binding of ['tagged', 'observed'] as const) {
    assert.equal(isProvenSessionBinding(binding), true);
    assert.doesNotThrow(() => assertProvenSessionBinding({ binding }), String(binding));
  }
});

test('unknown, absent, inferred and malformed binding evidence fails closed', () => {
  for (const binding of [null, undefined, 'inferred', 'unknown', '', 'TAGGED', 'observed ', true, 1, {}, ['observed']]) {
    assert.equal(isProvenSessionBinding(binding), false);
    assert.throws(
      () => assertProvenSessionBinding({ binding }),
      (error: unknown) => error instanceof AppError
        && error.code === SESSION_BINDING_INFERRED_CODE
        && error.statusCode === 409
        && /terminal/u.test(error.message),
    );
  }
  assert.throws(() => assertProvenSessionBinding({}), { code: SESSION_BINDING_INFERRED_CODE });
});
