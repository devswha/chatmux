import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { GjcSessionWatcher, type GjcSessionWatcherOptions } from '../services/gjc-session-watcher.service.js';

// The watcher service intentionally unrefs its internal timers so a shutting-down
// owner is never kept alive. Tests that await only those timers would let the
// event loop drain before they fire (observed on macOS), so hold one referenced
// handle for the lifetime of this file.
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

class FakeChild extends EventEmitter {
  readonly stdin = new EventEmitter() as EventEmitter & { end(): void };
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: (NodeJS.Signals | undefined)[] = [];

  constructor() {
    super();
    this.stdin.end = () => {};
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }

  output(value: string | Buffer): void {
    this.stdout.emit('data', value);
  }
}

type SpawnCall = { command: string; args: string[]; options: unknown };

function setup(overrides: Partial<GjcSessionWatcherOptions> = {}): { watcher: GjcSessionWatcher; child: FakeChild; calls: SpawnCall[]; events: { kind: 'add' | 'change'; path: string }[]; resyncs: number[]; failures: Error[] } {
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const events: { kind: 'add' | 'change'; path: string }[] = [];
  const resyncs: number[] = [];
  const failures: Error[] = [];
  const watcher = new GjcSessionWatcher({
    roots: ['/one', '/two'],
    onEvent: (event) => events.push(event),
    onResync: () => resyncs.push(events.length),
    onFailure: (error) => failures.push(error),
    spawn: ((command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      return child;
    }) as never,
    readyTimeoutMs: 100,
    closeDrainTimeoutMs: 10,
    closeExitTimeoutMs: 10,
    ...overrides,
  });
  return { watcher, child, calls, events, resyncs, failures };
}

async function ready(watcher: GjcSessionWatcher, child: FakeChild): Promise<void> {
  const started = watcher.start();
  child.output('{"protocolVersion":1,"kind":"ready"}\n');
  await started;
}

test('spawns the native watcher directly with all roots and no detached process', async () => {
  const { watcher, child, calls } = setup({ corePath: '/native/chatmux-core', environment: { SAFE: '1' } });
  await ready(watcher, child);
  assert.deepEqual(calls, [{
    command: '/native/chatmux-core',
    args: ['watch', '--root', '/one', '--root', '/two'],
    options: { detached: false, env: { SAFE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  }]);
});

test('resolves source and compiled native core layouts', async () => {
  const source = setup({ compiled: false, platform: 'linux' });
  await ready(source.watcher, source.child);
  assert.equal(source.calls[0].command, fileURLToPath(new URL('../../../../dist-native/chatmux-core', import.meta.url)));
  const compiled = setup({ compiled: true, platform: 'win32' });
  await ready(compiled.watcher, compiled.child);
  assert.equal(compiled.calls[0].command, fileURLToPath(new URL('../../../../../dist-native/chatmux-core.exe', import.meta.url)));
});

test('decodes fragmented UTF-8 CRLF frames and coalesces paths in insertion order', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const { watcher, child, events } = setup({ onEvent: async (event) => {
    events.push(event);
    if (event.path === 'a') await blocked;
  } });
  await ready(watcher, child);
  child.output(Buffer.from('{"protocolVersion":1,"kind":"event","event":"add","path":"a"}\r\n'));
  child.output(Buffer.from('{"protocolVersion":1,"kind":"event","event":"change","path":"b"}\r\n{"protocolVersion":1,"kind":"event","event":"add","path":"b"}\r\n{"protocolVersion":1,"kind":"event","event":"change","path":"a"}\r\n'));
  await Promise.resolve();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{ kind: 'add', path: 'a' }, { kind: 'add', path: 'b' }, { kind: 'change', path: 'a' }]);
  const utf8 = Buffer.from('{"protocolVersion":1,"kind":"event","event":"add","path":"é"}\r\n');
  const split = utf8.indexOf(0xc3) + 1;
  child.output(utf8.subarray(0, split));
  child.output(utf8.subarray(split));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.at(-1), { kind: 'add', path: 'é' });
});

