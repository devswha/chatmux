import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { GjcWorkerSupervisor } from './gjc-worker-client.js';
import {
  GJC_WINDOWS_JOB_GUARD_ACK,
  GJC_WINDOWS_JOB_GUARD_READY,
} from './gjc-windows-job.js';
import {
  GJC_WORKER_PROTOCOL_VERSION,
  GjcWorkerNdjsonDecoder,
  serializeGjcWorkerFrame,
  type GjcWorkerEventFrame,
  type GjcWorkerRequestFrame,
  type GjcWorkerResponseFrame,
  type JsonObject,
} from './gjc-worker-protocol.js';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0);
    return true;
  }
}

class FakePeer {
  readonly requests: GjcWorkerRequestFrame[] = [];
  readonly #decoder = new GjcWorkerNdjsonDecoder();
  #handler: (request: GjcWorkerRequestFrame) => void = () => {};

  constructor(readonly child: FakeChild, guarded = false) {
    let guardInput = Buffer.alloc(0);
    child.stdin.on('data', (chunk: Buffer) => {
      let protocolChunk = chunk;
      if (guarded) {
        guardInput = Buffer.concat([guardInput, chunk]);
        const newline = guardInput.indexOf(0x0a);
        if (newline < 0) return;
        assert.equal(
          guardInput.subarray(0, newline).toString('utf8'),
          GJC_WINDOWS_JOB_GUARD_ACK,
        );
        protocolChunk = guardInput.subarray(newline + 1);
        guardInput = Buffer.alloc(0);
        guarded = false;
      }
      if (protocolChunk.length === 0) return;
      for (const frame of this.#decoder.push(protocolChunk)) {
        assert.equal(frame.kind, 'request');
        const request = frame as GjcWorkerRequestFrame;
        this.requests.push(request);
        this.#handler(request);
      }
    });
  }

  handle(handler: (request: GjcWorkerRequestFrame) => void): void {
    this.#handler = handler;
  }

  respond(
    request: GjcWorkerRequestFrame,
    payload: GjcWorkerResponseFrame['payload'] = { ok: true },
  ): void {
    const frame = {
      protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
      kind: 'response',
      id: request.id,
      method: request.method,
      ...('sessionId' in request ? { sessionId: request.sessionId } : {}),
      payload,
    } as GjcWorkerResponseFrame;
    this.child.stdout.write(serializeGjcWorkerFrame(frame));
  }

  event(
    sessionId: string,
    runId: string,
    method: Exclude<GjcWorkerEventFrame['method'], 'worker.status'>,
    payload: JsonObject = {},
  ): void {
    const frame: GjcWorkerEventFrame = {
      protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      id: `event-${this.requests.length}-${Math.random()}`,
      method,
      sessionId,
      payload: { runId, ...payload },
    };
    this.child.stdout.write(serializeGjcWorkerFrame(frame));
  }

  status(sessionId: string, runId: string, processId: number | null): void {
    const frame: GjcWorkerEventFrame = {
      protocolVersion: GJC_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      id: `status-${this.requests.length}-${Math.random()}`,
      method: 'worker.status',
      sessionId,
      payload: { runId, processId },
    };
    this.child.stdout.write(serializeGjcWorkerFrame(frame));
  }

