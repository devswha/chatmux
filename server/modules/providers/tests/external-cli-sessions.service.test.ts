import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTERNAL_TMUX_NAME_RE,
  assignFreshCodexThreadIds,
  assignFreshIndexedProviderSessionIds,
  classifyExternalSessions,
  extractCodexResumeThreadId,
  extractExternalResumeSessionId,
  isCodexRuntimeProcess,
  normalizeExternalPaneOutput,
  parseClaudeRuntimeSession,
  parseExternalPanes,
  parseProcessStartTime,
  parsePsTree,
  selectPrimaryCodexProcessPid,
  resolveExternalCliExecutable,
  withoutNodeModulesBins,
} from '@/modules/providers/services/external-cli-sessions.service.js';

test('parseProcessStartTime reads the portable ps lstart format used on macOS', () => {
  assert.equal(
    parseProcessStartTime('Wed Jul 22 23:16:35 2026\n'),
    new Date('2026-07-22T23:16:35').getTime(),
  );
  assert.equal(parseProcessStartTime('not a process time'), null);
});

test('Codex process selection accepts the npm wrapper and native child pair', () => {
  assert.equal(isCodexRuntimeProcess({
    comm: 'node',
    args: 'node /opt/homebrew/bin/codex',
  }), true);
  assert.equal(isCodexRuntimeProcess({
    comm: '/opt/homebrew/li',
    args: '/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex',
  }), true);
  assert.equal(selectPrimaryCodexProcessPid([89009, 89076]), 89009);
  assert.equal(selectPrimaryCodexProcessPid([]), null);
});

test('external CLI resolution excludes app-local npm shims', async () => {
  const searchPath = [
    '/app/node_modules/.bin',
    '/Users/test/.local/bin',
    '/opt/homebrew/bin',
  ].join(':');
  assert.equal(
    withoutNodeModulesBins(searchPath),
    ['/Users/test/.local/bin', '/opt/homebrew/bin'].join(':'),
  );

  const checked: string[] = [];
  const resolved = await resolveExternalCliExecutable('codex', {
    path: searchPath,
    platform: 'darwin',
    isExecutable: async (candidate) => {
      checked.push(candidate);
      return candidate === '/opt/homebrew/bin/codex';
    },
  });

  assert.equal(resolved, '/opt/homebrew/bin/codex');
  assert.deepEqual(checked, [
    '/Users/test/.local/bin/codex',
    '/opt/homebrew/bin/codex',
  ]);
});
test('normalizeExternalPaneOutput removes control bytes and bounds the pane tail', () => {
  assert.equal(
    normalizeExternalPaneOutput('old\r\n\u0000Trust this folder?\u0007\n1. Yes\n', 24),
    'Trust this folder?\n1. Yes'.slice(-24),
  );
});
test('parseExternalPanes splits session_name<TAB>pane_pid<TAB>pane_current_command', () => {
  const out = parseExternalPanes('patina\t113501\tclaude\ntest\t360992\tnode\n\nbad-line\n');
  assert.deepEqual(out, [
    { name: 'patina', pid: 113501, command: 'claude' },
    { name: 'test', pid: 360992, command: 'node' },
  ]);
});

