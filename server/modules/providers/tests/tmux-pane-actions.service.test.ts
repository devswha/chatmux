import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTmuxPaneIdentity,
  captureTmuxPane,
  killTmuxPane,
  killTmuxSession,
  pasteToTmuxPane,
  readTmuxPaneIdentity,
  readTmuxProcessGeneration,
  sendTmuxProcessAction,
  sendTmuxSelectionKeys,
  sendToTmuxPane,
  stopAgentProcessInPane,
} from '@/modules/providers/services/tmux-pane-actions.service.js';
import type { TmuxRunner } from '@/modules/providers/services/builtin-relay.service.js';
import { AppError } from '@/shared/utils.js';
import { createVerifiedTmuxActionTarget } from '@/modules/providers/services/tmux-fresh-verifier.service.js';

const identity = {
  socketPath: '/tmp/chatmux-test.sock',
  sessionId: '$7',
  windowId: '@8',
  paneId: '%9',
};
const target = createVerifiedTmuxActionTarget(
  identity,
  { pid: 42, startedAtMs: 1234 },
  'codex',
  'test',
);

function recordingRunner(outputs: string[] = []) {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const run: TmuxRunner = async (args, stdin) => {
    calls.push({ args, ...(stdin === undefined ? {} : { stdin }) });
    return { code: 0, output: outputs.shift() ?? '' };
  };
  return { calls, run };
}

test('exact pane parser rejects incomplete or malformed identities', () => {
  assert.throws(
    () => readTmuxPaneIdentity({ ...identity, paneId: '9' }),
    (error) => error instanceof AppError && error.code === 'INVALID_TMUX_PANE_IDENTITY',
  );
  assert.deepEqual(readTmuxPaneIdentity(identity), identity);
  assert.deepEqual(
    readTmuxProcessGeneration({ pid: 42, startedAtMs: 1234 }),
    { pid: 42, startedAtMs: 1234 },
  );
});

test('pane identity validation checks all four tmux coordinates', async () => {
  const exact = recordingRunner(['$7\t@8\t%9\n']);
  await assertTmuxPaneIdentity(identity, exact.run);
  assert.deepEqual(exact.calls[0]?.args, [
    '-S', identity.socketPath,
    'display-message', '-p', '-t', identity.paneId,
    '#{session_id}\t#{window_id}\t#{pane_id}',
  ]);

  const stale = recordingRunner(['$7\t@99\t%9\n']);
  await assert.rejects(
    assertTmuxPaneIdentity(identity, stale.run),
    (error) => error instanceof AppError && error.code === 'TMUX_PANE_GENERATION_MISMATCH',
  );
});

test('pane capture preserves ANSI styles and the pane grid width', async () => {
  const { calls, run } = recordingRunner(['\u001b[31merror\u001b[0m']);
  const output = await captureTmuxPane(target, run);

  assert.equal(output, '\u001b[31merror\u001b[0m');
  assert.deepEqual(calls[0]?.args, [
    '-S', identity.socketPath,
    'capture-pane', '-p', '-e', '-N', '-S', '-80', '-t', identity.paneId,
  ]);
});

test('send targets one pane and preserves literal input', async () => {
  const { calls, run } = recordingRunner(['$7\t@8\t%9\n']);
  const message = "alpha only; $(not-a-shell) 'literal'";
  await sendToTmuxPane(target, message, run);

  assert.deepEqual(calls[0]?.args, [
    '-S', identity.socketPath,
    'display-message', '-p', '-t', identity.paneId,
    '#{session_id}\t#{window_id}\t#{pane_id}',
  ]);
  assert.deepEqual(calls[1]?.args.slice(0, 4), ['-S', identity.socketPath, 'load-buffer', '-b']);
  assert.equal(calls[1]?.stdin, message);
  const bufferName = calls[1]?.args[4];
  assert.deepEqual(calls[2]?.args, [
    '-S', identity.socketPath,
    'paste-buffer', '-d', '-p', '-b', bufferName!, '-t', identity.paneId,
  ]);
  assert.deepEqual(calls[3]?.args, [
    '-S', identity.socketPath,
    'send-keys', '-t', identity.paneId, 'Enter',
  ]);
});

