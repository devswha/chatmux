import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
        id: 'unicode-boundary',
        // Move the last chunk boundary inside the four-byte emoji, so decoding
        // individual chunks would corrupt the recovered title.
        body: `${metadata('unicode-boundary')}\n${completed('한글 🧪 완료')}${' '.repeat(CHUNK_BYTES - Buffer.byteLength('🧪 완료"}}') + 2)}`,
        title: '한글 🧪 완료',
      },
      { id: 'empty', body: '', title: null },
    ];
    for (const fixture of fixtures) {
      await writeFile(path.join(root, `${fixture.id}.jsonl`), fixture.body);
    }
    await writeFile(path.join(root, 'cases.json'), JSON.stringify(fixtures.map(({ id }) => id)));
    const result = spawnSync(process.execPath, [
      '--import', 'tsx',
      fileURLToPath(new URL('./support/codex-title-scan-probe.ts', import.meta.url)),
      root,
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
    const output = result.stdout.split('\n').find((line) => line.startsWith('TITLE_SCAN_RESULTS='));
    assert.ok(output, result.stdout);
    assert.deepEqual(JSON.parse(output.slice('TITLE_SCAN_RESULTS='.length)), fixtures.map(({ id, title }) => ({ id, title })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