test('parseExternalPanes reads ChatMux provider/session tags for freshly spawned panes', () => {
  const out = parseExternalPanes(
    'omp-work\t710\tnode\t\t/workspace\tomp\t019f848f_ff71_77f0\n',
  );
  assert.deepEqual(out, [{
    name: 'omp-work',
    pid: 710,
    command: 'node',
    cwd: '/workspace',
    taggedKind: 'omp',
    taggedSessionId: '019f848f_ff71_77f0',
  }]);
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

test('assignFreshIndexedProviderSessionIds pairs unique disk transcripts newest-first', () => {
  const assigned = assignFreshIndexedProviderSessionIds(
    [
      { tmuxName: 'first', kind: 'omp', cwd: '/workspace', startedAtMs: 10_000 },
      { tmuxName: 'second', kind: 'omp', cwd: '/workspace', startedAtMs: 20_000 },
    ],
    [
      { id: 'session-first', kind: 'omp', cwd: '/workspace', createdAtMs: 10_500, diskDiscovered: true },
      { id: 'session-second', kind: 'omp', cwd: '/workspace', createdAtMs: 20_500, diskDiscovered: true },
    ],
    60_000,
    30_000,
  );
  assert.deepEqual([...assigned], [
    ['second', 'session-second'],
    ['first', 'session-first'],
  ]);
});

test('assignFreshIndexedProviderSessionIds rejects stale, app-created, and ambiguous candidates', () => {
  const process = [{ tmuxName: 'work', kind: 'opencode' as const, cwd: '/workspace', startedAtMs: 10_000 }];
  assert.equal(assignFreshIndexedProviderSessionIds(process, [
    { id: 'stale', kind: 'opencode', cwd: '/workspace', createdAtMs: 8_000, diskDiscovered: true },
    { id: 'app-row', kind: 'opencode', cwd: '/workspace', createdAtMs: 10_500, diskDiscovered: false },
  ], 60_000, 30_000).size, 0);

  assert.equal(assignFreshIndexedProviderSessionIds(process, [
    { id: 'candidate-a', kind: 'opencode', cwd: '/workspace', createdAtMs: 10_500, diskDiscovered: true },
    { id: 'candidate-b', kind: 'opencode', cwd: '/workspace', createdAtMs: 11_000, diskDiscovered: true },
  ], 60_000, 30_000).size, 0);
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

test('extractExternalResumeSessionId recognizes every supported native resume form', () => {
  assert.equal(
    extractExternalResumeSessionId('claude', 'claude --resume 92869134-b4df-453e-b3a6-ed1d750d69d9'),
    '92869134-b4df-453e-b3a6-ed1d750d69d9',
  );
  assert.equal(
    extractExternalResumeSessionId('codex', 'codex resume 019f7b07-3def-7501-a53f-f519c88dd722'),
    '019f7b07-3def-7501-a53f-f519c88dd722',
  );
  assert.equal(extractExternalResumeSessionId('cursor', 'cursor-agent resume bc9d14b9-2cb1-410e'), 'bc9d14b9-2cb1-410e');
  assert.equal(extractExternalResumeSessionId('opencode', 'opencode --session ses_2eaa2026198bxLxI'), 'ses_2eaa2026198bxLxI');
  assert.equal(extractExternalResumeSessionId('omp', 'omp --resume 019f848f_ff71_77f0'), '019f848f_ff71_77f0');
  assert.equal(extractExternalResumeSessionId('cursor', 'cursor-agent --version'), null);
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
    providerSessionId: '019f7b07-3def-7501-a53f-f519c88dd722',
  }]);
});

test('classifyExternalSessions recognizes Cursor, OpenCode, and Oh My Pi process trees', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'cursor-work', pid: 800, command: 'cursor-agent', cwd: '/cursor' },
      { name: 'opencode-work', pid: 900, command: 'opencode', cwd: '/opencode' },
      { name: 'omp-work', pid: 1000, command: 'omp', cwd: '/omp' },
    ],
    procs: [
      { pid: 800, ppid: 1, comm: 'zsh', args: '-zsh' },
      { pid: 801, ppid: 800, comm: 'cursor-agent', args: 'cursor-agent resume cursor-session-123' },
      { pid: 900, ppid: 1, comm: 'zsh', args: '-zsh' },
      { pid: 901, ppid: 900, comm: 'node', args: 'node /usr/bin/opencode --session ses_open_123' },
      { pid: 1000, ppid: 1, comm: 'zsh', args: '-zsh' },
      { pid: 1001, ppid: 1000, comm: 'node', args: 'node /usr/bin/omp --resume omp_session_123' },
    ],
  });
  assert.deepEqual(result, [
    { tmuxName: 'cursor-work', kind: 'cursor', providerSessionId: 'cursor-session-123', cwd: '/cursor' },
    { tmuxName: 'omp-work', kind: 'omp', providerSessionId: 'omp_session_123', cwd: '/omp' },
    { tmuxName: 'opencode-work', kind: 'opencode', providerSessionId: 'ses_open_123', cwd: '/opencode' },
  ]);
});

test('classifyExternalSessions trusts a valid ChatMux spawn tag through a node launcher', () => {
  const result = classifyExternalSessions({
    panes: [{
      name: 'omp-fresh',
      pid: 1100,
      command: 'node',
      taggedKind: 'omp',
      taggedSessionId: 'omp_tagged_123',
      cwd: '/workspace',
    }],
    procs: [{ pid: 1100, ppid: 1, comm: 'node', args: 'node wrapper.js' }],
  });
  assert.deepEqual(result, [{
    tmuxName: 'omp-fresh',
    kind: 'omp',
    providerSessionId: 'omp_tagged_123',
    cwd: '/workspace',
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
    providerSessionId: '019f848f-ff71-77f0-8623-08625d24f037',
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
  assert.deepEqual(result, []);
});

test('classifyExternalSessions drops background Oh My Pi workers inside an app pane', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'chatmux', pid: 1200, command: 'bun', cwd: '/workspace/chatmux' }],
    procs: [
      { pid: 1200, ppid: 1, comm: 'bun', args: 'bun server/index.ts' },
      { pid: 1201, ppid: 1200, comm: 'node', args: 'node /usr/bin/omp --resume background_omp_123' },
    ],
  });
  assert.deepEqual(result, []);
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
