import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTmuxPaneIdentity,
  captureTmuxPane,
  killTmuxPane,
  killTmuxSession,
  readTmuxPaneIdentity,
  readTmuxProcessGeneration,
  sendToTmuxPane,
  stopAgentProcessInPane,
} from '@/modules/providers/services/tmux-pane-actions.service.js';
import type { TmuxRunner } from '@/modules/providers/services/builtin-relay.service.js';
import { AppError } from '@/shared/utils.js';

const identity = {
  socketPath: '/tmp/chatmux-test.sock',
  sessionId: '$7',
  windowId: '@8',
  paneId: '%9',
};

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

test('pane capture preserves tmux ANSI style sequences', async () => {
  const { calls, run } = recordingRunner(['\u001b[31merror\u001b[0m']);
  const output = await captureTmuxPane(identity, run);

  assert.equal(output, '\u001b[31merror\u001b[0m');
  assert.deepEqual(calls[0]?.args, [
    '-S', identity.socketPath,
    'capture-pane', '-p', '-e', '-S', '-80', '-t', identity.paneId,
  ]);
});

test('send targets one pane and preserves literal input', async () => {
  const { calls, run } = recordingRunner();
  const message = "alpha only; $(not-a-shell) 'literal'";
  await sendToTmuxPane(identity, message, run);

  assert.deepEqual(calls[0]?.args.slice(0, 4), ['-S', identity.socketPath, 'load-buffer', '-b']);
  assert.equal(calls[0]?.stdin, message);
  const bufferName = calls[0]?.args[4];
  assert.deepEqual(calls[1]?.args, [
    '-S', identity.socketPath,
    'paste-buffer', '-d', '-p', '-b', bufferName!, '-t', identity.paneId,
  ]);
  assert.deepEqual(calls[2]?.args, [
    '-S', identity.socketPath,
    'send-keys', '-t', identity.paneId, 'Enter',
  ]);
});

test('default process stop respawns a shell in the same pane', async () => {
  const { calls, run } = recordingRunner(['$7\t@8\t%9\t/workspace/project\n']);
  await stopAgentProcessInPane(identity, run, '/bin/bash');
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
  await killTmuxPane(identity, pane.run);
  assert.deepEqual(pane.calls[0]?.args, [
    '-S', identity.socketPath, 'kill-pane', '-t', identity.paneId,
  ]);

  const session = recordingRunner();
  await killTmuxSession(identity, session.run);
  assert.deepEqual(session.calls[0]?.args, [
    '-S', identity.socketPath, 'kill-session', '-t', identity.sessionId,
  ]);
});
