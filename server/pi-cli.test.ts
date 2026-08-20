import assert from 'node:assert/strict';
import test from 'node:test';

import { piCliFailureDetail } from './pi-cli.js';

// Verbatim stderr from a successful `omo --mode json --print` run (exit 0).
const SUCCESSFUL_RUN_STDERR = [
  "config-watch user config discovery requires reload { userConfigCreationDiscovery: 'reload_required' }",
  "omo-senpi ulw-loop status ignored { reason: 'non-zero-exit', code: 1 }",
  "omo-senpi start-work-continuation skipped { reason: 'not-continuable' }",
].join('\n');

test('a clean exit never reports its stderr as a failure', () => {
  assert.equal(piCliFailureDetail(0, false, SUCCESSFUL_RUN_STDERR), null);
  assert.equal(
    piCliFailureDetail(0, false, 'Warning: Detected unsettled top-level await at file:///…/cli-main.js:17'),
    null,
  );
});

test('a failing exit surfaces the buffered stderr', () => {
  assert.equal(piCliFailureDetail(1, false, '  boom\n'), 'boom');
  assert.equal(piCliFailureDetail(null, false, 'killed mid-turn'), 'killed mid-turn');
});

test('an aborted run stays silent, and a failure with no stderr adds nothing', () => {
  assert.equal(piCliFailureDetail(143, true, 'terminated'), null);
  assert.equal(piCliFailureDetail(1, false, '   \n  '), null);
});
