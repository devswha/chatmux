import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { RuntimeCapabilities } from '../../../../shared/terminal-runtime.js';
import { HerdrRuntimeAdapter } from '../herdr-runtime-adapter.service.js';
import type { HerdrConfiguredSource, HerdrRuntimeConfig } from '../herdr-config.service.js';
import type { HerdrClient } from '../herdr-client.service.js';
import type { HerdrResolvedSource } from '../herdr-internal.types.js';
import { RuntimeOperationPolicyService } from '../runtime-operation-policy.service.js';
import { ProtectedTerminalTargetService } from '../protected-terminal-target.service.js';

const source: HerdrConfiguredSource = { alias: 'alpha', sourceId: 'hsrc_jtP2rWhblZ6tcCJRjhr3bA', selector: 'work', binary: '/opt/herdr/herdr' };
const capabilities: RuntimeCapabilities = { discovery: true, output: true, actions: true, attach: true, create: false };
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false, oversized: false, spawnError: false });

async function liveSchema(): Promise<Record<string, unknown>> {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/herdr/v0.7.5-phase0.json', import.meta.url), 'utf8')) as { semanticManifest: { protocol: number; schemaVersion: string; api: { requests: Array<{ method: string; required: string[]; params: unknown }>; successEnvelope: Record<string, unknown>; selectedResultVariants: unknown[]; errorEnvelope: Record<string, unknown>; eventEnvelope: Record<string, unknown>; subscriptionEventEnvelope: Record<string, unknown>; definitions: Record<string, Record<string, unknown>> } } };
  const { api, protocol, schemaVersion } = fixture.semanticManifest;
  return { protocol, schema_version: schemaVersion, schemas: { request: { oneOf: api.requests.map((request) => ({ required: request.required, properties: { method: { const: request.method }, params: request.params } })), $defs: api.definitions.request }, success_response: { ...api.successEnvelope, $defs: { ...api.definitions.success_response, ResponseResult: { oneOf: api.selectedResultVariants } } }, error_response: { ...api.errorEnvelope, $defs: api.definitions.error_response }, event: { ...api.eventEnvelope, $defs: api.definitions.event }, subscription_event: { ...api.subscriptionEventEnvelope, $defs: api.definitions.subscription_event } } };
}

function agentInfo(agentStatus: unknown = 'working', terminalId = 'terminal-1', agent: unknown = 'claude', displayAgent: unknown = 'Claude Code') {
  return {
    agent,
    display_agent: displayAgent,
    agent_status: agentStatus,
    terminal_id: terminalId,
    workspace_id: 'workspace-1',
    tab_id: 'tab-1',
    pane_id: 'pane-1',
    focused: true,
    revision: 1,
  };
}
async function adapter(agentStatus: unknown = 'working', agent: unknown = 'claude', displayAgent: unknown = 'Claude Code', omitOptionalAgentFields = false, omitServerPid = false, protectedTargets: ProtectedTerminalTargetService = new ProtectedTerminalTargetService(() => ({ protected: false, identity: 'test-unprotected-target' }))) {
  const schema = await liveSchema();
  let terminalId = 'terminal-1';
  let serverStartedAtMs = 100;
  const calls = { version: 0, schema: 0, snapshot: 0, paneGet: 0, paneProcessInfo: 0 };
  const currentAgentStatus = agentStatus;
  const currentPane = () => {
    const value = agentInfo(currentAgentStatus, terminalId, agent, displayAgent);
    if (omitOptionalAgentFields) {
      delete value.agent;
      delete value.display_agent;
    }
    return value;
  };
  const client = {
    version: async () => { calls.version += 1; return ok('herdr 0.7.5\n'); },
    schema: async () => { calls.schema += 1; return ok(JSON.stringify(schema)); },
    status: async () => ok('{}'),
    sessionList: async () => ok(JSON.stringify({ result: { sessions: [{ name: 'work', running: true, socket_path: '/run/user/1000/herdr.sock', ...(omitServerPid ? {} : { server_pid: 10 }) }] } })),
    snapshot: async () => { calls.snapshot += 1; return ok(JSON.stringify({ result: { type: 'session_snapshot', snapshot: { panes: [currentPane()], agents: [currentPane()] } } })); },
    paneGet: async () => { calls.paneGet += 1; return ok(JSON.stringify({ result: { type: 'pane_info', pane: currentPane() } })); },
    paneProcessInfo: async () => { calls.paneProcessInfo += 1; return ok(JSON.stringify({ result: { type: 'pane_process_info', process_info: { foreground_processes: [{ pid: 42, name: 'claude' }], foreground_process_group_id: 42 } } })); },
    paneRead: async () => ok('visible output'), paneSendText: async () => ok('{}'), paneSendKeys: async () => ok('{}'),
    controllerArgv: (_source: HerdrResolvedSource, paneId: string, cols: number, rows: number) => ['--session', 'work', 'terminal', 'session', 'control', paneId, '--cols', String(cols), '--rows', String(rows)],
  } as unknown as HerdrClient;
  const policy = new RuntimeOperationPolicyService(capabilities, [source.sourceId]);
  const fs = { realpath: async (path: string) => path, lstat: async () => ({ isFile: () => true, isSocket: () => true, isSymbolicLink: () => false, uid: process.getuid?.() ?? 0, mode: 0o140600, dev: 1, ino: 2 }) };
  const config: HerdrRuntimeConfig = { enabled: true, sources: [source], startupCapabilities: capabilities, policyPath: null, errorCode: null };
  return {
    runtime: new HerdrRuntimeAdapter(config, policy, undefined, client, () => 'generic-admission-capability-1234', fs as never, async (pid) => pid === 10 ? { pid, startedAtMs: serverStartedAtMs } : pid === 42 ? { pid, startedAtMs: 100 } : null, async () => ({ pid: 10, startedAtMs: serverStartedAtMs }), protectedTargets),
    replaceTerminal: () => { terminalId = 'terminal-2'; },
    replaceServer: () => { serverStartedAtMs += 1; },
    calls,
  };
}