test('paste can stage native prompt feedback without submitting Enter', async () => {
  const { calls, run } = recordingRunner(['$7\t@8\t%9\n']);
  await pasteToTmuxPane(target, 'change the plan', run);
  assert.equal(calls.some(({ args }) => args.at(-1) === 'Enter'), false);
  assert.equal(calls.some(({ args }) => args.includes('paste-buffer')), true);
});
test('send refuses a stale pane before staging bytes in a tmux buffer', async () => {
  const { calls, run } = recordingRunner(['$7\t@8\t%999\n']);
  await assert.rejects(
    sendToTmuxPane(target, 'must not reach pane', run),
    (error) => error instanceof AppError && error.code === 'TMUX_PANE_GENERATION_MISMATCH',
  );
  assert.equal(calls.some(({ args }) => args.includes('load-buffer')), false);
});
test('process actions assemble only the typed interrupt and escape argv arrays', async () => {
  const interrupt = recordingRunner(['$7\t@8\t%9\n']);
  await sendTmuxProcessAction(target, 'interrupt', interrupt.run);
  assert.deepEqual(interrupt.calls.map(({ args }) => args), [
    ['-S', identity.socketPath, 'display-message', '-p', '-t', identity.paneId, '#{session_id}\t#{window_id}\t#{pane_id}'],
    ['-S', identity.socketPath, 'send-keys', '-t', identity.paneId, 'C-c'],
  ]);

  const escape = recordingRunner(['$7\t@8\t%9\n']);
  await sendTmuxProcessAction(target, 'escape', escape.run);
  assert.deepEqual(escape.calls[1]?.args, [
    '-S', identity.socketPath, 'send-keys', '-t', identity.paneId, 'Escape',
  ]);
});

test('process action refuses a stale pane before sending keys', async () => {
  const { calls, run } = recordingRunner(['$7\t@8\t%99\n']);
  await assert.rejects(
    sendTmuxProcessAction(target, 'interrupt', run),
    (error) => error instanceof AppError && error.code === 'TMUX_PANE_GENERATION_MISMATCH',
  );
  assert.equal(calls.some(({ args }) => args.includes('send-keys')), false);
});

test('selector actions recheck the exact pane and send only allowlisted keys separately', async () => {
  const { calls, run } = recordingRunner(['$7\t@8\t%9\n']);
  await sendTmuxSelectionKeys(target, ['Down', 'Down', 'Enter'], run, async () => {});
  assert.deepEqual(calls.slice(1).map(({ args }) => args), [
    ['-S', identity.socketPath, 'send-keys', '-t', identity.paneId, 'Down'],
    ['-S', identity.socketPath, 'send-keys', '-t', identity.paneId, 'Down'],
    ['-S', identity.socketPath, 'send-keys', '-t', identity.paneId, 'Enter'],
  ]);
});

test('selector actions reject empty and oversized internally constructed sequences', async () => {
  await assert.rejects(
    sendTmuxSelectionKeys(target, [], recordingRunner().run),
    (error) => error instanceof AppError && error.code === 'INVALID_TMUX_SELECTION',
  );
  assert.equal(recordingRunner().calls.length, 0);
});

test('default process stop respawns a shell in the same pane', async () => {
  const { calls, run } = recordingRunner(['$7\t@8\t%9\t/workspace/project\n']);
  await stopAgentProcessInPane(target, run, '/bin/bash');
  assert.deepEqual(calls[0]?.args, [
    '-S', identity.socketPath,
    'display-message', '-p', '-t', identity.paneId,
    '#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_current_path}',
  ]);
  assert.deepEqual(calls[1]?.args, [
    '-S', identity.socketPath,
    'respawn-pane', '-k', '-t', identity.paneId,
    '-c', '/workspace/project', '/bin/bash',
  ]);
  assert.deepEqual(calls.slice(2).map(({ args }) => args.slice(2)), [
    ['set-option', '-p', '-t', identity.paneId, '@chatmux_cli_kind', ''],
    ['set-option', '-p', '-t', identity.paneId, '@chatmux_provider_session_id', ''],
    ['set-option', '-p', '-t', identity.paneId, '@chatmux_codex_thread_id', ''],
  ]);
});

test('pane and session termination use distinct immutable ids', async () => {
  const pane = recordingRunner();
  await killTmuxPane(target, pane.run);
  assert.deepEqual(pane.calls[0]?.args, [
    '-S', identity.socketPath, 'kill-pane', '-t', identity.paneId,
  ]);

  const session = recordingRunner();
  await killTmuxSession(target, session.run);
  assert.deepEqual(session.calls[0]?.args, [
    '-S', identity.socketPath, 'kill-session', '-t', identity.sessionId,
  ]);
});
