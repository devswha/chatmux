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
  sanitizeTmuxPasteText,
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

test('paste strips terminal control characters so a message cannot end the bracketed paste early', async () => {
  const { calls, run } = recordingRunner(['$7\t@8\t%9\n']);
  const hostile = 'hello\u001b[201~rm -rf /\u001b[200~\r\nworld\u009bA\ttab\u0000\u0007\u007f';
  await pasteToTmuxPane(target, hostile, run);
  const staged = calls.find(({ args }) => args.includes('load-buffer'));
  assert.equal(staged?.stdin, 'hello[201~rm -rf /[200~\nworldA\ttab', 'ESC, C1, NUL, BEL, DEL gone; tab and newline kept');
  assert.equal(sanitizeTmuxPasteText('a\rb\r\nc\n'), 'a\nb\nc\n');
});

test('paste rejects a message that is empty once control characters are removed, before touching tmux', async () => {
  const { calls, run } = recordingRunner(['$7\t@8\t%9\n']);
  await assert.rejects(
    pasteToTmuxPane(target, '\u001b\u0007 \u000b\r\n\u009b', run),
    (error) => error instanceof AppError && error.code === 'EMPTY_MESSAGE',
  );
  assert.equal(calls.length, 0);
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
test('process actions use Codex Escape interrupts and typed escape argv arrays', async () => {
  const interrupt = recordingRunner(['$7\t@8\t%9\n']);
  await sendTmuxProcessAction(target, 'interrupt', interrupt.run);
  assert.deepEqual(interrupt.calls.map(({ args }) => args), [
    ['-S', identity.socketPath, 'display-message', '-p', '-t', identity.paneId, '#{session_id}\t#{window_id}\t#{pane_id}'],
    ['-S', identity.socketPath, 'send-keys', '-t', identity.paneId, 'Escape'],
  ]);

  const escape = recordingRunner(['$7\t@8\t%9\n']);
  await sendTmuxProcessAction(target, 'escape', escape.run);
  assert.deepEqual(escape.calls[1]?.args, [
    '-S', identity.socketPath, 'send-keys', '-t', identity.paneId, 'Escape',
  ]);
});

test('non-Codex process interrupts retain Ctrl+C', async () => {
  const claudeTarget = createVerifiedTmuxActionTarget(
    identity,
    { pid: 42, startedAtMs: 1234 },
    'claude',
    'test',
  );
  const interrupt = recordingRunner(['$7\t@8\t%9\n']);
  await sendTmuxProcessAction(claudeTarget, 'interrupt', interrupt.run);
  assert.deepEqual(interrupt.calls[1]?.args, [
    '-S', identity.socketPath, 'send-keys', '-t', identity.paneId, 'C-c',
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

test('process stop respawns a shell when the agent shares the pane root process group', async () => {
  // Pane command is a node launcher (pid 40) whose codex child is the agent (42): one group, no shell to keep.
  const { calls, run } = recordingRunner(['$7\t@8\t%9\t/workspace/project\t40\n']);
  const signals: string[] = [];
  await stopAgentProcessInPane(target, run, '/bin/bash', {
    kill: (_pid, signal) => { signals.push(signal); },
    processGroupId: async () => 40,
  });
  assert.deepEqual(signals, [], 'the pane root group is replaced, not signalled');
  assert.deepEqual(calls[0]?.args, [
    '-S', identity.socketPath,
    'display-message', '-p', '-t', identity.paneId,
    '#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_current_path}\t#{pane_pid}',
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

test('process stop signals the agent job group, confirms its exit against the verified generation, and keeps the shell', async () => {
  // Interactive shell (pid 41, its own group) started the agent as a job in group 42.
  const { calls, run } = recordingRunner(['$7\t@8\t%9\t/workspace/project\t41\n']);
  const signals: string[] = [];
  let alive = true;
  await stopAgentProcessInPane(target, run, '/bin/bash', {
    kill: (pid, signal) => { assert.equal(pid, -42, 'the whole job group, wrappers included'); signals.push(signal); if (signal === 'SIGTERM') alive = false; },
    startedAtMs: async (pid) => (pid === 42 && alive ? 1234 : null),
    processGroupId: async (pid) => (pid === 41 ? 41 : 42),
    isZombie: async () => false,
    sleep: async () => {},
  });
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(calls.some(({ args }) => args.includes('respawn-pane')), false, 'the user shell in the pane survives');
  assert.deepEqual(calls.slice(1).map(({ args }) => args[2]), ['set-option', 'set-option', 'set-option']);
});

test('process stop escalates to SIGKILL and reports an agent that will not die', async () => {
  const stubborn = recordingRunner(['$7\t@8\t%9\t/workspace/project\t41\n']);
  const signals: string[] = [];
  let alive = true;
  const group = { processGroupId: async (pid: number) => (pid === 41 ? 41 : 42), isZombie: async () => false, sleep: async () => {} };
  await stopAgentProcessInPane(target, stubborn.run, '/bin/bash', {
    ...group,
    kill: (_pid, signal) => { signals.push(signal); if (signal === 'SIGKILL') alive = false; },
    startedAtMs: async () => (alive ? 1234 : null),
  });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);

  // A zombie still has its /proc entry and start tick, but it has exited.
  const reaped = recordingRunner(['$7\t@8\t%9\t/workspace/project\t41\n']);
  const zombieSignals: string[] = [];
  await stopAgentProcessInPane(target, reaped.run, '/bin/bash', {
    ...group,
    kill: (_pid, signal) => { zombieSignals.push(signal); },
    startedAtMs: async () => 1234,
    isZombie: async () => zombieSignals.length > 0,
  });
  assert.deepEqual(zombieSignals, ['SIGTERM']);

  const immortal = recordingRunner(['$7\t@8\t%9\t/workspace/project\t41\n']);
  await assert.rejects(
    stopAgentProcessInPane(target, immortal.run, '/bin/bash', { ...group, kill: () => {}, startedAtMs: async () => 1234 }),
    (error: unknown) => error instanceof AppError && error.code === 'AGENT_PROCESS_STILL_RUNNING',
  );
  assert.equal(immortal.calls.some(({ args }) => args.includes('set-option')), false, 'tags stay while the agent is still there');
});

test('process stop never signals a pid whose start time no longer matches the verified generation', async () => {
  const { run } = recordingRunner(['$7\t@8\t%9\t/workspace/project\t41\n']);
  const signals: string[] = [];
  await assert.rejects(
    stopAgentProcessInPane(target, run, '/bin/bash', {
      kill: (_pid, signal) => { signals.push(signal); },
      startedAtMs: async () => 9999,
      processGroupId: async (pid) => (pid === 41 ? 41 : 42),
      isZombie: async () => false,
      sleep: async () => {},
    }),
    (error: unknown) => error instanceof AppError && error.code === 'TMUX_PROCESS_GENERATION_MISMATCH',
  );
  assert.deepEqual(signals, []);
});

test('pane and session termination recheck the exact pane, then use distinct immutable ids', async () => {
  const recheck = [
    '-S', identity.socketPath,
    'display-message', '-p', '-t', identity.paneId,
    '#{session_id}\t#{window_id}\t#{pane_id}',
  ];
  const pane = recordingRunner(['$7\t@8\t%9\n']);
  await killTmuxPane(target, pane.run);
  assert.deepEqual(pane.calls[0]?.args, recheck);
  assert.deepEqual(pane.calls[1]?.args, [
    '-S', identity.socketPath, 'kill-pane', '-t', identity.paneId,
  ]);

  const session = recordingRunner(['$7\t@8\t%9\n', `${identity.paneId}\n`]);
  await killTmuxSession(target, session.run);
  assert.deepEqual(session.calls[0]?.args, recheck);
  assert.deepEqual(session.calls[1]?.args, [
    '-S', identity.socketPath, 'list-panes', '-s', '-t', identity.sessionId, '-F', '#{pane_id}',
  ]);
  assert.deepEqual(session.calls[2]?.args, [
    '-S', identity.socketPath, 'kill-session', '-t', identity.sessionId,
  ]);
});

test('termination refuses a pane that moved to another window or session', async () => {
  const moved = recordingRunner(['$7\t@12\t%9\n']);
  await assert.rejects(killTmuxPane(target, moved.run), (error: unknown) => error instanceof AppError && error.code === 'TMUX_PANE_GENERATION_MISMATCH');
  assert.equal(moved.calls.some(({ args }) => args.includes('kill-pane')), false);

  const rehomed = recordingRunner(['$30\t@8\t%9\n']);
  await assert.rejects(killTmuxSession(target, rehomed.run, { allowOtherPanes: true }), (error: unknown) => error instanceof AppError && error.code === 'TMUX_PANE_GENERATION_MISMATCH');
  assert.equal(rehomed.calls.some(({ args }) => args.includes('kill-session')), false);
});

test('session termination refuses to take other panes down without explicit confirmation', async () => {
  const crowded = recordingRunner(['$7\t@8\t%9\n', `${identity.paneId}\n%10\n%11\n`]);
  await assert.rejects(killTmuxSession(target, crowded.run), (error: unknown) => error instanceof AppError && error.code === 'TMUX_SESSION_HAS_OTHER_PANES');
  assert.equal(crowded.calls.length, 2, 'nothing is killed after the refusal');

  const confirmed = recordingRunner(['$7\t@8\t%9\n', `${identity.paneId}\n%10\n`]);
  await killTmuxSession(target, confirmed.run, { allowOtherPanes: true });
  assert.deepEqual(confirmed.calls[2]?.args, ['-S', identity.socketPath, 'kill-session', '-t', identity.sessionId]);

  const gone = recordingRunner();
  gone.run = async () => ({ code: 1, output: "can't find session" });
  await assert.rejects(killTmuxSession(target, gone.run), (error: unknown) => error instanceof AppError && error.code === 'TMUX_PANE_GENERATION_MISMATCH');
});
