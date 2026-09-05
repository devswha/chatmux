import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExternalPane, ProcessTreeEntry } from '../services/external-cli-sessions/contracts-and-resume.js';
import type { CustomProcessRecordReader } from '../services/external-cli-sessions/custom-terminal-agents.js';
import { matchesCustomTerminalAgent, readCustomProcessEvidence, readCustomTerminalAgents } from '../services/external-cli-sessions/custom-terminal-agents.js';
import { classifyCustomTerminalSessions, classifyExternalSessions } from '../services/external-cli-sessions/process-classification.js';

const rule = { command: 'my-agent', argv: ['chat'] };
const config = (value: unknown = [rule]): NodeJS.ProcessEnv => ({ CHATMUX_CUSTOM_TERMINAL_AGENTS: JSON.stringify(value) });
const tmux = { socketPath: '/tmp/custom-test.sock', sessionId: '$1', windowId: '@1', paneId: '%1' };

function stat(pid: number, overrides: Partial<Record<'ppid' | 'pgid' | 'sid' | 'tty' | 'foregroundPgid' | 'startTicks', number>> = {}, state = 'S'): string {
  const values = { ppid: 1, pgid: 100, sid: 50, tty: 34816, foregroundPgid: 100, startTicks: 1234, ...overrides };
  const fields = Array<string>(50).fill('0');
  fields[0] = state;
  for (const [index, value] of [
    [1, values.ppid], [2, values.pgid], [3, values.sid], [4, values.tty],
    [5, values.foregroundPgid], [19, values.startTicks],
  ]) fields[index] = String(value);
  return `${pid} (comm with ) spaces) ${fields.join(' ')}\n`;
}

function fixture(rootIsShell = false) {
  const panes: ExternalPane[] = [{ name: 'custom', tmux, pid: 100, command: 'my-agent', cwd: '/work' }];
  const procs: ProcessTreeEntry[] = rootIsShell
    ? [{ pid: 100, ppid: 1, comm: 'bash', args: 'bash' }, { pid: 101, ppid: 100, comm: 'my-agent', args: 'my-agent chat' }]
    : [{ pid: 100, ppid: 1, comm: 'my-agent', args: 'my-agent chat' }];
  const records = new Map<number, { stat: string; cmdline: string }>(rootIsShell ? [
    [100, { stat: stat(100, { foregroundPgid: 101 }), cmdline: 'bash\0' }],
    [101, { stat: stat(101, { ppid: 100, pgid: 101, foregroundPgid: 101 }), cmdline: '/opt/bin/my-agent\0chat\0' }],
  ] : [[100, { stat: stat(100), cmdline: '/opt/bin/my-agent\0chat\0' }]]);
  const reads: Array<[number, string]> = [];
  const readProcessRecord: CustomProcessRecordReader = async (pid, record) => {
    reads.push([pid, record]);
    return records.get(pid)?.[record] ?? null;
  };
  const base = () => classifyExternalSessions({ panes, procs });
  const classify = (env = config()) => classifyCustomTerminalSessions({ sessions: base(), panes, procs }, {
    env, platform: 'linux', readProcessRecord,
  });
  return { panes, procs, records, reads, readProcessRecord, classify, base };
}

test('owner-local config accepts bounded immutable exact command/argv rules', () => {
  assert.deepEqual(readCustomTerminalAgents({}), []);
  assert.deepEqual(readCustomTerminalAgents(config([])), []);
  const rules = readCustomTerminalAgents(config([rule, { command: '/opt/my-agent', argv: [] }, {
    command: 'node', argv: ['/opt/my-agent/cli.js', '--mode=chat', 'user@host:42', '100%'],
  }]));
  assert.equal(rules.length, 3);
  assert.ok(Object.isFrozen(rules));
  assert.ok(Object.isFrozen(rules[0]));
  assert.ok(Object.isFrozen(rules[0].argv));
  assert.equal(readCustomTerminalAgents(config(Array.from({ length: 16 }, (_, index) => ({ command: `agent-${index}`, argv: [] })))).length, 16);
  assert.equal(readCustomTerminalAgents(config([{ command: 'x'.repeat(256), argv: Array(16).fill('a'.repeat(256)) }])).length, 1);
});

