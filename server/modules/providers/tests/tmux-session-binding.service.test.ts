import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SESSION_BINDING_INFERRED_CODE,
  assertProvenSessionBinding,
  isInferredSessionBinding,
} from '@/modules/providers/services/tmux-session-binding.service.js';
import { AppError } from '@/shared/utils.js';

test('only an inferred binding is refused; tagged, observed, and absent grades pass', () => {
  for (const binding of ['tagged', 'observed', null] as const) {
    assert.equal(isInferredSessionBinding(binding), false, String(binding));
    assert.doesNotThrow(() => assertProvenSessionBinding({ binding }), String(binding));
  }
  assert.equal(isInferredSessionBinding('inferred'), true);
  assert.throws(
    () => assertProvenSessionBinding({ binding: 'inferred' }),
    (error: unknown) => error instanceof AppError
      && error.code === SESSION_BINDING_INFERRED_CODE
      && error.statusCode === 409
      && /terminal/u.test(error.message),
  );
});
