import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import Database from 'better-sqlite3';

import { codexRenderAnchor, normalizeCodexDisplayText, readCodexForkTranscript, readCodexRenderAnchor, selectCodexForkByDisplay } from '../services/external-cli-sessions/codex-fork-inference.js';
import { applyInferredProviderSessionIds } from '../services/external-cli-sessions/provider-runtime-inference.js';
import { assertProvenSessionBinding } from '../services/tmux-session-binding.service.js';
import { tmuxPaneIdentityKey } from '../../../../shared/tmux.js';

const parent = '019fb5d7-1bd6-7b11-a95b-dfc5da6193de';
const child = '01a09a56-518a-7d92-83d8-e7a7de0d3e5f';
const sibling = '01a09a35-5c5f-7830-94f7-4a1854613531';
const message = '분기된 대화를 해당 터미널 화면과 대조합니다. 같은 작업폴더에서 동시에 실행 중인 다른 창을 선택하지 않고 현재 창의 최신 답변을 확인합니다. 직접적인 세션 ID 증명이 없으므로 자동 승인 권한은 부여하지 않습니다.';
const delta = (text: string) => `push_delta: ${JSON.stringify(text)}`;
const anchor = normalizeCodexDisplayText(message).slice(-96);

test('render anchor joins streamed deltas and normalizes Markdown and Korean whitespace', () => {
  assert.equal(codexRenderAnchor([delta(message.slice(0,40)), delta(message.slice(40))]), anchor);
  assert.equal(normalizeCodexDisplayText('**연결** · A\n B'), '연결AB');
});

test('render anchor does not concatenate separate short assistant messages', () => {
  assert.equal(codexRenderAnchor([delta(message), 'ConsolidateAgentMessage: source_len=180', delta('네, 확인했습니다.')]), null);
  assert.equal(codexRenderAnchor([delta(message), 'ConsolidateAgentMessage: source_len=180']), anchor);
  assert.equal(codexRenderAnchor([delta(message), 'push_delta: "broken', delta('짧은 답변')]), null);
  assert.equal(codexRenderAnchor([delta('a'.repeat(300))]), null);
});

test('display matching requires both the exact pane output and a unique candidate', () => {
  const candidates = [{ id: child, messages: [message] }, { id: sibling, messages: ['unrelated transcript'] }];
  assert.equal(selectCodexForkByDisplay({ anchor, paneOutput: message, candidates }), child);
  assert.equal(selectCodexForkByDisplay({ anchor, paneOutput: 'another pane', candidates }), null);
  assert.equal(selectCodexForkByDisplay({ anchor, paneOutput: message, candidates: [...candidates, { id: sibling, messages: [message] }] }), null);
  assert.equal(selectCodexForkByDisplay({ anchor: 'too short', paneOutput: message, candidates }), null);
});

test('a new Codex welcome card invalidates matching old scrollback', () => {
  const candidates = [{ id: child, messages: [message] }];
  assert.equal(selectCodexForkByDisplay({ anchor, paneOutput: `${message}\n│ >_ OpenAI Codex (v0.154.0) │\n› Ask anything`, candidates }), null);
  assert.equal(selectCodexForkByDisplay({ anchor, paneOutput: `OpenAI Codex (v0.154.0)\n${message}`, candidates }), child);
});

