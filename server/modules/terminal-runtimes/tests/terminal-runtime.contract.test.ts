import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeFramedBase64,
  readProcessGeneration,
  readPublicTerminalRef,
  readPublicTerminalTarget,
  readShellV3InitRequest,
  readTerminalFrame,
} from '../../../../shared/terminal-runtime.js';

const sourceId = 'hsrc_abcdefghijklmnopqrstuv';
const targetId = 'htgt_abcdefghijklmnopqrstuv';
const tmux = { socketPath: '/tmp/tmux.sock', sessionId: '$1', windowId: '@2', paneId: '%3' };
const process = { pid: 42, startedAtMs: 1_700_000_000_000 };

test('public terminal readers accept only complete tmux and Herdr references', () => {
  assert.deepEqual(readPublicTerminalRef({ runtime: 'tmux', tmux }), { runtime: 'tmux', tmux });
  assert.deepEqual(readPublicTerminalRef({ runtime: 'herdr', sourceId, targetId }), { runtime: 'herdr', sourceId, targetId });
  for (const value of [
    null,
    [],
    { runtime: 'herdr', sourceId: 'hsrc_short', targetId },
    { runtime: 'herdr', sourceId, targetId: `${targetId}x` },
    { runtime: 'tmux', tmux: { ...tmux, socketPath: 'relative.sock' } },
    { runtime: 'tmux', tmux: { ...tmux, socketPath: `/tmp/${'x'.repeat(4096)}` } },
    { runtime: 'tmux', tmux: { ...tmux, paneId: '' } },
    { runtime: 'tmux', tmux: { ...tmux, sessionId: 'x'.repeat(129) } },
  ]) assert.equal(readPublicTerminalRef(value), null);
});

test('public targets require one valid target class and generation or admission capability', () => {
  assert.deepEqual(readPublicTerminalTarget({ runtime: 'tmux', tmux, targetClass: 'local-agent', process }), { runtime: 'tmux', tmux, targetClass: 'local-agent', process });
  assert.deepEqual(readPublicTerminalTarget({ runtime: 'herdr', sourceId, targetId, targetClass: 'attach-only', admissionCapability: 'a'.repeat(16) }), { runtime: 'herdr', sourceId, targetId, targetClass: 'attach-only', admissionCapability: 'a'.repeat(16) });
  for (const value of [
    { runtime: 'herdr', sourceId, targetId, targetClass: 'local-agent', process: { pid: 1, startedAtMs: 1 } },
    { runtime: 'tmux', tmux, targetClass: 'attach-only', admissionCapability: 'short' },
    { runtime: 'tmux', tmux, targetClass: 'other', process },
    { runtime: 'tmux', tmux, targetClass: 'local-agent', process: { pid: 2, startedAtMs: Infinity } },
  ]) assert.equal(readPublicTerminalTarget(value), null);
  assert.equal(readProcessGeneration({ pid: 2, startedAtMs: 0 }), null);
});

test('shell init reader rejects version, dimensions, and malformed target values', () => {
  const valid = { type: 'terminal.init', protocolVersion: 3, mode: 'observe', target: { runtime: 'herdr', sourceId, targetId, targetClass: 'local-agent', process }, cols: 120, rows: 40 };
  assert.deepEqual(readShellV3InitRequest(valid), valid);
  for (const value of [
    { ...valid, protocolVersion: 2 },
    { ...valid, mode: 'takeover' },
    { ...valid, cols: 0 },
    { ...valid, rows: 1001 },
    { ...valid, cols: 1.5 },
    { ...valid, target: { ...valid.target, targetId: 'bad' } },
  ]) assert.equal(readShellV3InitRequest(value), null);
});

test('framed base64 and terminal frames are bounded, valid, and contiguous', () => {
  const encoded = Buffer.from('hello', 'utf8').toString('base64');
  assert.deepEqual(decodeFramedBase64(encoded), new Uint8Array(Buffer.from('hello')));
  assert.equal(decodeFramedBase64('not base64!'), null);
  assert.equal(decodeFramedBase64('AAAA', 3), null);
  assert.equal(decodeFramedBase64(Buffer.alloc(8, 1).toString('base64'), 100, 1), null);
  const frame = { type: 'terminal.frame', seq: 7, encoding: 'ansi', width: 120, height: 40, full: true, bytes: encoded } as const;
  assert.deepEqual(readTerminalFrame(frame, 6), frame);
  for (const value of [
    { ...frame, seq: 8 },
    { ...frame, seq: 0 },
    { ...frame, width: 1001 },
    { ...frame, bytes: 'not-base64' },
    { ...frame, full: 'true' },
  ]) assert.equal(readTerminalFrame(value, 6), null);
});