test('rejects malformed, oversized, pre-ready, and duplicate-ready frames without path-bearing failures', async () => {
  for (const frame of [
    '{"protocolVersion":1,"kind":"event","event":"add","path":"secret"}\n',
    '{"protocolVersion":1,"kind":"unknown"}\n',
    '{"protocolVersion":1,"kind":"ready","extra":true}\n',
    `${'x'.repeat(64 * 1024 + 1)}\n`,
  ]) {
    const { watcher, child, failures } = setup();
    const started = watcher.start();
    child.output(frame);
    await assert.rejects(started, /GJC session watcher failed\./u);
    assert.equal(failures.length, 1);
    assert.doesNotMatch(failures[0].message, /secret/u);
  }
  const { watcher, child, failures } = setup();
  await ready(watcher, child);
  child.output('{"protocolVersion":1,"kind":"ready"}\n');
  assert.equal(failures.length, 1);
});

test('reports unexpected exit only once and enforces ready timeout', async () => {
  const exited = setup();
  await ready(exited.watcher, exited.child);
  exited.child.emit('exit', 1, null);
  exited.child.emit('close', 1, null);
  assert.equal(exited.failures.length, 1);
  const timedOut = setup({ readyTimeoutMs: 1 });
  await assert.rejects(timedOut.watcher.start(), /GJC session watcher failed\./u);
  assert.equal(timedOut.failures.length, 1);
});

test('contains callback diagnostics and continues without exposing event paths', async () => {
  const diagnostics: string[] = [];
  const { watcher, child, failures } = setup({
    diagnostic: (message) => diagnostics.push(message),
    onEvent: () => {
      throw new Error('sensitive callback detail');
    },
  });
  await ready(watcher, child);
  child.output('{"protocolVersion":1,"kind":"event","event":"add","path":"secret-path"}\n');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(diagnostics, ['GJC session watcher callback failed.']);
  assert.equal(failures.length, 0);
  assert.doesNotMatch(diagnostics.join(' '), /secret-path|sensitive/u);
});

test('degrades to one resync when distinct queued paths exceed the fixed bound, without failing or naming paths', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const diagnostics: string[] = [];
  const events: string[] = [];
  const { watcher, child, failures } = setup({
    onEvent: async (event) => { events.push(event.path); if (event.path === 'blocking') await hold; },
    onResync: () => { events.push('<rescan>'); },
    diagnostic: (message) => diagnostics.push(message),
  });
  await ready(watcher, child);
  child.output('{"protocolVersion":1,"kind":"event","event":"add","path":"blocking"}\n');
  await Promise.resolve();

  child.output(Array.from({ length: 4097 }, (_, index) => (
    `{"protocolVersion":1,"kind":"event","event":"change","path":"queued-${index}"}\n`
  )).join(''));
  // Events after the overflow are queued behind the rescan and still delivered.
  child.output('{"protocolVersion":1,"kind":"event","event":"add","path":"after-gap"}\n');
  release();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(failures, []);
  assert.deepEqual(events, ['blocking', '<rescan>', 'after-gap'], 'one rescan after the blocking callback; the superseded backlog is dropped');
  assert.ok(diagnostics.some((message) => /overflowed/u.test(message)));
  assert.ok(diagnostics.every((message) => !/queued-|blocking|after-gap/u.test(message)));
});

test('a native resync frame drops the queued backlog, rescans once, then resumes ordinary events', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const { watcher, child, failures } = setup({
    onEvent: async (event) => { events.push(event.path); if (event.path === 'blocking') await hold; },
    onResync: () => { events.push('<rescan>'); },
  });
  await ready(watcher, child);
  child.output('{"protocolVersion":1,"kind":"event","event":"add","path":"blocking"}\n');
  await Promise.resolve();
  child.output('{"protocolVersion":1,"kind":"event","event":"change","path":"stale"}\n');
  child.output('{"protocolVersion":1,"kind":"resync"}\n{"protocolVersion":1,"kind":"resync"}\n');
  child.output('{"protocolVersion":1,"kind":"event","event":"add","path":"fresh"}\n');
  release();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(failures, []);
  assert.deepEqual(events, ['blocking', '<rescan>', 'fresh'], 'back-to-back resync frames collapse into one rescan');
});

test('a resync frame before readiness or with extra keys is a protocol violation', async () => {
  for (const [frame, primeReady] of [
    ['{"protocolVersion":1,"kind":"resync"}\n', false],
    ['{"protocolVersion":1,"kind":"resync","path":"secret-path"}\n', true],
  ] as const) {
    const { watcher, child, resyncs, failures } = setup();
    if (primeReady) await ready(watcher, child);
    else void watcher.start().catch(() => {});
    child.output(frame);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failures.length, 1, frame);
    assert.equal(failures[0].cause, 'protocol-violation');
    assert.doesNotMatch(failures[0].message, /secret-path/u);
    assert.deepEqual(resyncs, []);
  }
});