  async waitFor(
    method: GjcWorkerRequestFrame['method'],
    count = 1,
  ): Promise<GjcWorkerRequestFrame> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const matches = this.requests.filter((request) => request.method === method);
      if (matches.length >= count) return matches[count - 1];
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for ${method}.`);
  }
}

function runtime(child: FakeChild, scope = 'app-session-1') {
  return {
    spawn: () => child,
    corePath: '/test/gajae-core',
    workerPath: '/test/gjc-worker.js',
    compiled: true,
    createScope: () => scope,
    notifyRunStopped: () => {},
    notifyRunFailed: () => {},
  };
}

function replyToHandshake(peer: FakePeer): void {
  peer.handle((request) => {
    if (request.method === 'worker.initialize') peer.respond(request);
  });
}

test('launches the Windows worker behind an atomic kill-on-close job guard', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child, true);
  peer.handle((request) => peer.respond(request));
  let command = '';
  let args: string[] = [];
  let spawnOptions: {
    detached?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {};
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    platform: 'win32',
    environment: {
      SystemRoot: 'C:\\Windows',
      KEEP_ME: 'yes',
    },
    spawn: (workerCommand, workerArgs, options) => {
      command = workerCommand;
      args = workerArgs;
      spawnOptions = options;
      return child;
    },
  });

  const run = supervisor.spawn('hello', {}, { send() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peer.requests.length, 0);
  child.stdout.write(`${GJC_WINDOWS_JOB_GUARD_READY}\n`);
  await run;

  assert.equal(
    command,
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(args.at(-2), '-EncodedCommand');
  assert.equal(spawnOptions.detached, false);
  assert.equal(spawnOptions.env?.KEEP_ME, 'yes');
  assert.equal(
    spawnOptions.env?.GAJAE_INTERNAL_JOB_APPLICATION,
    '/test/gajae-core',
  );
  assert.equal(
    peer.requests.filter((request) => request.method === 'worker.initialize').length,
    1,
  );
  assert.match(
    spawnOptions.env?.GAJAE_INTERNAL_JOB_COMMAND_LINE ?? '',
    /gjc-worker\.js/,
  );
});

test('fails closed when the Windows job guard never proves app ownership', async () => {
  const child = new FakeChild();
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    initializeTimeoutMs: 5,
  });

  await assert.rejects(
    supervisor.spawn('hello', {}, { send() {} }),
    /GJC worker failed/,
  );

  assert.equal(child.killed, true);
});

test('shares one handshake and sends one start request per concurrent run', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  peer.handle((request) => peer.respond(request));
  let command = '';
  let args: string[] = [];
  let detached: boolean | undefined;
  let inheritedEnvironment = false;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    spawn: (workerCommand, workerArgs, options) => {
      command = workerCommand;
      args = workerArgs;
      detached = options.detached;
      inheritedEnvironment = options.env === process.env;
      return child;
    },
  });

  await Promise.all([
    supervisor.spawn('first', { sessionId: null, model: 'x' }, { send() {} }),
    supervisor.spawn('second', {}, { send() {} }),
  ]);

  assert.equal(peer.requests.filter((request) => request.method === 'worker.initialize').length, 1);
  const starts = peer.requests.filter((request) => request.method === 'session.start');
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0]?.payload, { message: 'first', options: { model: 'x' } });
  assert.equal(peer.requests.some((request) => request.method === 'turn.start'), false);
  assert.equal(detached, process.platform !== 'win32');
  assert.equal(inheritedEnvironment, true);
  assert.equal(command, '/test/gajae-core');
  assert.deepEqual(args, ['--', process.execPath, '/test/gjc-worker.js']);
});

test('wraps the source worker command without changing its tsx environment', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  peer.handle((request) => peer.respond(request));
  let args: string[] = [];
  let environment: NodeJS.ProcessEnv | undefined;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    compiled: false,
    workerPath: '/test/gjc-worker.ts',
    spawn: (_command, workerArgs, options) => {
      args = workerArgs;
      environment = options.env;
      return child;
    },
  });

  await supervisor.spawn('source', {}, { send() {} });

  assert.deepEqual(args, [
    '--',
    process.execPath,
    '--import',
    'tsx',
    '/test/gjc-worker.ts',
  ]);
  assert.match(environment?.TSX_TSCONFIG_PATH ?? '', /server\/tsconfig\.json$/u);
});

test('fails safely when the native core cannot launch without a Node fallback', async () => {
  const commands: string[] = [];
  const supervisor = new GjcWorkerSupervisor({
    corePath: '/missing/gajae-core',
    workerPath: '/test/gjc-worker.js',
    compiled: true,
    spawn: (command) => {
      commands.push(command);
      throw new Error('missing');
    },
    notifyRunStopped: () => {},
    notifyRunFailed: () => {},
  });

  await assert.rejects(
    supervisor.spawn('hello', {}, { send() {} }),
    /GJC worker failed/,
  );
  assert.deepEqual(commands, ['/missing/gajae-core']);
});

test('resumes by provider session and forwards events using immutable run identity', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const messages: unknown[] = [];
  let providerSessionId = '';
  const supervisor = new GjcWorkerSupervisor(runtime(child, 'app-2'));
  const run = supervisor.spawn('hello', { sessionId: 'provider-old' }, {
    send: (value) => messages.push(value),
    setSessionId: (id) => { providerSessionId = id; },
  });
  const request = await peer.waitFor('session.resume');

  assert.deepEqual(request.payload, {
    message: 'hello',
    options: {},
    providerSessionId: 'provider-old',
  });
  peer.event('app-2', request.id, 'session.created', { providerSessionId: 'provider-new' });
  peer.event('app-2', request.id, 'message.delta', {
    message: { kind: 'stream_delta', content: 'kept' },
  });
  peer.respond(request);
  await run;

  assert.equal(providerSessionId, 'provider-new');
  assert.deepEqual(
    messages.filter((message) => (message as { kind?: string }).kind === 'stream_delta'),
    [{ kind: 'stream_delta', content: 'kept' }],
  );
});

test('aborting before the start request prevents the run from reaching the worker', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  const supervisor = new GjcWorkerSupervisor(runtime(child, 'app-prestart'));
  const run = supervisor.spawn('hello', {}, { send() {} });

  assert.equal(await supervisor.abort(run.abortHandle), true);
  peer.respond(await peer.waitFor('worker.initialize'));
  await run;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(peer.requests.some((request) => request.method === 'session.start'), false);
  assert.equal(peer.requests.some((request) => request.method === 'turn.abort'), false);
});

test('aborts an issued run by runId and waits for its terminal start response', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const supervisor = new GjcWorkerSupervisor(runtime(child, 'app-abort'));
  const run = supervisor.spawn('hello', {}, { send() {} });
  const start = await peer.waitFor('session.start');
  let settled = false;
  void run.then(() => { settled = true; });

  const abortResult = supervisor.abort(run.abortHandle);
  const abort = await peer.waitFor('turn.abort');
  assert.deepEqual(abort.payload, { runId: start.id });
  peer.respond(abort, { ok: true, result: { runId: start.id, aborted: true } });
  assert.equal(await abortResult, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  peer.respond(start, { ok: true, result: { runId: start.id } });
  await run;
  assert.equal(settled, true);
});

test('keeps a run active when the worker cannot confirm abort', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const supervisor = new GjcWorkerSupervisor(runtime(child, 'app-abort-failed'));
  const run = supervisor.spawn('hello', {}, { send() {} });
  const start = await peer.waitFor('session.start');

  const abortResult = supervisor.abort(run.abortHandle);
  const abort = await peer.waitFor('turn.abort');
  peer.respond(abort, {
    ok: true,
    result: { runId: start.id, aborted: false },
  });

  assert.equal(await abortResult, false);
  assert.equal(supervisor.isActive(run.abortHandle), true);
  peer.respond(start);
  await run;
});

test('mirrors approval replay, reply, and cancellation in app-owned state', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const messages: unknown[] = [];
  const supervisor = new GjcWorkerSupervisor(runtime(child, 'app-approval'));
  const run = supervisor.spawn('hello', {}, { send: (value) => messages.push(value) });
  const start = await peer.waitFor('session.start');
  const approval = { kind: 'permission_request', requestId: 'request-1', toolName: 'Bash' };

  peer.event('app-approval', start.id, 'ask.presented', { message: approval });
  assert.deepEqual(supervisor.pendingApprovals('app-approval'), [approval]);
  assert.equal(supervisor.resolveApproval('request-1', { allow: true }), true);
  const reply = await peer.waitFor('ask.reply');
  assert.deepEqual(reply.payload, {
    runId: start.id,
    requestId: 'request-1',
    decision: { allow: true },
  });
  peer.respond(reply, { ok: true, result: { runId: start.id, accepted: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.pendingApprovals('app-approval').length, 0);

  const retryableApproval = { kind: 'permission_request', requestId: 'request-2' };
  peer.event('app-approval', start.id, 'ask.presented', {
    message: retryableApproval,
  });
  assert.equal(supervisor.resolveApproval('request-2', { allow: false }), true);
  const rejectedReply = await peer.waitFor('ask.reply', 2);
  peer.respond(rejectedReply, {
    ok: true,
    result: { runId: start.id, accepted: false },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(supervisor.pendingApprovals('app-approval'), [retryableApproval]);
  assert.equal(
    messages.filter((message) => (
      message as { requestId?: string }
    ).requestId === 'request-2').length,
    2,
  );

  peer.event('app-approval', start.id, 'ask.presented', {
    message: { kind: 'permission_cancelled', requestId: 'request-2' },
  });
  assert.equal(supervisor.pendingApprovals('app-approval').length, 0);
  peer.respond(start);
  await run;
});

test('malformed worker output fails active work once and starts a fresh generation later', async () => {
  const first = new FakeChild();
  const second = new FakeChild();
  const firstPeer = new FakePeer(first);
  const secondPeer = new FakePeer(second);
  replyToHandshake(firstPeer);
  secondPeer.handle((request) => secondPeer.respond(request));
  const children = [first, second];
  let spawnCalls = 0;
  const sent: unknown[] = [];
  const ownedProcessKills: number[] = [];
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(first),
    spawn: () => children[spawnCalls++]!,
    killProcessTree: (processId) => { ownedProcessKills.push(processId); },
    notifyRunFailed: () => {
      throw new Error('notification unavailable');
    },
    diagnostic: () => {
      throw new Error('diagnostic unavailable');
    },
  });
  const run = supervisor.spawn('hello', {}, { send: (value) => sent.push(value) });
  const firstStart = await firstPeer.waitFor('session.start');
  firstPeer.status('app-session-1', firstStart.id, 4_242);

  first.stdout.write('not-json\n');
  await assert.rejects(run, /GJC worker failed/);
  assert.equal(first.killed, true);
  assert.equal(sent.filter((value) => (value as { kind?: string }).kind === 'complete').length, 1);
  assert.deepEqual(ownedProcessKills, [4_242]);

  await supervisor.spawn('again', {}, { send() {} });
  assert.equal(spawnCalls, 2);
});

test('worker exit waits for tree termination before starting a fresh generation', async () => {
  const first = new FakeChild();
  const second = new FakeChild();
  const firstPeer = new FakePeer(first);
  const secondPeer = new FakePeer(second);
  secondPeer.handle((request) => secondPeer.respond(request));
  const children = [first, second];
  let spawnCalls = 0;
  let releaseTermination!: () => void;
  const termination = new Promise<void>((resolve) => {
    releaseTermination = resolve;
  });
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(first),
    spawn: () => children[spawnCalls++]!,
    killTree: () => termination,
  });
  const failedRun = supervisor.spawn('first', {}, { send() {} });
  const failure = assert.rejects(failedRun, /GJC worker failed/);
  await firstPeer.waitFor('worker.initialize');

  first.emit('exit', 1);
  const replacement = supervisor.spawn('second', {}, { send() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnCalls, 1);
  releaseTermination();

  await Promise.all([failure, replacement]);
  assert.equal(spawnCalls, 2);
});

test('failed tree cleanup permanently blocks a replacement worker generation', async () => {
  const first = new FakeChild();
  const firstPeer = new FakePeer(first);
  replyToHandshake(firstPeer);
  let spawnCalls = 0;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(first),
    spawn: () => {
      spawnCalls += 1;
      return first;
    },
    killTree: () => Promise.reject(new Error('tree still alive')),
  });
  const failedRun = supervisor.spawn('first', {}, { send() {} });
  await firstPeer.waitFor('session.start');

  first.stdout.write('not-json\n');
  await assert.rejects(failedRun, /GJC worker failed/);
  await assert.rejects(
    supervisor.spawn('replacement', {}, { send() {} }),
    /GJC worker failed/,
  );

  assert.equal(spawnCalls, 1);
});

test('a timed-out auxiliary request does not corrupt other request correlation', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    requestTimeoutMs: 5,
  });
  const run = supervisor.spawn('hello', {}, { send() {} });
  const start = await peer.waitFor('session.start');

  peer.event('app-session-1', start.id, 'ask.presented', {
    message: { kind: 'permission_request', requestId: 'request-timeout' },
  });
  assert.equal(supervisor.resolveApproval('request-timeout', { allow: true }), true);
  const timedOutReply = await peer.waitFor('ask.reply');
  await new Promise((resolve) => setTimeout(resolve, 15));
  peer.respond(timedOutReply);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.killed, false);

  peer.event('app-session-1', start.id, 'ask.presented', {
    message: { kind: 'permission_request', requestId: 'request-success' },
  });
  assert.equal(supervisor.resolveApproval('request-success', { allow: true }), true);
  const successfulReply = await peer.waitFor('ask.reply', 2);
  peer.respond(successfulReply);
  peer.respond(start);
  await run;
  assert.equal(child.killed, false);
});

test('ignores stale events when a later run reuses the same app scope', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const messages: unknown[] = [];
  const supervisor = new GjcWorkerSupervisor(runtime(child, 'shared-app'));
  const writer = { send: (value: unknown) => messages.push(value) };

  const oldRun = supervisor.spawn('old', {}, writer);
  const oldStart = await peer.waitFor('session.start');
  peer.respond(oldStart);
  await oldRun;

  const newRun = supervisor.spawn('new', {}, writer);
  const newStart = await peer.waitFor('session.start', 2);
  peer.event('shared-app', oldStart.id, 'message.delta', {
    message: { kind: 'stream_delta', content: 'stale' },
  });
  peer.event('shared-app', newStart.id, 'message.delta', {
    message: { kind: 'stream_delta', content: 'current' },
  });
  peer.respond(newStart);
  await newRun;

  assert.deepEqual(
    messages.filter((message) => (message as { kind?: string }).kind === 'stream_delta'),
    [{ kind: 'stream_delta', content: 'current' }],
  );
});

test('forwards one worker terminal event without synthesizing a duplicate', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const sent: unknown[] = [];
  let failures = 0;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child, 'app-terminal'),
    notifyRunFailed: () => { failures += 1; },
  });
  const run = supervisor.spawn('hello', {}, { send: (value) => sent.push(value) });
  const start = await peer.waitFor('session.start');
  const terminal = { kind: 'complete', provider: 'gjc', exitCode: 1 };

  peer.event('app-terminal', start.id, 'turn.failed', { message: terminal });
  peer.respond(start, { ok: false, error: { code: 'run_failed', message: 'safe' } });
  await assert.rejects(run, /GJC worker failed/);

  assert.deepEqual(sent, [terminal]);
  assert.equal(failures, 1);
});

test('completed terminal event remains authoritative if the worker exits before its response', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  const sent: unknown[] = [];
  let stopped = 0;
  let failed = 0;
  const ownedProcessKills: number[] = [];
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child, 'app-terminal-exit'),
    notifyRunStopped: () => { stopped += 1; },
    notifyRunFailed: () => { failed += 1; },
    killProcessTree: (processId) => { ownedProcessKills.push(processId); },
  });
  const run = supervisor.spawn('hello', {}, { send: (value) => sent.push(value) });
  const start = await peer.waitFor('session.start');
  const terminal = { kind: 'complete', provider: 'gjc', exitCode: 0 };

  peer.event('app-terminal-exit', start.id, 'turn.completed', { message: terminal });
  peer.status('app-terminal-exit', start.id, 4_242);
  peer.status('app-terminal-exit', start.id, null);
  child.emit('exit', 1);
  await run;

  assert.deepEqual(sent, [terminal]);
  assert.equal(stopped, 1);
  assert.equal(failed, 0);
  assert.deepEqual(ownedProcessKills, []);
});

test('graceful shutdown waits for the worker response then terminates its process tree', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  let stopped = 0;
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child, 'app-shutdown'),
    notifyRunStopped: () => { stopped += 1; },
  });
  const run = supervisor.spawn('hello', {}, { send() {} });
  const start = await peer.waitFor('session.start');
  const shutdownPromise = supervisor.shutdown();
  const shutdown = await peer.waitFor('worker.shutdown');

  assert.equal(child.killed, false);
  peer.respond(start);
  peer.respond(shutdown);
  await Promise.all([run, shutdownPromise]);

  assert.equal(stopped, 1);
  assert.equal(child.killed, true);
  await assert.rejects(
    supervisor.spawn('too-late', {}, { send() {} }),
    /GJC worker failed/,
  );
});

test('shutdown waits for in-flight exit cleanup and propagates its failure', async () => {
  const child = new FakeChild();
  const peer = new FakePeer(child);
  replyToHandshake(peer);
  let rejectTermination!: (error: Error) => void;
  const termination = new Promise<void>((_resolve, reject) => {
    rejectTermination = reject;
  });
  const supervisor = new GjcWorkerSupervisor({
    ...runtime(child),
    killTree: () => termination,
  });
  const run = supervisor.spawn('hello', {}, { send() {} });
  const start = await peer.waitFor('session.start');
  peer.respond(start);
  await run;

  const shutdownPromise = supervisor.shutdown();
  await peer.waitFor('worker.shutdown');
  child.emit('exit', 1);
  let settled = false;
  void shutdownPromise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  rejectTermination(new Error('tree still alive'));
  await assert.rejects(shutdownPromise, /GJC worker failed/);
});