test('adapter accepts exact v0.7.5 AgentInfo and keeps it attach-only without local actions', async () => {
  const { runtime, replaceTerminal } = await adapter();
  const [target] = await runtime.discover();
  assert.ok(target && target.runtime === 'herdr' && target.targetClass === 'attach-only');
  assert.equal(JSON.stringify(target).includes('pane-1'), false);
  assert.deepEqual(await runtime.read({ runtime: 'herdr', sourceId: source.sourceId, targetId: target.targetId }), { ansi: 'visible output', truncated: false });
  assert.equal(await runtime.send({ runtime: 'herdr', sourceId: source.sourceId, targetId: target.targetId }, 'blocked'), false);
  replaceTerminal();
  assert.equal(await runtime.read({ runtime: 'herdr', sourceId: source.sourceId, targetId: target.targetId }), null);
  assert.equal(runtime.capabilities(source.sourceId).create, false);
});
test('adapter invalidates a target when the server process generation changes on the same socket', async () => {
  const { runtime, replaceServer } = await adapter();
  const [target] = await runtime.discover();
  assert.ok(target?.runtime === 'herdr');
  replaceServer();
  assert.equal(await runtime.verify({ runtime: 'herdr', sourceId: source.sourceId, targetId: target.targetId }, 'attach'), false);
});
test('adapter resolves the server owner from its socket when v0.7.5 omits server_pid', async () => {
  const { runtime } = await adapter('working', 'claude', 'Claude Code', false, true);
  const [target] = await runtime.discover();
  assert.ok(target?.runtime === 'herdr');
});

test('fresh target verification reuses static compatibility and avoids a full snapshot scan', async () => {
  const { runtime, calls } = await adapter();
  const [target] = await runtime.discover();
  assert.ok(target?.runtime === 'herdr');
  assert.deepEqual(calls, { version: 1, schema: 1, snapshot: 1, paneGet: 0, paneProcessInfo: 0 });
  assert.equal(await runtime.verify({ runtime: 'herdr', sourceId: source.sourceId, targetId: target.targetId }, 'attach'), true);
  assert.deepEqual(calls, { version: 1, schema: 1, snapshot: 1, paneGet: 1, paneProcessInfo: 0 });
});
test('adapter accepts schema-valid panes with omitted optional agent fields', async () => {
  const { runtime } = await adapter('unknown', null, null, true);
  const [target] = await runtime.discover();
  assert.ok(target?.runtime === 'herdr');
});
test('adapter denies a server-classified protected Herdr source', async () => {
  const protection = new ProtectedTerminalTargetService(() => ({ protected: true, identity: 'terminal-1:self' }));
  const { runtime } = await adapter('working', 'claude', 'Claude Code', false, false, protection);
  assert.deepEqual(await runtime.discover(), []);
});
test('default protection denies the Herdr source hosting ChatMux', async () => {
  const previousEnv = process.env.HERDR_ENV;
  const previousSession = process.env.HERDR_SESSION;
  process.env.HERDR_ENV = '1';
  process.env.HERDR_SESSION = 'work';
  try {
    const { runtime } = await adapter('working', 'claude', 'Claude Code', false, false, new ProtectedTerminalTargetService());
    assert.deepEqual(await runtime.discover(), []);
  } finally {
    if (previousEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousEnv;
    if (previousSession === undefined) delete process.env.HERDR_SESSION;
    else process.env.HERDR_SESSION = previousSession;
  }
});

test('adapter gives generic attach-only admission and enforces single-use no-takeover controller leases', async () => {
  const { runtime } = await adapter();
  const [target] = await runtime.discover();
  assert.ok(target && target.runtime === 'herdr' && target.targetClass === 'attach-only');
  assert.deepEqual({ targetClass: target.targetClass, admissionCapability: target.admissionCapability }, { targetClass: 'attach-only', admissionCapability: 'generic-admission-capability-1234' });
  assert.equal(await runtime.send({ runtime: 'herdr', sourceId: source.sourceId, targetId: target!.targetId }, 'blocked'), false);
  const first = await runtime.controllerArgv({ runtime: 'herdr', sourceId: source.sourceId, targetId: target!.targetId }, 80, 24);
  assert.ok(first);
  assert.equal(await runtime.controllerArgv({ runtime: 'herdr', sourceId: source.sourceId, targetId: target!.targetId }, 80, 24), null);
  first.release();
  assert.ok(await runtime.controllerArgv({ runtime: 'herdr', sourceId: source.sourceId, targetId: target!.targetId }, 80, 24));
});
test('adapter fails closed for malformed frozen AgentInfo fields', async () => {
  for (const [agentStatus, agent, displayAgent] of [
    [{ kind: 'claude', protected: false }, 'claude', 'Claude Code'],
    ['working', { id: 'claude' }, 'Claude Code'],
    ['working', 'claude', { value: 'Claude Code' }],
  ]) {
    const { runtime } = await adapter(agentStatus, agent, displayAgent);
    assert.deepEqual(await runtime.discover(), []);
  }
});
