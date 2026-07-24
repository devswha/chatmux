import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignFreshCodexThreadIds,
  assignFreshIndexedProviderSessionIds,
  assignUniqueIndexedProviderSessionIds,
  classifyExternalSessions,
  extractCodexResumeThreadId,
  extractExternalResumeSessionId,
  extractContainedTranscriptSessionId,
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

const TMUX_SOCKET_PATH = '/tmp/tmux-1000/default';

function tmux(sessionId: string, windowId: string, paneId: string) {
  return { socketPath: TMUX_SOCKET_PATH, sessionId, windowId, paneId };
}

function tmuxTargetKey(identity: { socketPath: string; sessionId: string; windowId: string; paneId: string }) {
  return `${identity.socketPath}\0${identity.sessionId}\0${identity.windowId}\0${identity.paneId}`;
}

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

test('normalizeExternalPaneOutput preserves SGR colors while removing unsafe controls', () => {
  assert.equal(
    normalizeExternalPaneOutput('\u001b[38;5;33mBlue\u001b[0m\u0000\u0007\n'),
    '\u001b[38;5;33mBlue\u001b[0m',
  );
});

test('extractContainedTranscriptSessionId accepts only JSONL transcripts under the provider root', () => {
  const id = '019f8d69-4efd-7000-a246-c93853b87288';
  assert.equal(
    extractContainedTranscriptSessionId(
      '/home/user/.omp/agent/sessions',
      `/home/user/.omp/agent/sessions/-workspace-app/start_${id}.jsonl`,
    ),
    id,
  );
  assert.equal(
    extractContainedTranscriptSessionId(
      '/home/user/.omp/agent/sessions',
      `/home/user/.omp/agent/other/start_${id}.jsonl`,
    ),
    null,
  );
  assert.equal(
    extractContainedTranscriptSessionId(
      '/home/user/.omp/agent/sessions',
      '/home/user/.omp/agent/sessions/-workspace-app/not-a-session.jsonl',
    ),
    null,
  );
});
test('parseExternalPanes splits exact identity<TAB>name<TAB>pid<TAB>pane_current_command', () => {
  const out = parseExternalPanes('/tmp/tmux-1000/default\t$113501\t@113501\t%113501\tpatina\t113501\tclaude\t\t\t\t\n/tmp/tmux-1000/default\t$360992\t@360992\t%360992\ttest\t360992\tnode\t\t\t\t\n\nbad-line\n');
  assert.deepEqual(out, [
    { name: 'patina', tmux: tmux('$113501', '@113501', '%113501'), pid: 113501, command: 'claude' },
    { name: 'test', tmux: tmux('$360992', '@360992', '%360992'), pid: 360992, command: 'node' },
  ]);
});

test('parseExternalPanes reads ChatMux provider/session tags for freshly spawned panes', () => {
  const out = parseExternalPanes(
    '/tmp/tmux-1000/default\t$710\t@710\t%710\tomp-work\t710\tnode\t\t/workspace\tomp\t019f848f_ff71_77f0\n',
  );
  assert.deepEqual(out, [{
    name: 'omp-work',
    tmux: tmux('$710', '@710', '%710'),
    pid: 710,
    command: 'node',
    cwd: '/workspace',
    taggedKind: 'omp',
    taggedSessionId: '019f848f_ff71_77f0',
  }]);
});

