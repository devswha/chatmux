import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CHUNK_BYTES = 256 * 1024;
const completed = (title: string) => JSON.stringify({
  type: 'event_msg', payload: { type: 'task_complete', last_agent_message: title },
});
const metadata = (id: string) => JSON.stringify({
  type: 'session_meta', payload: { id, cwd: '/synthetic/codex-title-scan' },
});

const runProbe = (root: string, measureCopies = false): string => {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx',
    fileURLToPath(new URL('./support/codex-title-scan-probe.ts', import.meta.url)),
    root,
    ...(measureCopies ? ['--measure-copies'] : []),
  ], {
    env: {
      ...process.env,
      DATABASE_PATH: path.join(root, 'auth.db'),
      TSX_TSCONFIG_PATH: 'server/tsconfig.json',
    },
    encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, `Title scan exceeded its process deadline: ${result.error?.message}`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};

// The watchdog belongs to the parent process: a same-thread test timeout cannot
// interrupt a synchronous loop that has starved Node's event loop.
test('Codex title scanning terminates at blank-line and chunk boundaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatmux-codex-title-boundaries-'));
  try {
    const event = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } });
    const alignedTail = `\n${event}${' '.repeat(CHUNK_BYTES - Buffer.byteLength(event) - 2)}\n`;
    assert.equal(Buffer.byteLength(alignedTail), CHUNK_BYTES);

    const fixtures = [
      { id: 'leading-blank', body: `\n${metadata('leading-blank')}\n`, title: 'Untitled Codex Session' },
      { id: 'blank-tail', body: `${metadata('blank-tail')}\n\n\n`, title: 'Untitled Codex Session' },
      {
        id: 'aligned-completed',
        body: `${metadata('aligned-completed')}\n${completed('Older title')}\n${completed('Latest completed title')}\n${alignedTail}`,
        title: 'Latest completed title',
      },
      {
        id: 'aligned-untitled',
        body: `${metadata('aligned-untitled')}\n${alignedTail}`,
        title: 'Untitled Codex Session',
      },
      {
        id: 'several-aligned-chunks',
        body: `${metadata('several-aligned-chunks')}\n${completed('Before three chunks')}\n${alignedTail.repeat(3)}`,
        title: 'Before three chunks',
      },
      {
        id: 'malformed-and-partial',
        body: `${metadata('malformed-and-partial')}\r\n${completed('Valid before partial tail')}\r\nnull\n{invalid\n{"type":"event_msg","payload":`,
        title: 'Valid before partial tail',
      },
      {
        id: 'unterminated-title',
        body: `${metadata('unterminated-title')}\n${completed('No trailing newline')}`,
        title: 'No trailing newline',
      },
      {
        id: 'blank-index-name',
        body: `${metadata('blank-index-name')}\n${completed('Fallback after blank index name')}\n`,
        title: 'Fallback after blank index name',
      },
      {
        id: 'named-index',
        body: `${metadata('named-index')}\n${completed('Lower-priority completed title')}\n`,
        title: 'Saved index title',
      },
      {
        id: 'unicode-boundary',
        // Move the last chunk boundary inside the four-byte emoji, so decoding
        // individual chunks would corrupt the recovered title.
        body: `${metadata('unicode-boundary')}\n${completed('한글 🧪 완료')}${' '.repeat(CHUNK_BYTES - Buffer.byteLength('🧪 완료"}}') + 2)}`,
        title: '한글 🧪 완료',
      },
      { id: 'empty', body: '', title: null },
    ];
    await mkdir(path.join(root, '.codex'));
    await writeFile(path.join(root, '.codex', 'session_index.jsonl'), [
      JSON.stringify({ id: 'blank-index-name', thread_name: ' \t\r\n ' }),
      JSON.stringify({ id: 'named-index', thread_name: ' Saved index title ' }),
      '',
    ].join('\n'));
    for (const fixture of fixtures) {
      await writeFile(path.join(root, `${fixture.id}.jsonl`), fixture.body);
    }
    await writeFile(path.join(root, 'cases.json'), JSON.stringify(fixtures.map(({ id }) => id)));
    const stdout = runProbe(root);
    const output = stdout.split('\n').find((line) => line.startsWith('TITLE_SCAN_RESULTS='));
    assert.ok(output, stdout);
    assert.deepEqual(JSON.parse(output.slice('TITLE_SCAN_RESULTS='.length)), fixtures.map(({ id, title }) => ({ id, title })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex title scanning bounds multi-chunk record copies and preserves complete titles', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatmux-codex-title-copies-'));
  try {
    const longTitle = `한글 🧪 ${'x'.repeat(8 * CHUNK_BYTES)} 완료`;
    const fixtures = [
      {
        id: 'large-tool-output',
        tail: JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(32 * CHUNK_BYTES) } }),
        title: 'Before the long record',
      },
      { id: 'large-completed', tail: completed(longTitle), title: longTitle.slice(0, 120) },
      { id: 'large-partial', tail: `{"type":"event_msg","payload":"${'x'.repeat(8 * CHUNK_BYTES)}`, title: 'Before the long record' },
    ];
    const sizes = new Map<string, number>();
    for (const { id, tail } of fixtures) {
      const body = `${metadata(id)}\n${completed('Before the long record')}\n${tail}`;
      sizes.set(id, Buffer.byteLength(body));
      await writeFile(path.join(root, `${id}.jsonl`), body);
    }
    await writeFile(path.join(root, 'cases.json'), JSON.stringify(fixtures.map(({ id }) => id)));
    const stdout = runProbe(root, true);
    const output = stdout.split('\n').find((line) => line.startsWith('TITLE_SCAN_RESULTS='));
    const copies = stdout.split('\n').find((line) => line.startsWith('TITLE_SCAN_COPIES='));
    assert.ok(output, stdout);
    assert.ok(copies, stdout);
    assert.deepEqual(JSON.parse(output.slice('TITLE_SCAN_RESULTS='.length)), fixtures.map(({ id, title }) => ({ id, title })));
    // Count bytes instead of timing: repeated concatenation of an unfinished
    // record copies quadratically even when a fast machine meets the deadline.
    for (const { id, copiedBytes } of JSON.parse(copies.slice('TITLE_SCAN_COPIES='.length))) {
      assert.ok(copiedBytes <= 2 * sizes.get(id)!, `${id}: copied ${copiedBytes} bytes for a ${sizes.get(id)}-byte transcript`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