test('malformed, oversized, duplicate and unsupported config disables the entire custom rule set', () => {
  const malformed = [
    'not-json', '[', '{}', 'null', '42', 'true', ' '.repeat(8193),
    JSON.stringify([rule]).padEnd(8193),
    JSON.stringify([{ command: 'é'.repeat(4100), argv: [] }]),
  ];
  for (const raw of malformed) assert.deepEqual(readCustomTerminalAgents({ CHATMUX_CUSTOM_TERMINAL_AGENTS: raw }), []);
  for (const entry of [
    null, [], {}, 'my-agent', { command: 'my-agent' }, { argv: [] },
    { ...rule, label: 'Custom' }, { ...rule, regex: '.*' }, { ...rule, exec: 'my-agent' },
    { command: '', argv: [] }, { command: 'x'.repeat(257), argv: [] },
    { command: 'my-agent', argv: 'chat' }, { command: 'my-agent', argv: [null] },
    { command: 'my-agent', argv: [''] }, { command: 'my-agent', argv: ['x'.repeat(257)] },
    { command: 'my-agent', argv: Array(17).fill('chat') },
    ...['../my-agent', './my-agent', 'bin/my-agent', '/opt//my-agent', '/opt/../my-agent', '/opt/./my-agent', '/', '.', '..',
      'my agent', 'my-agent\n', 'my-agent\0', '*agent', 'my-agent|other', '$(agent)', 'my-agent.exe;'].map((command) => ({ command, argv: [] })),
    ...['chat now', 'chat\n', 'chat\0', '*', '$(pwd)', '`pwd`', '"chat"', "'chat'", 'a\\b', '\u001b[2J'].map((arg) => ({ command: 'my-agent', argv: [arg] })),
    ...['bash', 'sh', 'env', 'sudo', 'npm', 'npx', 'pnpm', 'yarn', 'uvx', 'tmux', 'nohup'].map((command) => ({ command, argv: ['my-agent'] })),
    { command: 'node', argv: [] }, { command: 'node', argv: ['-e', 'code'] },
    { command: 'bun', argv: ['run', 'cli.js'] }, { command: 'python3', argv: ['-c', 'code'] },
  ]) assert.deepEqual(readCustomTerminalAgents(config([rule, entry])), [], JSON.stringify(entry));
  assert.deepEqual(readCustomTerminalAgents(config([rule, rule])), []);
  assert.deepEqual(readCustomTerminalAgents(config(Array.from({ length: 17 }, (_, index) => ({ command: `agent-${index}`, argv: [] })))), []);
});

test('matching requires complete case-sensitive executable and argument tokens, position and count', () => {
  const rules = readCustomTerminalAgents(config());
  assert.equal(matchesCustomTerminalAgent(['/opt/bin/my-agent', 'chat'], rules), true);
  assert.equal(matchesCustomTerminalAgent(['my-agent', 'chat'], rules), true);
  for (const argv of [
    [], ['my-agent'], ['my-agent-other', 'chat'], ['other-my-agent', 'chat'],
    ['MY-AGENT', 'chat'], ['my-agent', 'Chat'], ['my-agent', 'chatty'],
    ['my-agent', '--mode=chat'], ['my-agent', 'chat', '--quiet'], ['my-agent', 'chat --quiet'],
    ['my-agent', '--quiet', 'chat'], ['node', 'my-agent', 'chat'], ['sh', '-c', 'my-agent chat'],
    ['my-agent\0', 'chat'], ['my-agent', 'chat\0'], ['./my-agent', 'chat'],
  ]) assert.equal(matchesCustomTerminalAgent(argv, rules), false, JSON.stringify(argv));
  const exactPath = readCustomTerminalAgents(config([{ command: '/opt/bin/my-agent', argv: [] }]));
  assert.equal(matchesCustomTerminalAgent(['/opt/bin/my-agent'], exactPath), true);
  assert.equal(matchesCustomTerminalAgent(['/another/bin/my-agent'], exactPath), false);
  assert.equal(matchesCustomTerminalAgent(['my-agent'], exactPath), false);
  assert.equal(matchesCustomTerminalAgent(['/opt/bin/my-agent', 'chat'], exactPath), false);
});

test('unset config, invalid config, unknown commands and unsupported platforms perform no additional reads', async () => {
  for (const rootIsShell of [false, true]) {
    for (const env of [{}, config([]), { CHATMUX_CUSTOM_TERMINAL_AGENTS: 'malformed' }, config([{ command: 'different-agent', argv: [] }])]) {
      const f = fixture(rootIsShell);
      assert.deepEqual(await f.classify(env), f.base());
      assert.deepEqual(f.reads, []);
    }
    for (const platform of ['darwin', 'win32'] as const) {
      const f = fixture(rootIsShell);
      const sessions = f.base();
      assert.equal(await classifyCustomTerminalSessions({ sessions, panes: f.panes, procs: f.procs }, {
        env: config(), platform, readProcessRecord: f.readProcessRecord,
      }), sessions);
      assert.deepEqual(f.reads, []);
    }
  }
});