test('parseExternalPanes reads transcript id and cwd from the extended tmux format', () => {
  const out = parseExternalPanes(
    '/tmp/tmux-1000/default\t$700\t@700\t%700\tnative\t700\tnode\t\t/workspace\t\t\n/tmp/tmux-1000/default\t$701\t@701\t%701\tmobile\t701\tnode\t019f848f-ff71-77f0-8623-08625d24f037\t/workspace/mobile\t\t\n',
  );
  assert.deepEqual(out, [
    { name: 'native', tmux: tmux('$700', '@700', '%700'), pid: 700, command: 'node', cwd: '/workspace' },
    {
      name: 'mobile',
      tmux: tmux('$701', '@701', '%701'),
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
      { targetKey: tmuxTargetKey(tmux('$101', '@101', '%101')), cwd: '/workspace', startedAtMs: 1_000 },
      { targetKey: tmuxTargetKey(tmux('$102', '@102', '%102')), cwd: '/workspace', startedAtMs: 2_000 },
      { targetKey: tmuxTargetKey(tmux('$103', '@103', '%103')), cwd: '/other', startedAtMs: 1_500 },
    ],
    [
      { id: 'thread-first', cwd: '/workspace', createdAtMs: 1_100 },
      { id: 'thread-other', cwd: '/other', createdAtMs: 1_600 },
      { id: 'thread-second', cwd: '/workspace', createdAtMs: 2_100 },
      { id: 'unrelated', cwd: '/missing', createdAtMs: 2_200 },
    ],
  );
  assert.deepEqual([...assigned], [
    [tmuxTargetKey(tmux('$101', '@101', '%101')), 'thread-first'],
    [tmuxTargetKey(tmux('$103', '@103', '%103')), 'thread-other'],
    [tmuxTargetKey(tmux('$102', '@102', '%102')), 'thread-second'],
  ]);
});

test('assignFreshCodexThreadIds ignores threads outside the launch window', () => {
  const assigned = assignFreshCodexThreadIds(
    [{ targetKey: tmuxTargetKey(tmux('$104', '@104', '%104')), cwd: '/workspace', startedAtMs: 1_000 }],
    [{ id: 'too-late', cwd: '/workspace', createdAtMs: 2_001 }],
    1_000,
  );
  assert.equal(assigned.size, 0);
});

test('assignFreshIndexedProviderSessionIds pairs unique disk transcripts newest-first', () => {
  const assigned = assignFreshIndexedProviderSessionIds(
    [
      { tmuxName: 'first', tmux: tmux('$201', '@201', '%201'), kind: 'omp', cwd: '/workspace', startedAtMs: 10_000 },
      { tmuxName: 'second', tmux: tmux('$202', '@202', '%202'), kind: 'omp', cwd: '/workspace', startedAtMs: 20_000 },
    ],
    [
      { id: 'session-first', kind: 'omp', cwd: '/workspace', createdAtMs: 10_500, diskDiscovered: true },
      { id: 'session-second', kind: 'omp', cwd: '/workspace', createdAtMs: 20_500, diskDiscovered: true },
    ],
    60_000,
    30_000,
  );
  assert.deepEqual([...assigned], [
    [tmuxTargetKey(tmux('$202', '@202', '%202')), 'session-second'],
    [tmuxTargetKey(tmux('$201', '@201', '%201')), 'session-first'],
  ]);
});

test('assignFreshIndexedProviderSessionIds rejects stale, app-created, and ambiguous candidates', () => {
  const process = [{ tmuxName: 'work', tmux: tmux('$301', '@301', '%301'), kind: 'opencode' as const, cwd: '/workspace', startedAtMs: 10_000 }];
  assert.equal(assignFreshIndexedProviderSessionIds(process, [
    { id: 'stale', kind: 'opencode', cwd: '/workspace', createdAtMs: 8_000, diskDiscovered: true },
    { id: 'app-row', kind: 'opencode', cwd: '/workspace', createdAtMs: 10_500, diskDiscovered: false },
  ], 60_000, 30_000).size, 0);

  assert.equal(assignFreshIndexedProviderSessionIds(process, [
    { id: 'candidate-a', kind: 'opencode', cwd: '/workspace', createdAtMs: 10_500, diskDiscovered: true },
    { id: 'candidate-b', kind: 'opencode', cwd: '/workspace', createdAtMs: 11_000, diskDiscovered: true },
  ], 60_000, 30_000).size, 0);
});

test('assignUniqueIndexedProviderSessionIds binds one late transcript to one long-running TUI', () => {
  const process = [{
    tmuxName: 'opencode',
    tmux: tmux('$302', '@302', '%302'),
    kind: 'opencode' as const,
    cwd: '/workspace',
    startedAtMs: 10_000,
  }];
  const assigned = assignUniqueIndexedProviderSessionIds(process, [{
    id: 'late-session',
    kind: 'opencode',
    cwd: '/workspace',
    createdAtMs: 80_000,
    diskDiscovered: true,
  }], new Map(), 90_000);
  assert.equal(assigned.get(tmuxTargetKey(process[0].tmux)), 'late-session');
});

test('assignUniqueIndexedProviderSessionIds rejects ambiguous long-running TUI matches', () => {
  const process = [{
    tmuxName: 'opencode',
    tmux: tmux('$303', '@303', '%303'),
    kind: 'opencode' as const,
    cwd: '/workspace',
    startedAtMs: 10_000,
  }];
  assert.equal(assignUniqueIndexedProviderSessionIds(process, [
    { id: 'session-a', kind: 'opencode', cwd: '/workspace', createdAtMs: 80_000, diskDiscovered: true },
    { id: 'session-b', kind: 'opencode', cwd: '/workspace', createdAtMs: 81_000, diskDiscovered: true },
  ], new Map(), 90_000).size, 0);
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
    panes: [{ name: 'native', tmux: tmux('$700', '@700', '%700'), pid: 700, command: 'node' }],
    procs: [
      { pid: 700, ppid: 1, comm: 'zsh', args: '-zsh' },
      { pid: 701, ppid: 700, comm: 'node', args: 'node /home/user/bin/codex resume 019f7b07-3def-7501-a53f-f519c88dd722' },
      { pid: 702, ppid: 701, comm: 'codex', args: '/vendor/codex resume 019f7b07-3def-7501-a53f-f519c88dd722' },
    ],
  });
  assert.deepEqual(result, [{
    tmuxName: 'native',
    tmux: tmux('$700', '@700', '%700'),
    kind: 'codex',
    providerSessionId: '019f7b07-3def-7501-a53f-f519c88dd722',
    agentPid: 701,
  }]);
});

