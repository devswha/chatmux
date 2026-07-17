import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const executable = process.platform === 'win32' ? 'gajae-core.exe' : 'gajae-core';
const corePath = fileURLToPath(new URL(`../dist-native/${executable}`, import.meta.url));

type CoreResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
};

function runCore(
  args: string[],
  chunks: Buffer[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CoreResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(corePath, args, {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('gajae-core test timed out.'));
    }, 5_000);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => {
      // Some tests intentionally make the proxied child close stdin early.
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    for (const chunk of chunks) child.stdin.write(chunk);
    child.stdin.end();
  });
}

test('native core reports its pinned binary identity', async () => {
  const result = await runCore(['--version']);

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.stdout.toString('utf8'), /^gajae-core 0\.2\.0\n$/u);
  assert.equal(result.stderr.length, 0);
});

test('native core recursively watches multiple roots and filters non-transcript files', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'gajae-core-watch-'));
  const firstRoot = path.join(temporaryRoot, 'first');
  const secondRoot = path.join(temporaryRoot, 'second');
  await Promise.all([
    mkdir(firstRoot, { recursive: true }),
    mkdir(secondRoot, { recursive: true }),
  ]);

  const child = spawn(corePath, [
    'watch',
    '--root',
    firstRoot,
    '--root',
    secondRoot,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames: Array<Record<string, unknown>> = [];
  let buffered = '';
  let diagnostics = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line) frames.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  child.stderr.on('data', (chunk: string) => {
    diagnostics += chunk;
  });
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('native watcher process timed out.'));
      }, 10_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    },
  );
  const waitForFrame = async (
    predicate: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const frame = frames.find(predicate);
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for native watcher frame.');
  };

  try {
    await waitForFrame((frame) => frame.kind === 'ready');
    const nested = path.join(firstRoot, 'workspace');
    await mkdir(nested);
    await writeFile(path.join(nested, 'ignored.txt'), 'ignored', 'utf8');
    const transcript = path.join(nested, 'session.jsonl');
    await writeFile(transcript, '{"type":"session"}\n', 'utf8');
    await waitForFrame((frame) => frame.kind === 'event' && frame.path === transcript);

    const priorTranscriptEvents = frames.filter((frame) => frame.path === transcript).length;
    await appendFile(transcript, '{"type":"message"}\n', 'utf8');
    await waitForFrame((_frame) => (
      frames.filter((frame) => frame.path === transcript).length > priorTranscriptEvents
    ));

    child.stdin.end();
    assert.deepEqual(await completed, { code: 0, signal: null });
    assert.equal(diagnostics, '');
    assert.equal(buffered, '');
    assert.equal(
      frames.some((frame) => typeof frame.path === 'string' && frame.path.endsWith('ignored.txt')),
      false,
    );
    assert.equal(
      frames.filter((frame) => frame.kind === 'event').every((frame) => (
        frame.event === 'add' || frame.event === 'change'
      )),
      true,
    );
  } finally {
    child.kill('SIGKILL');
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('native core relays bytes and child diagnostics without a shell', async () => {
  const script = [
    "process.stdin.on('data', (chunk) => process.stdout.write(chunk));",
    "process.stdin.on('end', () => { process.stderr.write('child diagnostic\\n'); process.exit(7); });",
  ].join('');
  const chunks = [
    Buffer.from('{"protocolVersion":1,"kind":"request"}\n'),
    Buffer.from('split-utf8-'),
    Buffer.from('한글\n'),
  ];
  const result = await runCore([
    '--',
    process.execPath,
    '--input-type=module',
    '--eval',
    script,
  ], chunks);

  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
  assert.deepEqual(result.stdout, Buffer.concat(chunks));
  assert.equal(result.stderr.toString('utf8'), 'child diagnostic\n');
});

test('native core preserves a successful child status after child stdin closes', async () => {
  const script = "process.stdin.destroy(); setTimeout(() => process.exit(0), 50);";
  const result = await runCore([
    '--',
    process.execPath,
    '--input-type=module',
    '--eval',
    script,
  ], [Buffer.alloc(1024 * 1024, 0x61)]);

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr.length, 0);
});

test('native core fails safely when its child executable is unavailable', async () => {
  const result = await runCore([
    '--',
    '/definitely/missing/gajae-worker-executable',
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.toString('utf8'), 'gajae-core: spawn failed\n');
});

test('native core carries the real worker initialize and shutdown protocol', async () => {
  const workerPath = fileURLToPath(new URL('./gjc-worker.ts', import.meta.url));
  const child = spawn(corePath, [
    '--',
    process.execPath,
    '--import',
    'tsx',
    workerPath,
  ], {
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: fileURLToPath(new URL('./tsconfig.json', import.meta.url)),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses: Array<{ id?: string; payload?: { ok?: boolean } }> = [];
  let pending = '';
  let diagnostics = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { diagnostics += chunk; });
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('native worker protocol test timed out.'));
      }, 5_000);
      child.stdout.on('data', (chunk: string) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          const response = JSON.parse(line) as { id?: string; payload?: { ok?: boolean } };
          responses.push(response);
          if (response.id === 'initialize' && response.payload?.ok === true) {
            child.stdin.write(`${JSON.stringify({
              protocolVersion: 1,
              kind: 'request',
              id: 'shutdown',
              method: 'worker.shutdown',
              payload: {},
            })}\n`);
          }
          if (response.id === 'shutdown' && response.payload?.ok === true) {
            child.stdin.end();
          }
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    },
  );

  child.stdin.write(`${JSON.stringify({
    protocolVersion: 1,
    kind: 'request',
    id: 'initialize',
    method: 'worker.initialize',
    payload: {},
  })}\n`);
  const exit = await completed;

  assert.deepEqual(exit, { code: 0, signal: null });
  assert.deepEqual(responses.map((response) => response.id), ['initialize', 'shutdown']);
  assert.equal(diagnostics, '');
});

test('native job authority enforces leases and idempotent ordered replay', async () => {
  const lease = { owner: 'worker-a', generation: 1 };
  const frames = [
    { protocolVersion: 1, id: 'create', method: 'job.create', jobId: 'job-1' },
    { protocolVersion: 1, id: 'acquire', method: 'lease.acquire', jobId: 'job-1', owner: 'worker-a' },
    { protocolVersion: 1, id: 'start', method: 'job.transition', jobId: 'job-1', lease, state: 'running' },
    {
      protocolVersion: 1,
      id: 'event-1',
      method: 'event.append',
      jobId: 'job-1',
      lease,
      eventId: 'message-1',
      payload: { text: 'hello' },
    },
    {
      protocolVersion: 1,
      id: 'event-1-retry',
      method: 'event.append',
      jobId: 'job-1',
      lease,
      eventId: 'message-1',
      payload: { text: 'hello' },
    },
    { protocolVersion: 1, id: 'replay', method: 'event.replay', jobId: 'job-1', after: 0 },
    { protocolVersion: 1, id: 'reconcile', method: 'job.reconcile' },
  ];
  const result = await runCore(
    ['jobs'],
    [Buffer.from(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n')],
  );

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr.length, 0);
  const responses = result.stdout.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(responses.map((response) => response.id), frames.map((frame) => frame.id));
  assert.deepEqual(responses[1].result, lease);
  assert.equal(responses[2].result.state, 'running');
  assert.deepEqual(responses[3].result, responses[4].result);
  assert.deepEqual(responses[5].result, [{
    sequence: 1,
    eventId: 'message-1',
    payload: { text: 'hello' },
  }]);
  assert.equal(responses[6].result[0].state, 'interrupted');
  assert.equal(responses[6].result[0].lease, null);
});
