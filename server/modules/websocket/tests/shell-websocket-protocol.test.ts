import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createAttachCapabilityService } from '@/modules/providers/index.js';
// eslint-disable-next-line boundaries/dependencies -- tests must not mint verified targets through a public barrel.
import { createVerifiedTmuxActionTarget } from '@/modules/providers/services/tmux-fresh-verifier.service.js';

import {
  handleShellConnection,
  SHELL_PROTOCOL_VERSION,
  stripTerminalQueriesForRedraw,
  type ShellWebSocketDependencies,
} from '../services/shell-websocket.service.js';

const tmux = { socketPath: '/tmp/tmux.sock', sessionId: '$1', windowId: '@2', paneId: '%3' };

class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: string[] = [];
  closed = false;

  send(message: string): void { this.sent.push(message); }
  close(): void { this.closed = true; this.readyState = 3; }
}

function fakePty() {
  return {
    onData: () => undefined,
    onExit: () => undefined,
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
  };
}

function dependencies(overrides: Partial<ShellWebSocketDependencies> = {}): ShellWebSocketDependencies {
  return {
    resolveProviderSessionId: () => null,
    stripAnsiSequences: (value) => value,
    normalizeDetectedUrl: () => null,
    extractUrlsFromText: () => [],
    shouldAutoOpenUrlFromOutput: () => false,
    getCurrentTmuxPaneIdentity: async () => ({ ...tmux, paneId: '%99' }),
    readTmuxPaneIdentity: (value) => value as typeof tmux,
    ...overrides,
  };
}

async function sendInit(ws: FakeWebSocket, message: Record<string, unknown>): Promise<void> {
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'init', projectPath: process.cwd(), ...message })));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function error(ws: FakeWebSocket): Record<string, unknown> {
  return JSON.parse(ws.sent[0] ?? '{}') as Record<string, unknown>;
}

test('missing or obsolete protocol rejects harmless command before spawn', async () => {
  for (const shellProtocolVersion of [undefined, SHELL_PROTOCOL_VERSION - 1]) {
    let spawned = 0;
    const ws = new FakeWebSocket();
    handleShellConnection(ws as never, dependencies({ spawn: (() => { spawned += 1; return fakePty(); }) as never }));
    await sendInit(ws, { shellProtocolVersion, mode: 'plain-shell', initialCommand: 'npx task-master init' });
    assert.equal(spawned, 0);
    assert.deepEqual(error(ws), {
      type: 'error', code: 'SHELL_PROTOCOL_OUTDATED',
      message: 'Shell protocol is outdated. Reload ChatMux and try again.', reloadRequired: true,
    });
    assert.equal(ws.closed, true);
  }
});

test('init mode and typed attach command fields are exclusive', async () => {
  for (const message of [
    { shellProtocolVersion: SHELL_PROTOCOL_VERSION },
    { shellProtocolVersion: SHELL_PROTOCOL_VERSION, mode: 'invalid' },
    { shellProtocolVersion: SHELL_PROTOCOL_VERSION, mode: 'plain-shell', targetClass: 'local-agent', tmux },
    { shellProtocolVersion: SHELL_PROTOCOL_VERSION, mode: 'typed-attach', initialCommand: 'echo harmless' },
  ]) {
    let spawned = 0;
    const ws = new FakeWebSocket();
    handleShellConnection(ws as never, dependencies({ spawn: (() => { spawned += 1; return fakePty(); }) as never }));
    await sendInit(ws, message);
    assert.equal(spawned, 0);
    assert.equal(ws.closed, true);
  }
});

test('local-agent validation failure never spawns a PTY', async () => {
  let spawned = 0;
  const ws = new FakeWebSocket();
  handleShellConnection(ws as never, dependencies({
    spawn: (() => { spawned += 1; return fakePty(); }) as never,
    assertFreshExternalTmuxTarget: async () => { throw new Error('stale target'); },
  }));
  await sendInit(ws, { shellProtocolVersion: SHELL_PROTOCOL_VERSION, mode: 'typed-attach', targetClass: 'local-agent', tmux, process: { pid: 9, startedAtMs: 1 } });
  assert.equal(spawned, 0);
});