test('log reader is process-generation scoped and does not require recent wall-clock activity', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE logs(id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, process_uuid TEXT, thread_id TEXT, target TEXT, feedback_log_body TEXT);
      CREATE INDEX idx_logs_process_uuid_threadless_ts ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC) WHERE thread_id IS NULL;`);
    const insert = db.prepare('INSERT INTO logs VALUES (?, ?, 0, ?, ?, ?, ?)');
    insert.run(1, 101, 'pid:10:old', null, 'codex_tui::markdown_stream', delta(message));
    insert.run(2, 201, 'pid:20:current', null, 'codex_tui::markdown_stream', delta(message));
    insert.run(3, 202, 'pid:10:new', 'a-different-thread', 'codex_core::stream', delta(message));
    assert.equal(readCodexRenderAnchor(db, 20, 200000), anchor);
    assert.equal(readCodexRenderAnchor(db, 10, 200000), null);
    assert.equal(readCodexRenderAnchor(db, 999, 0), null);
    insert.run(4, 203, 'pid:20:conflicting-generation', null, 'codex_tui::markdown_stream', delta(message));
    assert.equal(readCodexRenderAnchor(db, 20, 200000), null);
  } finally { db.close(); }
});

test('unsupported log schemas fail closed', () => {
  const db = new Database(':memory:');
  try { assert.equal(readCodexRenderAnchor(db, 20, 0), null); } finally { db.close(); }
});

const header = (id: string, parentId = parent) => JSON.stringify({ type: 'session_meta', payload: { id, forked_from_id: parentId, base_instructions: 'x'.repeat(20000) } });
const assistant = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const taskComplete = (text: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: text } });

test('bounded rollout reader handles large metadata, cached unchanged files, append, and replacement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chatmux-fork-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'rollout.jsonl');
  await writeFile(path, `${header(child)}\n${assistant(message)}\n`);
  const initial = await readCodexForkTranscript(path, child, root);
  assert.deepEqual(initial, { id: child, parentId: parent, messages: [message] });
  assert.equal(await readCodexForkTranscript(path, child, root), initial);
  await writeFile(path, `${header(child)}\n${assistant(message)}\n${assistant('new response')}\n`);
  assert.deepEqual((await readCodexForkTranscript(path, child, root))?.messages, [message, 'new response']);
  await writeFile(path, `${header(child)}\n${taskComplete(message)}\n`);
  assert.deepEqual((await readCodexForkTranscript(path, child, root))?.messages, [message]);
  await writeFile(path, `${header(sibling)}\n${assistant(message)}\n`);
  assert.equal(await readCodexForkTranscript(path, child, root), null);
  await writeFile(path, 'invalid JSON\n');
  assert.equal(await readCodexForkTranscript(path, child, root), null);
});

test('rollout reader rejects escaped paths, symlinks outside root, wrong IDs and malformed parents', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'chatmux-fork-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'sessions');
  await mkdir(root);
  const outside = join(temp, 'outside.jsonl');
  await writeFile(outside, `${header(child)}\n${assistant(message)}\n`);
  assert.equal(await readCodexForkTranscript(outside, child, root), null);
  await symlink(outside, join(root, 'link.jsonl'));
  assert.equal(await readCodexForkTranscript(join(root, 'link.jsonl'), child, root), null);
  const path = join(root, 'invalid.jsonl');
  await writeFile(path, `${header(child, '../not-an-id')}\n`);
  assert.equal(await readCodexForkTranscript(path, child, root), null);
});

test('an oversized record and partial tail cannot manufacture assistant evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chatmux-fork-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'large.jsonl');
  await writeFile(path, `${header(child)}\n${assistant('x'.repeat(2*1024*1024))}\n${assistant(message)}\n{"partial":`);
  assert.deepEqual((await readCodexForkTranscript(path, child, root))?.messages, [message]);
});

test('fork display override never grants transcript input or approval authority', () => {
  const tmux = { socketPath: '/tmp/test-socket', sessionId: '$1', windowId: '@1', paneId: '%1' };
  const key = tmuxPaneIdentityKey(tmux);
  const session = { tmuxName: 'test', tmux, kind: 'codex' as const, providerSessionId: parent, binding: 'observed' as const, agentPid: 10, startedAtMs: 100 };
  const [mapped] = applyInferredProviderSessionIds([session], new Map([[key, child]]), new Set(), new Set([key]));
  assert.equal(mapped.providerSessionId, child);
  assert.equal(mapped.binding, 'inferred');
  assert.throws(() => assertProvenSessionBinding(mapped), { code: 'TMUX_SESSION_BINDING_INFERRED' });
  const [proven] = applyInferredProviderSessionIds([session], new Map([[key, child]]), new Set([key]), new Set([key]));
  assert.equal(proven.binding, 'observed');
  assert.doesNotThrow(() => assertProvenSessionBinding(proven));
  const [otherSocket] = applyInferredProviderSessionIds([{ ...session, tmux: { ...tmux, socketPath: '/tmp/other' } }], new Map([[key, child]]), new Set(), new Set([key]));
  assert.equal(otherSocket.providerSessionId, parent);
});