test('close cancels queued callbacks at its deadline and reaps a non-exiting child', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const callbacks: string[] = [];
  let callbackSignal: AbortSignal | undefined;
  const { watcher, child } = setup({
    closeDrainTimeoutMs: 1,
    closeExitTimeoutMs: 1,
    onEvent: (event, signal) => {
      callbacks.push(event.path);
      callbackSignal = signal;
      return hold;
    },
  });
  await ready(watcher, child);
  child.output('{"protocolVersion":1,"kind":"event","event":"add","path":"warmup"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  child.output('{"protocolVersion":1,"kind":"event","event":"add","path":"accepted"}\n');
  await watcher.close();

  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.deepEqual(callbacks, ['warmup']);
  assert.equal(callbackSignal?.aborted, true);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(callbacks, ['warmup']);
});

test('close before readiness rejects the pending start without reporting a runtime failure', async () => {
  const { watcher, failures } = setup();
  const started = watcher.start();
  const rejected = assert.rejects(started, /GJC session watcher failed\./u);
  await watcher.close();

  await rejected;
  assert.equal(failures.length, 0);
});

test('each failure mode reports its own reason code and nothing from the frame', async () => {
  for (const [frame, reason] of [
    ['{"protocolVersion":1,"kind":"event","event":"add","path":"secret-path"}\n', 'protocol-violation'],
    ['{"protocolVersion":1,"kind":"unknown"}\n', 'protocol-violation'],
    ['secret-path is not json\n', 'malformed-json'],
    [`${'x'.repeat(64 * 1024 + 1)}\n`, 'oversized-frame'],
  ] as const) {
    const { watcher, child, failures } = setup();
    const started = watcher.start();
    child.output(frame);

    await assert.rejects(started, /GJC session watcher failed\./u);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].cause, reason, frame.slice(0, 24));
    assert.doesNotMatch(failures[0].message, /secret-path/u);
  }
});

test('ready timeout and child exit stay distinguishable, exit status included', async () => {
  const timedOut = setup({ readyTimeoutMs: 1 });
  await assert.rejects(timedOut.watcher.start(), /GJC session watcher failed\./u);
  assert.equal(timedOut.failures[0].cause, 'ready-timeout');

  const exited = setup();
  await ready(exited.watcher, exited.child);
  exited.child.emit('exit', 3, null);
  exited.child.emit('close', 3, null);
  assert.equal(exited.failures.length, 1);
  assert.equal(exited.failures[0].cause, 'child-exit code=3 signal=none');

  const signalled = setup();
  await ready(signalled.watcher, signalled.child);
  signalled.child.emit('exit', null, 'SIGKILL');
  assert.equal(signalled.failures[0].cause, 'child-exit code=none signal=SIGKILL');
});

// #42: ENOSPC (inotify watch exhaustion) is a host condition no restart can fix.
// The child names it on stderr; only that fixed token is retained — the stderr
// content itself (which may carry transcript paths) is never forwarded.
test('detects the ENOSPC token on stderr without leaking stderr content', async () => {
  const diagnostics: string[] = [];
  const { watcher, child } = setup({ diagnostic: (message) => diagnostics.push(message) });
  await ready(watcher, child);

  assert.equal(watcher.enospcObserved, false);
  child.stderr.emit('data', Buffer.from('Error: ENOSPC: System limit for number of file watchers reached, watch \'/home/user/.gjc/agent/sessions/secret.jsonl\''));
  assert.equal(watcher.enospcObserved, true);
  assert.deepEqual(diagnostics, ['GJC session watcher emitted diagnostics.']);
  assert.doesNotMatch(diagnostics.join(' '), /secret/u);

  const clean = setup();
  await ready(clean.watcher, clean.child);
  clean.child.stderr.emit('data', Buffer.from('ordinary startup notice'));
  assert.equal(clean.watcher.enospcObserved, false);
});

test('failure diagnostics name the reason so a restart loop is diagnosable from logs alone', async () => {
  const diagnostics: string[] = [];
  const { watcher, child } = setup({ diagnostic: (message) => diagnostics.push(message) });
  const started = watcher.start();
  child.output('{"protocolVersion":1,"kind":"event","event":"add","path":"secret-path"}\n');

  await assert.rejects(started, /GJC session watcher failed\./u);
  assert.deepEqual(diagnostics, ['GJC session watcher failed. (protocol-violation)']);
  assert.doesNotMatch(diagnostics.join(' '), /secret-path/u);
});