test('classifyExternalSessions recognizes Cursor, OpenCode, and Oh My Pi process trees', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'cursor-work', tmux: tmux('$800', '@800', '%800'), pid: 800, command: 'cursor-agent', cwd: '/cursor' },
      { name: 'opencode-work', tmux: tmux('$900', '@900', '%900'), pid: 900, command: 'opencode', cwd: '/opencode' },
      { name: 'omp-work', tmux: tmux('$1000', '@1000', '%1000'), pid: 1000, command: 'omp', cwd: '/omp' },
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
    { tmuxName: 'cursor-work', tmux: tmux('$800', '@800', '%800'), kind: 'cursor', providerSessionId: 'cursor-session-123', cwd: '/cursor', agentPid: 801 },
    { tmuxName: 'omp-work', tmux: tmux('$1000', '@1000', '%1000'), kind: 'omp', providerSessionId: 'omp_session_123', cwd: '/omp', agentPid: 1001 },
    { tmuxName: 'opencode-work', tmux: tmux('$900', '@900', '%900'), kind: 'opencode', providerSessionId: 'ses_open_123', cwd: '/opencode', agentPid: 901 },
  ]);
});

test('classifyExternalSessions trusts a valid ChatMux spawn tag through a node launcher', () => {
  const result = classifyExternalSessions({
    panes: [{
      name: 'omp-fresh',
      tmux: tmux('$1100', '@1100', '%1100'),
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
    tmux: tmux('$1100', '@1100', '%1100'),
    kind: 'omp',
    providerSessionId: 'omp_tagged_123',
    cwd: '/workspace',
  }]);
});

test('classifyExternalSessions: claude pane by pane_current_command (실측 shape)', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'patina', tmux: tmux('$113501', '@113501', '%113501'), pid: 113501, command: 'claude' }],
    procs: [{ pid: 113501, ppid: 1, comm: 'claude' }],
  });
  assert.deepEqual(result, [{ tmuxName: 'patina', tmux: tmux('$113501', '@113501', '%113501'), kind: 'claude', agentPid: 113501 }]);
});