test('matching pane root and foreground shell child remain shell rows with only observed PID enrichment', async () => {
  for (const child of [false, true]) {
    const f = fixture(child);
    assert.deepEqual(await f.classify(), [{ ...f.base()[0], agentPid: child ? 101 : 100 }]);
    assert.equal(f.reads.filter(([, record]) => record === 'cmdline').length, child ? 2 : 1);
  }
});

test('a bash -c launch wrapper with a sole foreground custom child remains unclassified', async () => {
  const f = fixture(true);
  f.procs[0].args = "bash -c 'my-agent chat; sleep 60'";
  f.records.get(100)!.cmdline = 'bash\0-c\0my-agent chat; sleep 60\0';
  assert.deepEqual(await f.classify(), f.base());
});

test('a stale bash snapshot whose live argv is Python cannot classify its custom child', async () => {
  const f = fixture(true);
  f.records.get(100)!.cmdline = '/usr/bin/python3\0/opt/launcher.py\0';
  assert.deepEqual(await f.classify(), f.base());
});

test('supported live default, login and interactive shells retain their sole foreground child', async () => {
  for (const shell of ['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'nu']) {
    const invocations = [
      [shell], [`/bin/${shell}`], [`-${shell}`], [`/bin/${shell}`, '-i'],
      [shell, '-l'], [`-${shell}`, '-i'], [shell, '-i', '-l'],
      ...(shell === 'nu' ? [] : [[shell, '-il'], [shell, '-li']]),
      ...(shell === 'bash' ? [
        [shell, '--login'], [shell, '--noprofile', '--norc'],
        [shell, '--noprofile', '--norc', '--login', '-i'],
      ] : []),
    ];
    for (const argv of invocations) {
      const f = fixture(true);
      // Snapshot display args must not replace the current NUL-delimited argv.
      f.procs[0] = { ...f.procs[0], comm: shell, args: `${shell} -c stale-wrapper` };
      f.records.get(100)!.cmdline = `${argv.join('\0')}\0`;
      assert.deepEqual(await f.classify(), [{ ...f.base()[0], agentPid: 101 }], JSON.stringify(argv));
    }
  }
});

test('live shell command modes, scripts, unsupported options and executable mismatches fail closed', async () => {
  for (const argv of [
    ['bash', '-lc', 'my-agent chat; sleep 60'], ['bash', '-ic', 'my-agent chat'],
    ['bash', '-i', '-c', 'my-agent chat'], ['bash', '--norc', '-lic', 'my-agent chat'],
    ['bash', '/opt/launcher.sh'], ['bash', '-i', '/opt/launcher.sh'],
    ['bash', '--', '/opt/launcher.sh'], ['bash', '--noprofile', '--norc', '/opt/launcher.sh'],
    ['bash', '-s'], ['bash', '+i'], ['bash', '--command=my-agent'],
    ['bash', '--rcfile', '/opt/launcher.sh'], ['bash', '--norc\n'],
    ['bash', '-i', '--norc'], ['bash', '-i\n'], ['bash', '-illegal'],
    ['/usr/bin/zsh'], ['other-bash'], ['/opt/bash/python3', '/opt/launcher.py'],
    ['./bash'], ['/bin//bash'], ['/bin/../bin/bash'],
  ]) {
    const f = fixture(true);
    f.records.get(100)!.cmdline = `${argv.join('\0')}\0`;
    assert.deepEqual(await f.classify(), f.base(), JSON.stringify(argv));
  }
});

test('live shell or child foreground and generation changes invalidate custom child evidence', async () => {
  for (const target of [100, 101]) {
    for (const changed of [{ startTicks: 9999 }, { foregroundPgid: 102 }, { ppid: 300 }, null]) {
      const f = fixture(true);
      let statReads = 0;
      const sessions = f.base();
      const result = await classifyCustomTerminalSessions({ sessions, panes: f.panes, procs: f.procs }, {
        env: config(), platform: 'linux',
        readProcessRecord: async (pid, record) => {
          const value = await f.readProcessRecord(pid, record);
          if (pid !== target || record !== 'stat' || ++statReads !== 2) return value;
          return changed === null ? null : stat(pid, {
            ppid: pid === 100 ? 1 : 100, pgid: pid, foregroundPgid: 101, ...changed,
          });
        },
      });
      assert.deepEqual(result, sessions, JSON.stringify({ target, changed }));
    }
  }
});

test('explicit Node script argv matches without inferring an interpreter wrapper', async () => {
  const f = fixture(true);
  f.panes[0].command = 'node';
  f.procs[1] = { pid: 101, ppid: 100, comm: 'node', args: 'node /opt/my-agent/cli.js chat' };
  f.records.get(101)!.cmdline = '/usr/bin/node\0/opt/my-agent/cli.js\0chat\0';
  assert.equal((await f.classify(config([{ command: 'node', argv: ['/opt/my-agent/cli.js', 'chat'] }])))[0].agentPid, 101);
  assert.deepEqual(await f.classify(), f.base());
});

test('ps display text cannot substitute for NUL-delimited exact argv', async () => {
  for (const cmdline of ['my-agent\0chat --quiet\0', 'my-agent\0--quiet\0chat\0', 'my-agent\0chatty\0',
    'my-agent-extra\0chat\0', 'my-agent\0chat', 'my-agent chat\0', 'other-agent\0chat\0']) {
    const f = fixture();
    f.records.get(100)!.cmdline = cmdline;
    assert.deepEqual(await f.classify(), f.base(), cmdline);
  }
});

test('truncated comm still requires exact argv and conflicting allowed executable names cannot match', async () => {
  const f = fixture();
  const command = 'my-custom-agent-with-long-name';
  f.procs[0].comm = command.slice(0, 15);
  f.procs[0].args = `${command} chat`;
  f.panes[0].command = command.slice(0, 15);
  f.records.get(100)!.cmdline = `/opt/bin/${command}\0chat\0`;
  assert.equal((await f.classify(config([{ command, argv: ['chat'] }])))[0].agentPid, 100);
  f.records.get(100)!.cmdline = `/opt/bin/${command}-other\0chat\0`;
  assert.deepEqual(await f.classify(config([{ command, argv: ['chat'] }])), f.base());

  const conflicting = fixture();
  conflicting.records.get(100)!.cmdline = 'other-agent\0chat\0';
  assert.deepEqual(await conflicting.classify(config([rule, { command: 'other-agent', argv: ['chat'] }])), conflicting.base());
});

test('background, wrong foreground, detached, stale and cross-terminal process evidence cannot match', async () => {
  for (const overrides of [
    { foregroundPgid: 100 }, { pgid: 200 }, { ppid: 300 }, { tty: 0 }, { tty: 34817 },
    { sid: 60 }, { foregroundPgid: -1 }, { startTicks: 0 },
  ]) {
    const f = fixture(true);
    f.records.get(101)!.stat = stat(101, { ppid: 100, pgid: 101, foregroundPgid: 101, ...overrides });
    assert.deepEqual(await f.classify(), f.base(), JSON.stringify(overrides));
  }
  for (const state of ['Z', 'X', 'T', 't']) {
    const f = fixture();
    f.records.get(100)!.stat = stat(100, {}, state);
    assert.deepEqual(await f.classify(), f.base());
  }
  const f = fixture(true);
  f.panes[0].command = 'bash';
  assert.deepEqual(await f.classify(), f.base(), 'pane current command must agree');
});

test('nested app workers, shell launch strings, ancestor matches and duplicate foreground siblings remain unclassified', async () => {
  const nested = fixture(true);
  nested.procs[1].ppid = 102;
  nested.procs.push({ pid: 102, ppid: 100, comm: 'node', args: 'node app.js' });
  assert.deepEqual(await nested.classify(), nested.base());
  assert.deepEqual(nested.reads, []);

  const wrapper = fixture();
  wrapper.procs[0] = { pid: 100, ppid: 1, comm: 'bash', args: 'bash -c my-agent chat' };
  assert.deepEqual(await wrapper.classify(), wrapper.base());
  assert.deepEqual(wrapper.reads, []);

  const ancestor = fixture();
  ancestor.panes[0].pid = 200;
  ancestor.procs.push({ pid: 200, ppid: 100, comm: 'bash', args: 'bash' });
  assert.deepEqual(await ancestor.classify(), ancestor.base());

  const ambiguous = fixture(true);
  ambiguous.procs.push({ pid: 102, ppid: 100, comm: 'my-agent', args: 'my-agent chat' });
  ambiguous.records.set(102, { stat: stat(102, { ppid: 100, pgid: 101, foregroundPgid: 101 }), cmdline: 'my-agent\0chat\0' });
  assert.deepEqual(await ambiguous.classify(), ambiguous.base());
  assert.deepEqual(ambiguous.reads, []);

  const unreadableSibling = fixture(true);
  unreadableSibling.procs.push({ pid: 102, ppid: 100, comm: 'unknown-app', args: 'unknown-app' });
  assert.deepEqual(await unreadableSibling.classify(), unreadableSibling.base());
  assert.deepEqual(unreadableSibling.reads, []);
});

test('a child older than its pane shell or a cyclic parent/child snapshot is ambiguous', async () => {
  const older = fixture(true);
  older.records.get(101)!.stat = stat(101, { ppid: 100, pgid: 101, foregroundPgid: 101, startTicks: 1233 });
  assert.deepEqual(await older.classify(), older.base());
  const cycle = fixture(true);
  cycle.procs[0].ppid = 101;
  cycle.records.get(100)!.stat = stat(100, { ppid: 101, foregroundPgid: 101 });
  assert.deepEqual(await cycle.classify(), cycle.base());
});

test('duplicate snapshot PIDs and duplicate pane identities cannot select a custom process', async () => {
  for (const duplicate of ['pid', 'pane']) {
    const f = fixture();
    if (duplicate === 'pid') f.procs.push({ ...f.procs[0] }); else f.panes.push({ ...f.panes[0] });
    assert.deepEqual(await f.classify(), f.base());
    assert.deepEqual(f.reads, []);
  }
});

test('all built-in providers, SSH, spawn tags and GJC exclusion retain precedence', async () => {
  for (const kind of ['gjc', 'claude', 'codex', 'cursor', 'opencode', 'omp', 'omo', 'ssh']) {
    const f = fixture();
    const command = kind === 'cursor' ? 'cursor-agent' : kind;
    f.panes[0].command = command;
    f.procs[0] = { pid: 100, ppid: 1, comm: command, args: `${command} chat` };
    const before = f.base();
    assert.deepEqual(await f.classify(config([{ command, argv: ['chat'] }])), before, kind);
    assert.deepEqual(f.reads, [], kind);
  }
  for (const taggedKind of ['claude', 'codex', 'cursor', 'opencode', 'omp', 'omo'] as const) {
    const f = fixture();
    f.panes[0].taggedKind = taggedKind;
    f.panes[0].taggedSessionId = '12345678-1234-1234-1234-123456789abc';
    assert.deepEqual(await f.classify(), f.base());
    assert.deepEqual(f.reads, []);
  }
  const f = fixture();
  f.procs.push({ pid: 101, ppid: 100, comm: 'gjc', args: 'gjc' });
  assert.deepEqual(await f.classify(), []);
  assert.deepEqual(f.reads, []);
});

test('candidate process evidence is bounded before I/O', async () => {
  const panes: ExternalPane[] = [];
  const procs: ProcessTreeEntry[] = [];
  for (let pid = 1; pid <= 129; pid += 1) {
    panes.push({ name: `custom-${pid}`, tmux: { ...tmux, paneId: `%${pid}` }, pid, command: 'my-agent' });
    procs.push({ pid, ppid: 1000, comm: 'my-agent', args: 'my-agent chat' });
  }
  const sessions = classifyExternalSessions({ panes, procs });
  assert.equal(await classifyCustomTerminalSessions({ sessions, panes, procs }, {
    env: config(), platform: 'linux', readProcessRecord: async () => assert.fail('read beyond candidate budget'),
  }), sessions);
});

test('record reads reject PID reuse, reparenting, foreground races and inaccessible evidence', async () => {
  for (const changed of [stat(100, { startTicks: 1235 }), stat(100, { ppid: 2 }), stat(100, { foregroundPgid: 101 }), null]) {
    let calls = 0;
    const read: CustomProcessRecordReader = async (_pid, record) => record === 'cmdline' ? 'my-agent\0chat\0' : (++calls === 1 ? stat(100) : changed);
    assert.equal(await readCustomProcessEvidence(100, read), null);
  }
  assert.equal(await readCustomProcessEvidence(100, async () => { throw new Error('EACCES'); }), null);
  for (const pid of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await readCustomProcessEvidence(pid, async () => assert.fail('invalid PID read')), null);
  }
  for (const cmdline of ['x'.repeat(8193), `${'é'.repeat(4100)}\0`, 'my-agent\0\0', `${Array(18).fill('arg').join('\0')}\0`, `${'x'.repeat(257)}\0`]) {
    assert.equal(await readCustomProcessEvidence(100, async (_pid, record) => record === 'stat' ? stat(100) : cmdline), null);
  }
  for (const value of [stat(101), stat(100).trimEnd(), ' '.repeat(8193), '100 (truncated) S 1\n']) {
    assert.equal(await readCustomProcessEvidence(100, async () => value), null);
  }
});
