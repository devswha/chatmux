import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyExternalSessions, processCliKind } from '@/modules/providers/services/external-cli-sessions/process-classification.js';
import { isGjcProcessArgs } from '@/modules/providers/services/live-sessions/process-contracts.js';

const entries = [
  '/usr/local/bin/gjc',
  '/usr/bin/bun /home/test/.bun/bin/gjc',
  '/usr/bin/node /opt/node_modules/@gajae-code/coding-agent/bin/gjc.js',
];

test('native skills probes never qualify as interactive GJC processes', () => {
  for (const entry of entries) {
    for (const command of ['skills list --json', 'skills discover --json']) {
      const args = `${entry} ${command}`;
      assert.equal(isGjcProcessArgs(args), false, args);
      assert.equal(processCliKind({ comm: entry.split(' ')[0].split('/').at(-1)!, args }), null, args);
    }
  }
});

test('interactive native and wrapped GJC processes retain their identity', () => {
  for (const entry of entries) {
    for (const suffix of ['', ' --resume session-123', ' --prompt skills']) {
      const args = entry + suffix;
      assert.equal(isGjcProcessArgs(args), true, args);
    }
  }
  assert.equal(processCliKind({ comm: 'gjc', args: '' }), 'gjc');
  assert.equal(isGjcProcessArgs('man gjc skills'), false);
});

test('a pane running a short-lived skills command remains attach-only', () => {
  const tmux = { socketPath: '/tmp/fixture.sock', sessionId: '$1', windowId: '@1', paneId: '%1' };
  const rows = classifyExternalSessions({
    panes: [{ name: 'probe', tmux, pid: 100, command: 'gjc' }],
    procs: [{ pid: 100, ppid: 1, comm: 'gjc', args: '/usr/local/bin/gjc skills list --json' }],
  });
  assert.deepEqual(rows, [{ tmuxName: 'probe', tmux, kind: 'shell' }]);
});