test('classifyExternalSessions: codex surfaces as node pane + codex descendant (실측 shape)', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'test', tmux: tmux('$360992', '@360992', '%360992'), pid: 360992, command: 'node' }],
    procs: [
      { pid: 360992, ppid: 1278, comm: 'node' },
      { pid: 1731329, ppid: 360992, comm: 'node' },
      { pid: 1731394, ppid: 1731329, comm: 'codex' },
    ],
  });
  assert.deepEqual(result, [{ tmuxName: 'test', tmux: tmux('$360992', '@360992', '%360992'), kind: 'codex', agentPid: 1731394 }]);
});

test('classifyExternalSessions: tagged Codex pane exposes its transcript thread id', () => {
  const result = classifyExternalSessions({
    panes: [{
      name: 'mobile',
      tmux: tmux('$700', '@700', '%700'),
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
    tmux: tmux('$700', '@700', '%700'),
    kind: 'codex',
    providerSessionId: '019f848f-ff71-77f0-8623-08625d24f037',
    agentPid: 701,
  }]);
});

test('classifyExternalSessions: gjc excludes only its exact pane (live lane contract)', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'flask', tmux: tmux('$357', '@357', '%357760'), pid: 357760, command: 'gjc' },
      { name: 'flask', tmux: tmux('$357', '@357', '%357761'), pid: 357761, command: 'claude' },
      { name: 'stock', tmux: tmux('$61685', '@61685', '%61685'), pid: 61685, command: 'claude' },
    ],
    procs: [
      { pid: 357760, ppid: 1, comm: 'gjc' },
      { pid: 357761, ppid: 1, comm: 'claude' },
      { pid: 61685, ppid: 1, comm: 'claude' },
    ],
  });
  assert.deepEqual(result, [
    { tmuxName: 'flask', tmux: tmux('$357', '@357', '%357761'), kind: 'claude', agentPid: 357761 },
    { tmuxName: 'stock', tmux: tmux('$61685', '@61685', '%61685'), kind: 'claude', agentPid: 61685 },
  ]);
});

test('classifyExternalSessions: ssh tunnels surface as attach-only ssh rows (실측: company)', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'company', tmux: tmux('$3318360', '@3318360', '%3318360'), pid: 3318360, command: 'ssh' }],
    procs: [{ pid: 3318360, ppid: 1, comm: 'ssh' }],
  });
  assert.deepEqual(result, [{ tmuxName: 'company', tmux: tmux('$3318360', '@3318360', '%3318360'), kind: 'ssh', agentPid: 3318360 }]);
});

test('classifyExternalSessions: plain shell panes surface as attach-only rows', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'scratch', tmux: tmux('$400', '@400', '%400'), pid: 400, command: 'zsh' }],
    procs: [{ pid: 400, ppid: 1, comm: 'zsh' }],
  });
  assert.deepEqual(result, [{ tmuxName: 'scratch', tmux: tmux('$400', '@400', '%400'), kind: 'shell' }]);
});

test('classifyExternalSessions: local claude and ssh remain distinct panes in one session', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'mixed', tmux: tmux('$500', '@500', '%500'), pid: 500, command: 'claude' },
      { name: 'mixed', tmux: tmux('$500', '@500', '%600'), pid: 600, command: 'ssh' },
    ],
    procs: [
      { pid: 500, ppid: 1, comm: 'claude' },
      { pid: 600, ppid: 1, comm: 'ssh' },
    ],
  });
  assert.deepEqual(result, [
    { tmuxName: 'mixed', tmux: tmux('$500', '@500', '%500'), kind: 'claude', agentPid: 500 },
    { tmuxName: 'mixed', tmux: tmux('$500', '@500', '%600'), kind: 'ssh', agentPid: 600 },
  ]);
});

