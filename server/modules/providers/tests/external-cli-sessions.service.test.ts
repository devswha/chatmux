import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTERNAL_TMUX_NAME_RE,
  assignFreshCodexThreadIds,
  classifyExternalSessions,
  extractCodexResumeThreadId,
  parseClaudeRuntimeSession,
  parseExternalPanes,
  parsePsTree,
} from '@/modules/providers/services/external-cli-sessions.service.js';

test('parseExternalPanes splits session_name<TAB>pane_pid<TAB>pane_current_command', () => {
  const out = parseExternalPanes('patina\t113501\tclaude\ntest\t360992\tnode\n\nbad-line\n');
  assert.deepEqual(out, [
    { name: 'patina', pid: 113501, command: 'claude' },
    { name: 'test', pid: 360992, command: 'node' },
  ]);
});

test('parseExternalPanes reads transcript id and cwd from the extended tmux format', () => {
  const out = parseExternalPanes(
    'native\t700\tnode\t\t/workspace\nmobile\t701\tnode\t019f848f-ff71-77f0-8623-08625d24f037\t/workspace/mobile\n',
  );
  assert.deepEqual(out, [
    { name: 'native', pid: 700, command: 'node', cwd: '/workspace' },
    {
      name: 'mobile',
      pid: 701,
      command: 'node',
      codexThreadId: '019f848f-ff71-77f0-8623-08625d24f037',
      cwd: '/workspace/mobile',
    },
  ]);
});

test('assignFreshCodexThreadIds pairs fresh threads one-to-one by cwd and start time', () => {
  const assigned = assignFreshCodexThreadIds(
    [
      { tmuxName: 'first', cwd: '/workspace', startedAtMs: 1_000 },
      { tmuxName: 'second', cwd: '/workspace', startedAtMs: 2_000 },
      { tmuxName: 'other', cwd: '/other', startedAtMs: 1_500 },
    ],
    [
      { id: 'thread-first', cwd: '/workspace', createdAtMs: 1_100 },
      { id: 'thread-other', cwd: '/other', createdAtMs: 1_600 },
      { id: 'thread-second', cwd: '/workspace', createdAtMs: 2_100 },
      { id: 'unrelated', cwd: '/missing', createdAtMs: 2_200 },
    ],
  );
  assert.deepEqual([...assigned], [
    ['first', 'thread-first'],
    ['other', 'thread-other'],
    ['second', 'thread-second'],
  ]);
});

test('assignFreshCodexThreadIds ignores threads outside the launch window', () => {
  const assigned = assignFreshCodexThreadIds(
    [{ tmuxName: 'late', cwd: '/workspace', startedAtMs: 1_000 }],
    [{ id: 'too-late', cwd: '/workspace', createdAtMs: 2_001 }],
    1_000,
  );
  assert.equal(assigned.size, 0);
});

test('parsePsTree parses pid,ppid,comm rows and tolerates the header', () => {
  const out = parsePsTree('    PID    PPID COMM\n      1       0 systemd\n 360992    1278 node\n1731394 1731329 codex\n');
  assert.deepEqual(out, [
    { pid: 1, ppid: 0, comm: 'systemd' },
    { pid: 360992, ppid: 1278, comm: 'node' },
    { pid: 1731394, ppid: 1731329, comm: 'codex' },
  ]);
});

test('parsePsTree optionally preserves argv from ps args', () => {
  const out = parsePsTree(' 700 100 bun bun /home/user/.bun/bin/gjc\n');
  assert.deepEqual(out, [
    { pid: 700, ppid: 100, comm: 'bun', args: 'bun /home/user/.bun/bin/gjc' },
  ]);
});

test('extractCodexResumeThreadId reads native `codex resume <uuid>` argv', () => {
  assert.equal(
    extractCodexResumeThreadId('node /home/user/bin/codex resume 019f7b07-3def-7501-a53f-f519c88dd722'),
    '019f7b07-3def-7501-a53f-f519c88dd722',
  );
  assert.equal(extractCodexResumeThreadId('codex --remote ws://127.0.0.1:4518'), null);
});

test('parseClaudeRuntimeSession accepts the PID-bound native Claude receipt', () => {
  const sessionId = '92869134-b4df-453e-b3a6-ed1d750d69d9';
  assert.deepEqual(
    parseClaudeRuntimeSession({
      pid: 1443735,
      sessionId,
      cwd: '/workspace/project',
      kind: 'interactive',
    }, 1443735),
    { sessionId, cwd: '/workspace/project' },
  );
  assert.equal(
    parseClaudeRuntimeSession({ pid: 1443736, sessionId, cwd: '/workspace/project' }, 1443735),
    null,
  );
  assert.equal(
    parseClaudeRuntimeSession({ pid: 1443735, sessionId: '../../bad', cwd: '/workspace/project' }, 1443735),
    null,
  );
});

test('classifyExternalSessions auto-links a native Codex resume process to its transcript', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'native', pid: 700, command: 'node' }],
    procs: [
      { pid: 700, ppid: 1, comm: 'zsh', args: '-zsh' },
      { pid: 701, ppid: 700, comm: 'node', args: 'node /home/user/bin/codex resume 019f7b07-3def-7501-a53f-f519c88dd722' },
      { pid: 702, ppid: 701, comm: 'codex', args: '/vendor/codex resume 019f7b07-3def-7501-a53f-f519c88dd722' },
    ],
  });
  assert.deepEqual(result, [{
    tmuxName: 'native',
    kind: 'codex',
    codexThreadId: '019f7b07-3def-7501-a53f-f519c88dd722',
  }]);
});

