import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { attachVerifiedLocalTmuxTerminal } from '../terminal/local-peer.js';

function tmux(socketPath: string, args: readonly string[]): string {
  const result = spawnSync('tmux', ['-f', '/dev/null', '-S', socketPath, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new TypeError(`tmux fixture failed: ${result.stderr}`);
  return result.stdout;
}
function armCreated(directory: string, expected: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const watcher = watch(directory, (_event, filename) => {
      if (filename !== expected) return;
      clearTimeout(timeout); watcher.close(); resolve();
    });
    const timeout = setTimeout(() => {
      watcher.close(); reject(new TypeError(`fixture readiness timed out: ${expected}`));
    }, 5_000);
  });
}
/**
 * Captures a pane only once it shows `marker`: the readiness file is touched
 * before bash prints its prompt, so an immediate capture races the shell and
 * the "unchanged" comparison later flakes on whether the prompt arrived.
 */
async function settledCapture(socketPath: string, paneId: string, marker: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  let screen = tmux(socketPath, ['capture-pane', '-p', '-t', paneId]);
  while (!screen.includes(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    screen = tmux(socketPath, ['capture-pane', '-p', '-t', paneId]);
  }
  if (!screen.includes(marker)) throw new TypeError(`fixture pane never showed ${marker}`);
  return screen;
}
function controllerState(): string {
  const result = spawnSync('tmux', [
    'list-sessions', '-F', '#{socket_path}\t#{pid}\t#{session_id}\t#{session_name}',
  ], { encoding: 'utf8' });
  return `${result.status}\n${result.stdout}\n${result.stderr}`;
}
function paneState(socketPath: string, paneId: string): string {
  const result = spawnSync('tmux', ['-S', socketPath, 'display-message', '-p', '-t', paneId,
    '#{pane_id}\t#{pane_width}\t#{pane_height}\t#{pane_dead}\t#{session_attached}'], { encoding: 'utf8' });
  return `${result.status}\n${result.stdout}\n${result.stderr}`;
}

test('real peer-owned PTY attaches peer A, accepts input and resize, and leaves peer B and controller unchanged', async () => {
  // Given
  const root = mkdtempSync(path.join(tmpdir(), 'chatmux-task-12-'));
  const socketA = path.join(root, 'peer-a.sock'); const socketB = path.join(root, 'peer-b.sock');
  const controllerBefore = controllerState();
  let terminal: ReturnType<typeof attachVerifiedLocalTmuxTerminal> | undefined;
  try {
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    const rc = path.join(root, 'bashrc');
    const signal = path.join(root, 'peer-a-resized');
    const resizedSignal = `test "$(stty size)" = '39 120' && touch ${quote(signal)}`;
    writeFileSync(rc, `PS1='bash-fixture$ '\ntrap ${quote(resizedSignal)} WINCH\n`);
    tmux(socketA, ['new-session', '-d', '-s', 'peer-a', `bash --noprofile --rcfile ${quote(rc)}`]);
    const peerBReady = armCreated(root, 'peer-b-ready');
    tmux(socketB, ['new-session', '-d', '-s', 'peer-b', `touch '${path.join(root, 'peer-b-ready')}'; exec bash --noprofile --norc`]);
    await peerBReady;
    const peerBPipeBefore = await settledCapture(socketB, '%0', 'bash-');
    const identity = tmux(socketA, ['display-message', '-p', '-t', '%0', '#{session_id}\t#{window_id}\t#{pane_id}']).trim().split('\t');
    const [sessionId, windowId, paneId] = identity;
    if (sessionId === undefined || windowId === undefined || paneId === undefined) throw new TypeError('tmux identity fixture is invalid');
    const verified = { tmux: { socketPath: socketA, sessionId, windowId, paneId } };
    terminal = attachVerifiedLocalTmuxTerminal(verified, 80, 24);
    let output = ''; let lifecycle = 'running'; let settled = false;
    let resolveMarker: (() => void) | undefined; let rejectMarker: ((error: TypeError) => void) | undefined;
    const marker = new Promise<void>((resolve, reject) => { resolveMarker = resolve; rejectMarker = reject; });
    const failure = (reason: string): void => {
      if (settled) return; settled = true;
      const pane = paneState(socketA, paneId);
      rejectMarker?.(new TypeError(`${reason}; lifecycle=${lifecycle}; target=${JSON.stringify(verified.tmux)}; pane=${JSON.stringify(pane)}; output=${JSON.stringify(output)}`));
    };
    let resolveAttached: (() => void) | undefined;
    const attached = new Promise<void>((resolve, reject) => {
      if (output.includes('bash-')) { resolve(); return; }
      resolveAttached = resolve;
      const attachTimeout = setTimeout(() => reject(new TypeError('tmux attach screen was not replayed within 15 seconds')), 15_000);
      attachTimeout.unref?.();
    });
    terminal.onData((chunk) => {
      output += chunk;
      if (resolveAttached !== undefined && output.includes('bash-')) { const ready = resolveAttached; resolveAttached = undefined; ready(); }
      if (!settled && output.includes('LIVE_A_MARKER') && output.includes('39 120')) { settled = true; resolveMarker?.(); }
    });
    terminal.onExit(() => { lifecycle = 'exited'; failure('terminal exited before peer A marker and final dimensions'); });
    const timeout = setTimeout(() => failure('terminal output timed out'), 30_000);

    // When
    // Input written before the tmux client replays the pane is flushed by the
    // client's terminal setup and never reaches the pane, so wait for the
    // attach screen before writing (observed as lost input on slow CI hosts).
    await attached;
    const resized = armCreated(root, 'peer-a-resized');
    terminal.resize(120, 40);
    await resized;
    terminal.write("stty size; printf 'LIVE_A_MARKER\\n'\n");
    try { await marker; } finally { clearTimeout(timeout); }

    // Then
    assert.match(output, /39 120/);
    assert.match(output, /LIVE_A_MARKER/);
    assert.equal(tmux(socketB, ['capture-pane', '-p', '-t', '%0']), peerBPipeBefore);
  } finally {
    terminal?.close();
    spawnSync('tmux', ['-S', socketA, 'kill-server']); spawnSync('tmux', ['-S', socketB, 'kill-server']);
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(controllerState(), controllerBefore);
});