test('classifyExternalSessions: a multi-pane session retains the actionable pane identity', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'work', tmux: tmux('$100', '@100', '%100'), pid: 100, command: 'zsh' },
      { name: 'work', tmux: tmux('$100', '@100', '%200'), pid: 200, command: 'claude' },
    ],
    procs: [
      { pid: 100, ppid: 1, comm: 'zsh' },
      { pid: 200, ppid: 1, comm: 'claude' },
    ],
  });
  assert.deepEqual(result, [
    { tmuxName: 'work', tmux: tmux('$100', '@100', '%100'), kind: 'shell' },
    { tmuxName: 'work', tmux: tmux('$100', '@100', '%200'), kind: 'claude', agentPid: 200 },
  ]);
});

test('classifyExternalSessions keeps display names out of the pane identity contract', () => {
  const result = classifyExternalSessions({
    panes: [{ name: "label;$(not-a-shell)'", tmux: tmux('$300', '@300', '%300'), pid: 300, command: 'claude' }],
    procs: [{ pid: 300, ppid: 1, comm: 'claude' }],
  });
  assert.deepEqual(result, [{
    tmuxName: "label;$(not-a-shell)'",
    tmux: tmux('$300', '@300', '%300'),
    kind: 'claude',
    agentPid: 300,
  }]);
});

test('classifyExternalSessions: descendant BFS is cycle-guarded', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'loop', tmux: tmux('$1', '@1', '%1'), pid: 1, command: 'zsh' }],
    procs: [
      { pid: 1, ppid: 2, comm: 'zsh' },
      { pid: 2, ppid: 1, comm: 'claude' }, // artificial cycle
    ],
  });
  assert.deepEqual(result, [{ tmuxName: 'loop', tmux: tmux('$1', '@1', '%1'), kind: 'shell' }]);
});

test('classifyExternalSessions recognizes a Bun-launched Oh My Pi TUI owned by the pane shell', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'omp-main', tmux: tmux('$1300', '@1300', '%1300'), pid: 1300, command: 'bun', cwd: '/workspace/omp' }],
    procs: [
      { pid: 1300, ppid: 1, comm: 'zsh', args: '-zsh' },
      { pid: 1301, ppid: 1300, comm: 'bun', args: 'bun /home/user/.bun/bin/omp' },
      { pid: 1302, ppid: 1301, comm: 'bun', args: 'cli.js __omp_worker_js_eval_process' },
    ],
  });
  assert.deepEqual(result, [{
    tmuxName: 'omp-main',
    tmux: tmux('$1300', '@1300', '%1300'),
    kind: 'omp',
    cwd: '/workspace/omp',
    agentPid: 1301,
  }]);
});

test('classifyExternalSessions keeps background Oh My Pi workers out of a shell row', () => {
  const result = classifyExternalSessions({
    panes: [{ name: 'chatmux', tmux: tmux('$1200', '@1200', '%1200'), pid: 1200, command: 'bun', cwd: '/workspace/chatmux' }],
    procs: [
      { pid: 1200, ppid: 1, comm: 'bun', args: 'bun server/index.ts' },
      { pid: 1201, ppid: 1200, comm: 'node', args: 'node /usr/bin/omp --resume background_omp_123' },
    ],
  });
  assert.deepEqual(result, [{
    tmuxName: 'chatmux',
    tmux: tmux('$1200', '@1200', '%1200'),
    kind: 'shell',
    cwd: '/workspace/chatmux',
  }]);
});

test('classifyExternalSessions: sorted by tmux name for stable rendering', () => {
  const result = classifyExternalSessions({
    panes: [
      { name: 'zeta', tmux: tmux('$1', '@1', '%1'), pid: 1, command: 'claude' },
      { name: 'alpha', tmux: tmux('$2', '@2', '%2'), pid: 2, command: 'claude' },
    ],
    procs: [
      { pid: 1, ppid: 0, comm: 'claude' },
      { pid: 2, ppid: 0, comm: 'claude' },
    ],
  });
  assert.deepEqual(result.map((s) => s.tmuxName), ['alpha', 'zeta']);
});