test('typed attach best-effort enables passthrough before the server-built exact argv', async () => {
  const commands: string[][] = [];
  const ws = new FakeWebSocket();
  handleShellConnection(ws as never, dependencies({
    spawn: ((_shell: string, args: string[]) => { commands.push(args); return fakePty(); }) as never,
    assertFreshExternalTmuxTarget: async () => createVerifiedTmuxActionTarget(tmux, { pid: 9, startedAtMs: 1 }, 'claude', 'agent'),
  }));
  await sendInit(ws, { shellProtocolVersion: SHELL_PROTOCOL_VERSION, mode: 'typed-attach', targetClass: 'local-agent', tmux, process: { pid: 9, startedAtMs: 1 } });
  assert.deepEqual(commands, [['-c', "tmux -S '/tmp/tmux.sock' set-option -g allow-passthrough on >/dev/null 2>&1 || true; exec tmux -S '/tmp/tmux.sock' select-window -t '@2' \\; select-pane -t '%3' \\; attach-session -t '$1'"]]);
});

test('verified attach children cannot inherit the hosting tmux context', async () => {
  const previous = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  process.env.TMUX = '/tmp/operator.sock,42,0';
  process.env.TMUX_PANE = '%123';
  let environment: NodeJS.ProcessEnv | undefined;
  const ws = new FakeWebSocket();
  try {
    handleShellConnection(ws as never, dependencies({
      spawn: ((_shell: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { environment = options.env; return fakePty(); }) as never,
      assertFreshExternalTmuxTarget: async () => createVerifiedTmuxActionTarget(tmux, { pid: 9, startedAtMs: 1 }, 'claude', 'agent'),
    }));
    await sendInit(ws, { shellProtocolVersion: SHELL_PROTOCOL_VERSION, mode: 'typed-attach', targetClass: 'local-agent',
      tmux, process: { pid: 9, startedAtMs: 1 }, sessionId: 'isolated-attach-environment' });
    assert.ok(environment);
    assert.equal(environment.TMUX, undefined);
    assert.equal(environment.TMUX_PANE, undefined);
    assert.equal(process.env.TMUX, '/tmp/operator.sock,42,0');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('plain shell preserves its command after protocol negotiation', async () => {
  const commands: string[][] = [];
  const ws = new FakeWebSocket();
  handleShellConnection(ws as never, dependencies({ spawn: ((_shell: string, args: string[]) => { commands.push(args); return fakePty(); }) as never }));
  await sendInit(ws, { shellProtocolVersion: SHELL_PROTOCOL_VERSION, mode: 'plain-shell', initialCommand: 'npx task-master init' });
  assert.deepEqual(commands, [['-c', 'npx task-master init']]);
});

test('attach capabilities bind issuer state, principal, pane, expiry, and pane generation', async () => {
  let now = 1_000;
  let generation: string | null = '101';
  const issuer = createAttachCapabilityService({
    now: () => now,
    ttlMs: 60_000,
    readPaneGeneration: async () => generation,
  });
  const token = await issuer.issue('user-1', tmux);
  assert.ok(token);
  assert.equal(await issuer.verify(token, 'user-1', tmux), true);
  assert.equal(await issuer.verify(token, 'user-1', tmux), true);
  assert.equal(await issuer.verify(token, 'user-2', tmux), false);
  assert.equal(await issuer.verify(token, 'user-1', { ...tmux, paneId: '%4' }), false);
  generation = '102';
  assert.equal(await issuer.verify(token, 'user-1', tmux), false);
  generation = null;
  assert.equal(await issuer.verify(token, 'user-1', tmux), false);
  generation = '101';
  now += 60_000;
  assert.equal(await issuer.verify(token, 'user-1', tmux), false);
  assert.equal(await createAttachCapabilityService({ now: () => now, readPaneGeneration: async () => generation }).verify(token, 'user-1', tmux), false);
});
test('attach capability storage reuses matching generations, supersedes changed generations, and is bounded', async () => {
  let now = 1_000;
  let generation = '101';
  const capabilities = createAttachCapabilityService({
    now: () => now,
    ttlMs: 100,
    maxRecords: 2,
    readPaneGeneration: async () => generation,
  });
  const first = await capabilities.issue('user-1', tmux);
  const reused = await capabilities.issue('user-1', tmux);
  assert.ok(first);
  assert.equal(reused, first);
  assert.equal(await capabilities.verify(first, 'user-1', tmux), true);
  assert.equal(capabilities.size(), 1);

  generation = '102';
  const replacement = await capabilities.issue('user-1', tmux);
  assert.ok(replacement);
  assert.notEqual(replacement, first);
  assert.equal(await capabilities.verify(first, 'user-1', tmux), false);
  assert.equal(await capabilities.verify(replacement, 'user-1', tmux), true);

  await capabilities.issue('user-2', { ...tmux, paneId: '%4' });
  await capabilities.issue('user-3', { ...tmux, paneId: '%5' });
  assert.equal(capabilities.size(), 2);
  now += 100;
  assert.equal(capabilities.size(), 0);
});
test('attach capability issue does not reuse a token that expires while reading its generation', async () => {
  let now = 1_000;
  let advanceClock = false;
  const capabilities = createAttachCapabilityService({
    now: () => now,
    ttlMs: 100,
    readPaneGeneration: async () => {
      if (advanceClock) now = 1_100;
      return '101';
    },
  });
  const first = await capabilities.issue('user-1', tmux);
  assert.ok(first);
  advanceClock = true;
  const replacement = await capabilities.issue('user-1', tmux);
  assert.ok(replacement);
  assert.notEqual(replacement, first);
  advanceClock = false;
  assert.equal(await capabilities.verify(replacement, 'user-1', tmux), true);
});
test('attach capability verify rejects and removes a token that expires while reading its generation', async () => {
  let now = 1_000;
  let advanceClock = false;
  const capabilities = createAttachCapabilityService({
    now: () => now,
    ttlMs: 100,
    readPaneGeneration: async () => {
      if (advanceClock) now = 1_100;
      return '101';
    },
  });
  const token = await capabilities.issue('user-1', tmux);
  assert.ok(token);
  advanceClock = true;
  assert.equal(await capabilities.verify(token, 'user-1', tmux), false);
  assert.equal(capabilities.size(), 0);
});
test('attach capability verify rejects a token superseded while reading its generation', async () => {
  let generation = '101';
  let releaseRead: (() => void) | null = null;
  const capabilities = createAttachCapabilityService({
    readPaneGeneration: async () => {
      const observed = generation;
      if (releaseRead) {
        const pending = releaseRead;
        releaseRead = null;
        pending();
        // Let the concurrent issue() supersede this token before we resolve.
        await new Promise((resolve) => { setImmediate(resolve); });
      }
      return observed;
    },
  });
  const token = await capabilities.issue('user-1', tmux);
  assert.ok(token);

  let supersede: (() => void) = () => {};
  const superseded = new Promise<void>((resolve) => { supersede = resolve; });
  releaseRead = supersede;
  const pendingVerify = capabilities.verify(token, 'user-1', tmux);
  await superseded;
  generation = '202';
  const replacement = await capabilities.issue('user-1', tmux);
  assert.ok(replacement);
  assert.notEqual(replacement, token);

  assert.equal(await pendingVerify, false);
  assert.equal(await capabilities.verify(token, 'user-1', tmux), false);
});
test('attach-only uses a valid capability with a matching generation to spawn the server-built command', async () => {
  const commands: string[][] = [];
  const capabilities = createAttachCapabilityService({ readPaneGeneration: async () => '101' });
  const capability = await capabilities.issue('user-1', tmux);
  assert.ok(capability);
  assert.equal(await capabilities.verify(capability, 'user-1', tmux), true);
  const ws = new FakeWebSocket();
  handleShellConnection(ws as never, dependencies({
    principal: 'user-1',
    attachCapabilities: capabilities,
    assertTmuxPaneIdentity: async () => undefined,
    readTmuxSessionName: async () => 'external',
    spawn: ((_shell: string, args: string[]) => { commands.push(args); return fakePty(); }) as never,
  }));
  await sendInit(ws, {
    shellProtocolVersion: SHELL_PROTOCOL_VERSION,
    mode: 'typed-attach',
    sessionId: 'attach-only-capability',
    targetClass: 'attach-only',
    tmux,
    capability,
  });
  assert.deepEqual(commands, [['-c', "tmux -S '/tmp/tmux.sock' set-option -g allow-passthrough on >/dev/null 2>&1 || true; exec tmux -S '/tmp/tmux.sock' select-window -t '@2' \\; select-pane -t '%3' \\; attach-session -t '$1'"]]);
});
test('attach-only permits a server hosted outside tmux', async () => {
  const capabilities = createAttachCapabilityService({ readPaneGeneration: async () => '101' });
  const capability = await capabilities.issue('user-systemd', tmux);
  let spawned = 0;
  const ws = new FakeWebSocket();
  handleShellConnection(ws as never, dependencies({
    principal: 'user-systemd',
    attachCapabilities: capabilities,
    assertTmuxPaneIdentity: async () => undefined,
    readTmuxSessionName: async () => 'external',
    getCurrentTmuxPaneIdentityState: async () => ({ state: 'not-hosted' }),
    spawn: (() => { spawned += 1; return fakePty(); }) as never,
  }));
  await sendInit(ws, {
    shellProtocolVersion: SHELL_PROTOCOL_VERSION, mode: 'typed-attach', targetClass: 'attach-only', sessionId: 'systemd-attach', tmux, capability,
  });
  assert.equal(spawned, 1);
});

test('attach-only rechecks generation after target protection checks and before spawn', async () => {
  let generation = '101';
  const capabilities = createAttachCapabilityService({ readPaneGeneration: async () => generation });
  const capability = await capabilities.issue('user-1', tmux);
  let spawned = 0;
  const ws = new FakeWebSocket();
  handleShellConnection(ws as never, dependencies({
    principal: 'user-1',
    attachCapabilities: capabilities,
    assertTmuxPaneIdentity: async () => { generation = '102'; },
    readTmuxSessionName: async () => 'external',
    spawn: (() => { spawned += 1; return fakePty(); }) as never,
  }));
  await sendInit(ws, {
    shellProtocolVersion: SHELL_PROTOCOL_VERSION, mode: 'typed-attach', targetClass: 'attach-only', tmux, capability,
  });
  assert.equal(spawned, 0);
});

test('attach-only lease reconnects after capability expiry only for its principal and pane', async () => {
  let now = 1_000;
  const capabilities = createAttachCapabilityService({
    now: () => now, ttlMs: 100, readPaneGeneration: async () => '101',
  });
  const capability = await capabilities.issue('user-1', tmux);
  const init = {
    shellProtocolVersion: SHELL_PROTOCOL_VERSION,
    mode: 'typed-attach',
    targetClass: 'attach-only',
    sessionId: 'leased-attach-session',
    tmux,
    capability,
  };
  let spawned = 0;
  const first = new FakeWebSocket();
  const base = dependencies({
    principal: 'user-1',
    attachCapabilities: capabilities,
    assertTmuxPaneIdentity: async () => undefined,
    readTmuxSessionName: async () => 'external',
    spawn: (() => { spawned += 1; return fakePty(); }) as never,
  });
  handleShellConnection(first as never, base);
  await sendInit(first, init);
  now += 100;

  const reconnect = new FakeWebSocket();
  handleShellConnection(reconnect as never, base);
  await sendInit(reconnect, init);
  assert.equal(spawned, 1);

  for (const message of [
    { ...init, tmux: { ...tmux, paneId: '%4' } },
    init,
  ]) {
    const denied = new FakeWebSocket();
    handleShellConnection(denied as never, dependencies({
      ...base,
      principal: message === init ? 'user-2' : 'user-1',
    }));
    await sendInit(denied, message);
  }
  assert.equal(spawned, 1);

  const absent = new FakeWebSocket();
  handleShellConnection(absent as never, base);
  await sendInit(absent, { ...init, sessionId: 'missing-leased-attach-session' });
  assert.equal(spawned, 1);
});
test('attach-only forceRestart preserves an existing PTY when its lease or capability is invalid', async () => {
  for (const scenario of ['wrong-principal', 'wrong-pane', 'expired-capability'] as const) {
    let now = 1_000;
    let killed = 0;
    let spawned = 0;
    const capabilities = createAttachCapabilityService({
      now: () => now,
      ttlMs: 100,
      readPaneGeneration: async () => '101',
    });
    const ownerCapability = await capabilities.issue('user-1', tmux);
    assert.ok(ownerCapability);
    const capability = scenario === 'wrong-pane'
      ? await capabilities.issue('user-1', { ...tmux, paneId: '%4' })
      : ownerCapability;
    assert.ok(capability);

    const sessionId = `force-restart-${scenario}`;
    const init = {
      shellProtocolVersion: SHELL_PROTOCOL_VERSION,
      mode: 'typed-attach' as const,
      targetClass: 'attach-only' as const,
      sessionId,
      tmux,
      capability: ownerCapability,
    };
    const ownerDependencies = dependencies({
      principal: 'user-1',
      attachCapabilities: capabilities,
      assertTmuxPaneIdentity: async () => undefined,
      readTmuxSessionName: async () => 'external',
      spawn: (() => {
        spawned += 1;
        return { ...fakePty(), kill: () => { killed += 1; } };
      }) as never,
    });
    const owner = new FakeWebSocket();
    handleShellConnection(owner as never, ownerDependencies);
    await sendInit(owner, init);
    if (scenario === 'expired-capability') now += 100;

    const denied = new FakeWebSocket();
    handleShellConnection(denied as never, dependencies({
      ...ownerDependencies,
      principal: scenario === 'wrong-principal' ? 'user-2' : 'user-1',
    }));
    await sendInit(denied, {
      ...init,
      capability,
      forceRestart: true,
    });
    assert.equal(killed, 0);
    assert.equal(spawned, 1);

    const reconnect = new FakeWebSocket();
    handleShellConnection(reconnect as never, ownerDependencies);
    await sendInit(reconnect, init);
    assert.match(reconnect.sent.join(''), /Reconnected to existing session/);
    assert.equal(killed, 0);
    assert.equal(spawned, 1);
  }
});
test('forceRestart spawn failure close preserves the original PTY websocket binding', async () => {
  let spawned = 0;
  let killed = 0;
  let ownerOutput: ((chunk: string) => void) | undefined;
  const capabilities = createAttachCapabilityService({ readPaneGeneration: async () => '101' });
  const capability = await capabilities.issue('user-1', tmux);
  assert.ok(capability);
  const init = {
    shellProtocolVersion: SHELL_PROTOCOL_VERSION,
    mode: 'typed-attach' as const,
    targetClass: 'attach-only' as const,
    sessionId: 'force-restart-spawn-failure',
    tmux,
    capability,
  };
  const base = dependencies({
    principal: 'user-1',
    attachCapabilities: capabilities,
    assertTmuxPaneIdentity: async () => undefined,
    readTmuxSessionName: async () => 'external',
    spawn: (() => {
      spawned += 1;
      if (spawned === 2) throw new Error('spawn failed');
      return {
        ...fakePty(),
        onData: (listener: (chunk: string) => void) => { ownerOutput = listener; },
        kill: () => { killed += 1; },
      };
    }) as never,
  });
  const owner = new FakeWebSocket();
  handleShellConnection(owner as never, base);
  await sendInit(owner, init);

  const restart = new FakeWebSocket();
  handleShellConnection(restart as never, base);
  await sendInit(restart, { ...init, forceRestart: true });
  assert.equal(killed, 0);
  assert.equal(spawned, 2);
  restart.emit('close');
  ownerOutput?.('still active');
  assert.match(owner.sent.join(''), /still active/);

  const reconnect = new FakeWebSocket();
  handleShellConnection(reconnect as never, base);
  await sendInit(reconnect, init);
  assert.match(reconnect.sent.join(''), /Reconnected to existing session/);
  assert.equal(killed, 0);
  assert.equal(spawned, 2);
});
test('overlapping forceRestart requests replace the current PTY without orphaning either replacement', async () => {
  let spawned = 0;
  const alive = new Set<number>();
  const capabilities = createAttachCapabilityService({ readPaneGeneration: async () => '101' });
  const capability = await capabilities.issue('user-1', tmux);
  assert.ok(capability);
  const init = {
    shellProtocolVersion: SHELL_PROTOCOL_VERSION,
    mode: 'typed-attach' as const,
    targetClass: 'attach-only' as const,
    sessionId: 'overlapping-force-restart',
    tmux,
    capability,
  };
  const outputListeners = new Map<number, (chunk: string) => void>();
  const spawn = (() => {
    const id = ++spawned;
    alive.add(id);
    return {
      ...fakePty(),
      onData: (listener: (chunk: string) => void) => { outputListeners.set(id, listener); },
      kill: () => { alive.delete(id); },
    };
  }) as never;
  const ownerDependencies = dependencies({
    principal: 'user-1',
    attachCapabilities: capabilities,
    assertTmuxPaneIdentity: async () => undefined,
    readTmuxSessionName: async () => 'external',
    spawn,
  });
  const owner = new FakeWebSocket();
  handleShellConnection(owner as never, ownerDependencies);
  await sendInit(owner, init);

  let releaseVerification: (() => void) | undefined;
  const verification = new Promise<void>((resolve) => { releaseVerification = resolve; });
  const restartDependencies = dependencies({
    ...ownerDependencies,
    attachCapabilities: {
      ...capabilities,
      createLease: async (...args) => { await verification; return capabilities.createLease(...args); },
    },
  });
  const first = new FakeWebSocket();
  const second = new FakeWebSocket();
  handleShellConnection(first as never, restartDependencies);
  handleShellConnection(second as never, restartDependencies);
  first.emit('message', Buffer.from(JSON.stringify({ type: 'init', projectPath: process.cwd(), ...init, forceRestart: true })));
  second.emit('message', Buffer.from(JSON.stringify({ type: 'init', projectPath: process.cwd(), ...init, forceRestart: true })));
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseVerification?.();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(spawned, 3);
  first.emit('close');
  outputListeners.get(3)?.('replacement remains attached');
  assert.match(second.sent.join(''), /replacement remains attached/);
  assert.equal(alive.size, 1);
  const reconnect = new FakeWebSocket();
  handleShellConnection(reconnect as never, ownerDependencies);
  await sendInit(reconnect, init);
  assert.match(reconnect.sent.join(''), /Reconnected to existing session/);
  assert.equal(alive.size, 1);
});

test('full redraw strips stale terminal queries without altering visible ANSI output', () => {
  assert.equal(
    stripTerminalQueriesForRedraw('before\x1b[>c\x1b[6nafter\x1b[31mred\x1b[0m'),
    'beforeafter\x1b[31mred\x1b[0m',
  );
});

test('reconnect with an acknowledged seq resumes seamlessly; legacy and gapped clients redraw', async () => {
  let output: ((chunk: string) => void) | undefined;
  const spawn = (() => ({
    ...fakePty(),
    onData: (listener: (chunk: string) => void) => { output = listener; },
  })) as never;
  const base = dependencies({ spawn });
  const init = {
    shellProtocolVersion: SHELL_PROTOCOL_VERSION,
    mode: 'plain-shell',
    sessionId: 'seq-resume',
    initialCommand: 'echo hi',
    isPlainShell: true,
  };

  const first = new FakeWebSocket();
  handleShellConnection(first as never, base);
  await sendInit(first, init);
  output?.('one\x1b[>c');
  output?.('two');
  output?.('three');
  // Live frames carry the sequence the client will acknowledge later.
  const liveSeqs = first.sent
    .map((frame) => JSON.parse(frame) as { type: string; seq?: number })
    .filter((frame) => frame.type === 'output' && typeof frame.seq === 'number')
    .map((frame) => frame.seq);
  assert.deepEqual(liveSeqs, [1, 2, 3]);
  const liveFirst = first.sent
    .map((frame) => JSON.parse(frame) as { type: string; data?: string; seq?: number })
    .find((frame) => frame.type === 'output' && frame.seq === 1);
  assert.equal(liveFirst?.data, 'one\x1b[>c');
  first.emit('close');

  // Seamless resume: the client saw seq 2, so only chunk 3 replays — no
  // banner, no repeated history.
  const resume = new FakeWebSocket();
  handleShellConnection(resume as never, base);
  await sendInit(resume, { ...init, lastSeq: 2 });
  const resumeFrames = resume.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  assert.deepEqual(resumeFrames[0], { type: 'replay_start', mode: 'resume' });
  assert.deepEqual(
    resumeFrames.filter((frame) => frame.type === 'output'),
    [{ type: 'output', data: 'three', seq: 3 }],
  );
  resume.emit('close');

  // Legacy client (no lastSeq): full redraw with the banner and every chunk.
  const legacy = new FakeWebSocket();
  handleShellConnection(legacy as never, base);
  await sendInit(legacy, init);
  const legacyFrames = legacy.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  assert.deepEqual(legacyFrames[0], { type: 'replay_start', mode: 'redraw' });
  assert.match(String(legacyFrames[1]?.data), /Reconnected to existing session/);
  assert.deepEqual(
    legacyFrames.filter((frame) => frame.type === 'output' && typeof frame.seq === 'number').map((frame) => frame.seq),
    [1, 2, 3],
  );
  const legacyFirst = legacyFrames.find((frame) => frame.type === 'output' && frame.seq === 1);
  assert.equal(legacyFirst?.data, 'one');
  legacy.emit('close');

  // A claimed seq the session never produced cannot resume: full redraw.
  const ahead = new FakeWebSocket();
  handleShellConnection(ahead as never, base);
  await sendInit(ahead, { ...init, lastSeq: 99 });
  assert.deepEqual(JSON.parse(ahead.sent[0] ?? '{}'), { type: 'replay_start', mode: 'redraw' });
});

test('attach-only rejects missing, wrong-principal, wrong-pane, expired, and changed-generation capabilities', async () => {
  let now = 1_000;
  let generation = '101';
  const capabilities = createAttachCapabilityService({
    now: () => now,
    ttlMs: 60_000,
    readPaneGeneration: async () => generation,
  });
  const capability = await capabilities.issue('user-1', tmux);
  assert.ok(capability);
  const cases = [
    { capability: undefined, principal: 'user-1', target: tmux },
    { capability, principal: 'user-2', target: tmux },
    { capability, principal: 'user-1', target: { ...tmux, paneId: '%4' } },
    { capability, principal: 'user-1', target: tmux, advanceTime: true },
    { capability, principal: 'user-1', target: tmux, changeGeneration: true },
  ];

  for (const scenario of cases) {
    now = 1_000;
    generation = '101';
    if (scenario.advanceTime) now += 60_000;
    if (scenario.changeGeneration) generation = '102';
    let spawned = 0;
    const ws = new FakeWebSocket();
    handleShellConnection(ws as never, dependencies({
      principal: scenario.principal,
      attachCapabilities: capabilities,
      spawn: (() => { spawned += 1; return fakePty(); }) as never,
    }));
    await sendInit(ws, {
      shellProtocolVersion: SHELL_PROTOCOL_VERSION,
      mode: 'typed-attach',
      targetClass: 'attach-only',
      tmux: scenario.target,
      capability: scenario.capability,
    });
    assert.equal(spawned, 0);
  }
});

test('attach-only rejects when tmux target or ChatMux pane protection cannot be read', async () => {
  const capabilities = createAttachCapabilityService({ readPaneGeneration: async () => '101' });
  const capability = await capabilities.issue('user-1', tmux);
  assert.ok(capability);
  for (const [index, { overrides, expectedMessage }] of [
    {
      overrides: { readTmuxSessionName: async () => null },
      expectedMessage: 'tmux target protection status could not be verified',
    },
    {
      overrides: { readTmuxSessionName: async () => '' },
      expectedMessage: 'tmux target protection status could not be verified',
    },
    {
      overrides: { readTmuxSessionName: async () => '   ' },
      expectedMessage: 'tmux target protection status could not be verified',
    },
    {
      overrides: { readTmuxSessionName: async () => { throw new Error('tmux failed'); } },
      expectedMessage: 'tmux failed',
    },
    {
      overrides: { readTmuxSessionName: async () => 'external', getCurrentTmuxPaneIdentity: async () => null },
      expectedMessage: 'ChatMux tmux pane protection status could not be verified',
    },
  ].entries()) {
    let spawned = 0;
    const ws = new FakeWebSocket();
    handleShellConnection(ws as never, dependencies({
      principal: 'user-1',
      attachCapabilities: capabilities,
      assertTmuxPaneIdentity: async () => undefined,
      spawn: (() => { spawned += 1; return fakePty(); }) as never,
      ...overrides,
    }));
    await sendInit(ws, {
      shellProtocolVersion: SHELL_PROTOCOL_VERSION,
      mode: 'typed-attach',
      targetClass: 'attach-only',
      sessionId: `protection-check-${index}`,
      tmux,
      capability,
    });
    assert.equal(spawned, 0);
    assert.match(String(error(ws).data), new RegExp(expectedMessage));
  }
});

test('attach diagnostics are rate-limited across connections and resume after one minute', async () => {
  let now = 1_000;
  const diagnostics: unknown[] = [];
  const rejectedInit = {
    shellProtocolVersion: SHELL_PROTOCOL_VERSION,
    mode: 'typed-attach',
    targetClass: 'local-agent',
    tmux,
    process: { pid: 9, startedAtMs: 1 },
  };
  const rejectionDependencies = dependencies({
    now: () => now,
    diagnostic: (event) => diagnostics.push(event),
    assertFreshExternalTmuxTarget: async () => createVerifiedTmuxActionTarget(tmux, { pid: 9, startedAtMs: 1 }, 'claude', 'company-secret'),
  });
  for (let index = 0; index < 2; index += 1) {
    const ws = new FakeWebSocket();
    handleShellConnection(ws as never, rejectionDependencies);
    await sendInit(ws, rejectedInit);
  }
  assert.deepEqual(diagnostics, [{ code: 'attach_refused_protected', provider: 'claude', count: 1 }]);
  now += 60_000;
  const ws = new FakeWebSocket();
  handleShellConnection(ws as never, rejectionDependencies);
  await sendInit(ws, rejectedInit);
  assert.deepEqual(diagnostics, [
    { code: 'attach_refused_protected', provider: 'claude', count: 1 },
    { code: 'attach_refused_protected', provider: 'claude', count: 3 },
  ]);
});

test('attach refusal diagnostics contain only code, provider, and count', async () => {
  const diagnostics: unknown[] = [];
  const ws = new FakeWebSocket();
  handleShellConnection(ws as never, dependencies({
    diagnostic: (event) => diagnostics.push(event),
    assertFreshExternalTmuxTarget: async () => createVerifiedTmuxActionTarget(tmux, { pid: 9, startedAtMs: 1 }, 'claude', 'company-secret'),
  }));
  await sendInit(ws, { shellProtocolVersion: SHELL_PROTOCOL_VERSION, mode: 'typed-attach', targetClass: 'local-agent', tmux, process: { pid: 9, startedAtMs: 1 } });
  assert.deepEqual(diagnostics, [{ code: 'attach_refused_protected', provider: 'claude', count: 1 }]);
  assert.equal(JSON.stringify(diagnostics).includes('/tmp/tmux.sock'), false);
  assert.equal(JSON.stringify(diagnostics).includes('company-secret'), false);
});
test('client source contains no tmux attach command string', () => {
  const sourceRoot = path.resolve(process.cwd(), 'src');
  const paths = fs.readdirSync(sourceRoot, { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string' && /\.(ts|tsx|js|jsx)$/.test(entry));
  for (const relativePath of paths) {
    const source = fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');
    assert.equal(/\btmux\s+attach(?:-session)?\b/.test(source), false, relativePath);
  }
});
