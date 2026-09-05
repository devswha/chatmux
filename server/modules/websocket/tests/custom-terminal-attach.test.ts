import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createAttachCapabilityService } from '@/modules/providers/index.js';
// eslint-disable-next-line boundaries/dependencies -- integration fixture exercises private classification through the terminal boundary.
import { classifyCustomTerminalSessions, classifyExternalSessions } from '@/modules/providers/services/external-cli-sessions/process-classification.js';

import { handleShellConnection, SHELL_PROTOCOL_VERSION, type ShellWebSocketDependencies } from '../services/shell-websocket.service.js';

const tmux = { socketPath: '/tmp/custom-attach-fixture.sock', sessionId: '$1', windowId: '@2', paneId: '%3' };

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: string[] = [];
  send(message: string): void { this.sent.push(message); }
  close(): void { this.readyState = 3; }
}

async function classifiedRow() {
  const panes = [{ name: 'custom-fixture', tmux, pid: 100, command: 'my-agent' }];
  const procs = [{ pid: 100, ppid: 1, comm: 'my-agent', args: 'my-agent chat' }];
  const fields = Array<string>(50).fill('0');
  fields[0] = 'S'; fields[1] = '1'; fields[2] = fields[3] = fields[5] = '100'; fields[4] = '34816'; fields[19] = '1234';
  const rows = await classifyCustomTerminalSessions({ sessions: classifyExternalSessions({ panes, procs }), panes, procs }, {
    env: { CHATMUX_CUSTOM_TERMINAL_AGENTS: '[{"command":"my-agent","argv":["chat"]}]' },
    platform: 'linux',
    readProcessRecord: async (_pid, record) => record === 'stat' ? `100 (my-agent) ${fields.join(' ')}\n` : 'my-agent\0chat\0',
  });
  assert.equal(rows[0].kind, 'shell');
  assert.equal(rows[0].agentPid, 100);
  return rows[0];
}

test('custom matched shell attaches only with an exact principal/pane capability using server-built argv', async () => {
  const row = await classifiedRow();
  let generation: string | null = '100';
  const capabilities = createAttachCapabilityService({ readPaneGeneration: async () => generation });
  const token = await capabilities.issue('owner', row.tmux);
  assert.ok(token);

  for (const [index, scenario] of [
    { expected: true },
    { principal: 'other', expected: false },
    { capability: 'unknown', expected: false },
    { target: { ...tmux, paneId: '%4' }, expected: false },
    { target: { ...tmux, windowId: '@4' }, expected: false },
    { target: { ...tmux, sessionId: '$4' }, expected: false },
    { target: { ...tmux, socketPath: '/tmp/other.sock' }, expected: false },
    { generation: '101', expected: false },
    { generation: null, expected: false },
    { protectedName: 'company-private', expected: false },
    { self: true, expected: false },
    { unavailable: true, expected: false },
    { identityChanged: true, expected: false },
  ].entries()) {
    generation = 'generation' in scenario ? scenario.generation! : '100';
    const commands: Array<{ shell: string; args: string[] }> = [];
    const ws = new FakeWebSocket();
    const deps: ShellWebSocketDependencies = {
      principal: 'principal' in scenario ? scenario.principal : 'owner',
      attachCapabilities: capabilities,
      resolveProviderSessionId: () => assert.fail('custom terminal must not resolve provider sessions'),
      stripAnsiSequences: (value) => value,
      normalizeDetectedUrl: () => null,
      extractUrlsFromText: () => [],
      shouldAutoOpenUrlFromOutput: () => false,
      diagnostic: () => undefined,
      readTmuxPaneIdentity: (value) => value as typeof tmux,
      assertTmuxPaneIdentity: async () => { if ('identityChanged' in scenario) throw new Error('stale exact identity'); },
      readTmuxSessionName: async () => 'protectedName' in scenario ? scenario.protectedName! : row.tmuxName,
      getCurrentTmuxPaneIdentityState: async () => 'unavailable' in scenario ? { state: 'unavailable' }
        : 'self' in scenario ? { state: 'hosted', tmux } : { state: 'not-hosted' },
      assertFreshExternalTmuxTarget: async () => assert.fail('shell attach must use capability, never provider authorization'),
      spawn: ((shell: string, args: string[]) => {
        commands.push({ shell, args });
        return { onData: () => undefined, onExit: () => undefined, write: () => undefined, resize: () => undefined, kill: () => undefined };
      }) as never,
    };
    handleShellConnection(ws as never, deps);
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'init', shellProtocolVersion: SHELL_PROTOCOL_VERSION, mode: 'typed-attach', targetClass: 'attach-only',
      projectPath: process.cwd(), sessionId: `custom-attach-${index}`,
      tmux: 'target' in scenario ? scenario.target : row.tmux,
      capability: 'capability' in scenario ? scenario.capability : token,
    })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(commands.length, scenario.expected ? 1 : 0, JSON.stringify(scenario));
    if (scenario.expected) {
      assert.match(commands[0].args[1], /select-window -t '@2'.*select-pane -t '%3'.*attach-session -t '\$1'/);
      assert.ok(commands[0].args[1].includes("tmux -S '/tmp/custom-attach-fixture.sock'"));
      assert.ok(!commands[0].args[1].includes('my-agent'));
    } else assert.ok(ws.sent.some((message) => message.includes('Error:')));
  }
});
