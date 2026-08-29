import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { attachVerifiedLocalTmuxTerminal } from '../terminal/local-peer.js';

function tmux(socketPath: string, args: readonly string[]): string {
  const result = spawnSync('tmux', ['-S', socketPath, ...args], { encoding: 'utf8' });
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
    tmux(socketA, ['new-session', '-d', '-s', 'peer-a', 'bash --noprofile --norc']);
    const peerBReady = armCreated(root, 'peer-b-ready');
    tmux(socketB, ['new-session', '-d', '-s', 'peer-b', `touch '${path.join(root, 'peer-b-ready')}'; exec bash --noprofile --norc`]);
    await peerBReady;
    const peerBPipeBefore = tmux(socketB, ['capture-pane', '-p', '-t', '%0']);
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
    terminal.onData((chunk) => {
      output += chunk;
      if (!settled && output.includes('LIVE_A_MARKER') && output.includes('39 120')) { settled = true; resolveMarker?.(); }
    });
    terminal.onExit(() => { lifecycle = 'exited'; failure('terminal exited before peer A marker and final dimensions'); });
    const timeout = setTimeout(() => failure('terminal output timed out'), 15_000);

    // When
    terminal.resize(120, 40);
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
