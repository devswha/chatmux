import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCodexApprovalScreen,
  parseOmpApprovalScreen,
} from '@/modules/providers/services/tmux-approval.service.js';

test('Codex approval parser requires an active numbered approve/reject selector', () => {
  const prompt = parseCodexApprovalScreen(`
Would you like to run the following command?

$ curl -I https://example.com

› 1. Yes, proceed
  2. Yes, and don't ask again for commands that start with curl
  3. No, and tell Codex what to do differently
`);
  assert.equal(prompt?.canRemember, true);
  assert.equal(prompt?.selectedIndex, 0);
  assert.equal(prompt?.rememberIndex, 1);
  assert.equal(prompt?.rejectIndex, 2);
  assert.equal(parseCodexApprovalScreen('You approved the command.'), null);
});

test('OMP approval parser requires both active Approve and Deny rows', () => {
  const prompt = parseOmpApprovalScreen(`
Allow tool: bash
Command: git status

› Approve
  Deny
`);
  assert.equal(prompt?.selectedIndex, 0);
  assert.equal(prompt?.approveIndex, 0);
  assert.equal(prompt?.rejectIndex, 1);
  assert.equal(parseOmpApprovalScreen('Allow tool: bash\nThe user said approve.'), null);
});
