import assert from 'node:assert/strict';
import test from 'node:test';

import { FLEET_PROTOCOL_VERSION, FLEET_TOOL_RESULT_CHUNK_BYTES } from '../../../../shared/fleet.js';
import { encodeFleetFrame, FLEET_MAX_FRAME_BYTES } from '../protocol/codec.js';
import { createToolResultReader } from '../rpc/reads/tool-result.js';

const signal = (): AbortSignal => new AbortController().signal;
const first = { toolId: 'tool', offset: 0, revision: null };

test('full tool output crosses the fleet bound in complete UTF-8 chunks without repeated reads', async () => {
  const content = `peer-a-${'한😀\u0001'.repeat(15_000)}-end`;
  let reads = 0;
  const read = createToolResultReader({ identity: () => 'session-generation', read: async () => { reads += 1; return { toolResult: { content, isError: true } }; } });
  let offset = 0;
  let revision: string | null = null;
  const parts: string[] = [];
  while (true) {
    const part = await read('session', { ...first, offset, revision }, signal());
    assert.equal(part.isError, true);
    assert.equal(part.content.includes('\ufffd'), false);
    assert.ok(Buffer.byteLength(part.content) <= FLEET_TOOL_RESULT_CHUNK_BYTES);
    const frame = encodeFleetFrame({ kind: 'response', protocolVersion: FLEET_PROTOCOL_VERSION, connectionGeneration: 1,
      requestId: 'read-tool', target: { kind: 'session', hostId: '11111111-1111-4111-8111-111111111111', localId: 'session' },
      status: 'success', sideEffect: 'none', body: part });
    assert.ok(Buffer.byteLength(frame) <= FLEET_MAX_FRAME_BYTES);
    parts.push(part.content);
    revision = part.revision;
    if (part.nextOffset === null) break;
    assert.ok(part.nextOffset > offset);
    offset = part.nextOffset;
  }
  assert.equal(parts.join(''), content);
  assert.ok(parts.length > 1);
  assert.equal(reads, 1);
});

test('tool snapshot rejects another target, a replaced session, and invalid byte offsets', async () => {
  let identity: string | null = 'original';
  const read = createToolResultReader({ identity: () => identity, read: async () => ({ toolResult: { content: '한'.repeat(5000) } }) });
  const part = await read('a', first, signal());
  await assert.rejects(read('b', { ...first, revision: part.revision }, signal()), /target does not match/);
  await assert.rejects(read('a', { ...first, toolId: 'other', revision: part.revision }, signal()), /target does not match/);
  await assert.rejects(read('a', { ...first, offset: 1, revision: part.revision }, signal()), /byte offset/);
  await assert.rejects(read('a', { ...first, offset: part.totalBytes + 1, revision: part.revision }, signal()), /byte offset/);
  identity = 'replacement';
  await assert.rejects(read('a', { ...first, revision: part.revision }, signal()), /target does not match/);
  identity = null;
  await assert.rejects(read('a', { ...first, revision: part.revision }, signal()), /session was not found/);
});

test('an expired tool snapshot cannot mix changed output with an earlier revision', async () => {
  let now = 0;
  let content = 'a'.repeat(9000);
  const read = createToolResultReader({ identity: () => 'original', now: () => now, read: async () => ({ toolResult: { content } }) });
  const part = await read('a', first, signal());
  now = 60_001;
  content = 'b'.repeat(9000);
  await assert.rejects(read('a', { ...first, offset: part.nextOffset!, revision: part.revision }, signal()), /revision changed/);
  assert.equal((await read('a', first, signal())).content, 'b'.repeat(8192));
});

test('empty and structured outputs preserve their serialized content and aborted reads do not run', async () => {
  let reads = 0;
  const read = createToolResultReader({ identity: () => 'original', read: async (_id, toolId) => { reads += 1; return { toolResult: { content: toolId === 'empty' ? '' : { answer: 42 } } }; } });
  const empty = await read('a', { ...first, toolId: 'empty' }, signal());
  assert.equal(empty.nextOffset, null);
  assert.equal(empty.totalBytes, 0);
  const json = await read('a', first, signal());
  assert.equal(json.content, JSON.stringify({ answer: 42 }, null, 2));
  await assert.rejects(read('a', first, AbortSignal.abort()));
  assert.equal(reads, 2);
});