test('classifyExternalSessions: claude pane by pane_current_command (실측 shape)', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'patina', pid: 113501, command: 'claude' }],
    procs: [{ pid: 113501, ppid: 1, comm: 'claude' }],
  });
  assert.deepEqual(result, [{ tmuxName: 'patina', kind: 'claude' }]);
});

test('classifyExternalSessions: codex surfaces as node pane + codex descendant (실측 shape)', () => {
  // tmux pane shows 'node' (codex is a node wrapper); the vendor binary comm is 'codex'.
  const result = classifyExternalSessions({
    panes: [{ name: 'test', pid: 360992, command: 'node' }],
    procs: [
      { pid: 360992, ppid: 1278, comm: 'node' },
      { pid: 1731329, ppid: 360992, comm: 'node' },
      { pid: 1731394, ppid: 1731329, comm: 'codex' },
    ],
  });
  assert.deepEqual(result, [{ tmuxName: 'test', kind: 'codex' }]);
});

test('classifyExternalSessions: tagged Codex pane exposes its transcript thread id', () => {
  const result = classifyExternalSessions({
    panes: [{
      name: 'mobile',
      pid: 700,
      command: 'node',
      codexThreadId: '019f848f-ff71-77f0-8623-08625d24f037',
    }],
    procs: [
      { pid: 700, ppid: 1, comm: 'node' },
      { pid: 701, ppid: 700, comm: 'codex' },
    ],
  });
  assert.deepEqual(result, [{
    tmuxName: 'mobile',
    kind: 'codex',
    codexThreadId: '019f848f-ff71-77f0-8623-08625d24f037',
  }]);
});

test('classifyExternalSessions: gjc anywhere in the session excludes it (live lane contract)', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'flask', pid: 357760, command: 'gjc' },
      // Same session, second pane running claude: still excluded — gjc owns the session.
      { name: 'flask', pid: 357761, command: 'claude' },
      { name: 'stock', pid: 61685, command: 'claude' },
    ],
    procs: [
      { pid: 357760, ppid: 1, comm: 'gjc' },
      { pid: 357761, ppid: 1, comm: 'claude' },
      { pid: 61685, ppid: 1, comm: 'claude' },
    ],
  });
  assert.deepEqual(result, [{ tmuxName: 'stock', kind: 'claude' }]);
});

test('classifyExternalSessions: ssh tunnels surface as attach-only ssh rows (실측: company)', () => {
  // The far-side CLI is locally unprovable — the pane still deserves an
  // attach-only row instead of vanishing (하코 관찰: company 세션 안 보임).
  const result = classifyExternalSessions({
    panes: [{ name: 'company', pid: 3318360, command: 'ssh' }],
    procs: [{ pid: 3318360, ppid: 1, comm: 'ssh' }],
  });
  assert.deepEqual(result, [{ tmuxName: 'company', kind: 'ssh' }]);
});

test('classifyExternalSessions: plain shell panes (zsh) are still dropped', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'scratch', pid: 400, command: 'zsh' }],
    procs: [{ pid: 400, ppid: 1, comm: 'zsh' }],
  });
  assert.deepEqual(result, []);
});

test('classifyExternalSessions: local claude wins over an ssh pane in the same session', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'mixed', pid: 500, command: 'claude' },
      { name: 'mixed', pid: 600, command: 'ssh' },
    ],
    procs: [
      { pid: 500, ppid: 1, comm: 'claude' },
      { pid: 600, ppid: 1, comm: 'ssh' },
    ],
  });
  assert.deepEqual(result, [{ tmuxName: 'mixed', kind: 'claude' }]);
});

test('classifyExternalSessions: multi-pane session unions comms and yields ONE row', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'work', pid: 100, command: 'zsh' },
      { name: 'work', pid: 200, command: 'claude' },
    ],
    procs: [
      { pid: 100, ppid: 1, comm: 'zsh' },
      { pid: 200, ppid: 1, comm: 'claude' },
    ],
  });
  assert.deepEqual(result, [{ tmuxName: 'work', kind: 'claude' }]);
});

test('classifyExternalSessions: names unsafe to shell-embed are dropped', () => {
  const result = classifyExternalSessions({
    panes: [{ name: "evil;$(rm -rf ~)'", pid: 300, command: 'claude' }],
    procs: [{ pid: 300, ppid: 1, comm: 'claude' }],
  });
  assert.deepEqual(result, []);
  assert.equal(EXTERNAL_TMUX_NAME_RE.test("evil;$(rm -rf ~)'"), false);
});

test('classifyExternalSessions: descendant BFS is cycle-guarded', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'loop', pid: 1, command: 'zsh' }],
    procs: [
      { pid: 1, ppid: 2, comm: 'zsh' },
      { pid: 2, ppid: 1, comm: 'claude' }, // artificial cycle
    ],
  });
  assert.deepEqual(result, [{ tmuxName: 'loop', kind: 'claude' }]);
});

test('classifyExternalSessions: sorted by tmux name for stable rendering', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'zeta', pid: 1, command: 'claude' },
      { name: 'alpha', pid: 2, command: 'claude' },
    ],
    procs: [
      { pid: 1, ppid: 0, comm: 'claude' },
      { pid: 2, ppid: 0, comm: 'claude' },
    ],
  });
  assert.deepEqual(result.map((s) => s.tmuxName), ['alpha', 'zeta']);
});
