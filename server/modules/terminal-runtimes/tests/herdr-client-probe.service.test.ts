import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { HERDR_LIMITS, HerdrClient, type HerdrSpawn } from '../herdr-client.service.js';
import type { HerdrConfiguredSource } from '../herdr-config.service.js';
import {
  HERDR_SEMANTIC_FINGERPRINT,
  HERDR_VERSION,
  canonicalJsonSha256,
  probeHerdrCompatibility,
  selectedHerdrSemanticManifest,
  semanticFingerprint,
} from '../herdr-probe.service.js';

const source: HerdrConfiguredSource = { alias: 'alpha', sourceId: 'hsrc_jtP2rWhblZ6tcCJRjhr3bA', selector: 'work', binary: '/opt/herdr/herdr' };
const ok = { code: 0, stdout: '', stderr: '', timedOut: false, oversized: false, spawnError: false };

type SpawnCall = { command: string; args: readonly string[]; options: Parameters<HerdrSpawn>[2] };
function child(): { process: unknown; stdout: EventEmitter; stderr: EventEmitter; stdin: { end(value?: string): void }; kills: string[] } {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const process = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { end(value?: string): void }; kill(signal: string): void };
  const kills: string[] = [];
  process.stdout = stdout;
  process.stderr = stderr;
  process.stdin = { end: () => undefined };
  process.kill = (signal) => { kills.push(signal); };
  return { process, stdout, stderr, stdin: process.stdin, kills };
}

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL('./fixtures/herdr/v0.7.5-phase0.json', import.meta.url), 'utf8')) as Record<string, unknown>;
}
async function reviewedSchema(): Promise<Record<string, unknown>> {
  const report = await fixture() as { semanticManifest: {
    protocol: number;
    schemaVersion: string;
    api: {
      requests: Array<{ method: string; required: string[]; params: unknown }>;
      successEnvelope: Record<string, unknown>;
      selectedResultVariants: unknown[];
      errorEnvelope: Record<string, unknown>;
      eventEnvelope: Record<string, unknown>;
      subscriptionEventEnvelope: Record<string, unknown>;
      definitions: Record<string, Record<string, unknown>>;
    };
  } };
  const { api, protocol, schemaVersion } = report.semanticManifest;
  return {
    protocol,
    schema_version: schemaVersion,
    schemas: {
      request: {
        oneOf: api.requests.map((request) => ({
          required: request.required,
          properties: { method: { const: request.method }, params: request.params },
        })),
        $defs: api.definitions.request,
      },
      success_response: {
        ...api.successEnvelope,
        $defs: { ...api.definitions.success_response, ResponseResult: { oneOf: api.selectedResultVariants } },
      },
      error_response: { ...api.errorEnvelope, $defs: api.definitions.error_response },
      event: { ...api.eventEnvelope, $defs: api.definitions.event },
      subscription_event: { ...api.subscriptionEventEnvelope, $defs: api.definitions.subscription_event },
    },
  };
}

function compatibleClient(schema: unknown, overrides: Partial<Record<'version' | 'schema' | 'status' | 'snapshot', typeof ok>> = {}): HerdrClient {
  return {
    version: async () => ({ ...ok, stdout: `herdr ${HERDR_VERSION}\n`, ...overrides.version }),
    schema: async () => ({ ...ok, stdout: JSON.stringify(schema), ...overrides.schema }),
    status: async () => ({ ...ok, ...overrides.status }),
    snapshot: async () => ({ ...ok, ...overrides.snapshot }),
  } as unknown as HerdrClient;
}

test('Herdr client uses exact non-shell argv for all supported reads and actions', async () => {
  const calls: SpawnCall[] = [];
  const client = new HerdrClient(((command: string, args: readonly string[], options: Parameters<HerdrSpawn>[2]) => {
    calls.push({ command, args, options });
    const fake = child();
    queueMicrotask(() => (fake.process as EventEmitter).emit('close', 0));
    return fake.process as never;
  }) as never);
  await Promise.all([
    client.schema(source), client.status(source), client.snapshot(source), client.paneGet(source, 'pane_1'), client.paneRead(source, 'pane_1'),
    client.paneProcessInfo(source, 'pane_1'), client.paneSendText(source, 'pane_1', 'hello'), client.paneSendKeys(source, 'pane_1', ['CTRL-C', 'enter']),
  ]);
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    [source.binary, ['api', 'schema', '--json']],
    [source.binary, ['--session', 'work', 'status', 'server']],
    [source.binary, ['--session', 'work', 'api', 'snapshot']],
    [source.binary, ['--session', 'work', 'pane', 'get', 'pane_1']],
    [source.binary, ['--session', 'work', 'pane', 'read', 'pane_1', '--source', 'visible', '--ansi']],
    [source.binary, ['--session', 'work', 'pane', 'process-info', '--pane', 'pane_1']],
    [source.binary, ['--session', 'work', 'pane', 'send-text', 'pane_1', 'hello']],
    [source.binary, ['--session', 'work', 'pane', 'send-keys', 'pane_1', 'CTRL-C', 'enter']],
  ]);
  assert.ok(calls.every(({ options }) => options.shell === false && options.stdio === 'pipe' && options.windowsHide === true));
  assert.deepEqual(client.controllerArgv(source, 'pane_1', 120, 40), ['--session', 'work', 'terminal', 'session', 'control', 'pane_1', '--cols', '120', '--rows', '40']);
  assert.throws(() => client.paneGet(source, '../bad'), /invalid_pane_id/);
  assert.throws(() => client.paneSendText(source, 'pane_1', ''), /invalid_input/);
  assert.throws(() => client.paneSendKeys(source, 'pane_1', []), /invalid_keys/);
  assert.throws(() => client.controllerArgv(source, 'pane_1', 0, 40), /invalid_controller_target/);
  assert.equal(Object.getOwnPropertyNames(HerdrClient.prototype).some((name) => /create|start|stop|kill|lifecycle/i.test(name)), false);
});
test('Herdr client preserves UTF-8 split across stdout chunks', async () => {
  const expected = '한글🐑';
  const encoded = Buffer.from(expected, 'utf8');
  const client = new HerdrClient((() => {
    const fake = child();
    queueMicrotask(() => {
      fake.stdout.emit('data', encoded.subarray(0, 2));
      fake.stdout.emit('data', encoded.subarray(2, 7));
      fake.stdout.emit('data', encoded.subarray(7));
      (fake.process as EventEmitter).emit('close', 0);
    });
    return fake.process as never;
  }) as never);
  const result = await client.paneRead(source, 'pane_1');
  assert.equal(result.stdout, expected);
});

test('Herdr client reports spawn errors and enforces output, timeout, and NDJSON line bounds', async () => {
  const spawnFailure = new HerdrClient((() => { throw new Error('missing'); }) as never);
  assert.deepEqual(await spawnFailure.version(source), { code: null, stdout: '', stderr: '', timedOut: false, oversized: false, spawnError: true });

  const fake = child();
  const clock = { setTimeout: ((callback: () => void) => { queueMicrotask(callback); return 1 as never; }) as unknown as typeof setTimeout, clearTimeout: (() => undefined) as typeof clearTimeout };
  const timeoutClient = new HerdrClient((() => fake.process as never) as never, clock);
  const pending = timeoutClient.version(source);
  queueMicrotask(() => (fake.process as EventEmitter).emit('close', null));
  const timedOut = await pending;
  assert.equal(timedOut.timedOut, true);
  assert.deepEqual(fake.kills, ['SIGKILL']);

  const oversized = child();
  const bounded = new HerdrClient((() => {
    queueMicrotask(() => { oversized.stdout.emit('data', Buffer.alloc(HERDR_LIMITS.version.stdoutBytes + 1)); (oversized.process as EventEmitter).emit('close', null); });
    return oversized.process as never;
  }) as never);
  assert.equal((await bounded.version(source)).oversized, true);
  const stderrOverflowProcess = child();
  const stderrBounded = new HerdrClient((() => {
    queueMicrotask(() => {
      stderrOverflowProcess.stderr.emit('data', Buffer.alloc(HERDR_LIMITS.version.stderrBytes + 1, 0x78));
      (stderrOverflowProcess.process as EventEmitter).emit('close', null);
    });
    return stderrOverflowProcess.process as never;
  }) as never);
  const stderrOverflow = await stderrBounded.version(source);
  assert.equal(stderrOverflow.stderrOverflow, true);
  assert.equal(stderrOverflow.oversized, true);
  assert.equal(Buffer.byteLength(stderrOverflow.stderr, 'utf8'), HERDR_LIMITS.version.stderrBytes);
  assert.deepEqual(stderrOverflowProcess.kills, ['SIGKILL']);
  assert.equal(await bounded.ndjson({ ...ok, stdout: `${'x'.repeat(HERDR_LIMITS.ndjsonLineBytes + 1)}\n` }), null);
  assert.equal(await bounded.ndjson({ ...ok, stdout: '{bad}\n' }), null);
  const stderrTooLarge = await probeHerdrCompatibility(source, { discovery: true, output: true, actions: true, attach: true, create: false }, compatibleClient(await fixture(), { schema: { ...ok, stderr: 'x'.repeat(HERDR_LIMITS.schema.stderrBytes + 1) } }), 'linux', 'x64');
  assert.equal(stderrTooLarge.reasonCode, 'schema_unavailable');
});

test('Phase0 semantic fingerprint is stable for additive unrelated schemas and changes for selected contracts', async () => {
  const phase0 = await reviewedSchema();
  assert.equal(semanticFingerprint(phase0), HERDR_SEMANTIC_FINGERPRINT);
  const additive = structuredClone(phase0) as { schemas: Record<string, unknown> };
  additive.schemas.unrelated_future_schema = { type: 'object', properties: { ignored: { type: 'string' } } };
  assert.equal(semanticFingerprint(additive), HERDR_SEMANTIC_FINGERPRINT);

  const requestDrift = structuredClone(phase0) as { schemas: { request: { oneOf: Array<{ properties: { method: { const: string } } }> } } };
  requestDrift.schemas.request.oneOf.find((entry) => entry.properties.method.const === 'pane.get')!.properties.method.const = 'pane.get.changed';
  assert.notEqual(semanticFingerprint(requestDrift), HERDR_SEMANTIC_FINGERPRINT);
  const eventDrift = structuredClone(phase0) as { schemas: { event: Record<string, unknown> } };
  eventDrift.schemas.event.additionalProperties = false;
  assert.notEqual(semanticFingerprint(eventDrift), HERDR_SEMANTIC_FINGERPRINT);
  const unresolvedReference = structuredClone(phase0) as { schemas: { request: { oneOf: Array<{ properties: { method: { const: string }; params: unknown } }> } } };
  unresolvedReference.schemas.request.oneOf.find((entry) => entry.properties.method.const === 'pane.get')!.properties.params = { $ref: '#/schemas/request/$defs/Missing' };
  assert.equal(semanticFingerprint(unresolvedReference), null);
  const schemaVersionDrift = structuredClone(await reviewedSchema()) as { schema_version: unknown };
  schemaVersionDrift.schema_version = 'wrong-protocol';
  assert.notEqual(semanticFingerprint(schemaVersionDrift), HERDR_SEMANTIC_FINGERPRINT);
  const manifest = selectedHerdrSemanticManifest(phase0)! as { control: { transport: { pty: boolean } } };
  const controlDrift = structuredClone(manifest);
  controlDrift.control.transport.pty = true;
  assert.notEqual(canonicalJsonSha256(controlDrift), HERDR_SEMANTIC_FINGERPRINT);
});

test('compatibility probe fails closed and redacts readiness for invalid or unavailable sources', async () => {
  const phase0 = await reviewedSchema();
  const capabilities = { discovery: true, output: true, actions: true, attach: true, create: true };
  const ready = await probeHerdrCompatibility(source, capabilities, compatibleClient(phase0), 'linux', 'x64');
  assert.deepEqual(ready, { sourceId: source.sourceId, readiness: 'ready', version: HERDR_VERSION, semanticFingerprint: HERDR_SEMANTIC_FINGERPRINT, transport: 'herdr terminal session control', capabilities: { ...capabilities, create: false }, reasonCode: null });
  const cases: Array<[string, HerdrClient, string]> = [
    ['wrong version', compatibleClient(phase0, { version: { ...ok, stdout: 'herdr 9.0.0\n' } }), 'version_unsupported'],
    ['malformed schema', compatibleClient(phase0, { schema: { ...ok, stdout: '{' } }), 'schema_invalid'],
    ['unreviewed schema', compatibleClient({ schemas: {} }), 'schema_semantics_unreviewed'],
    ['missing binary', compatibleClient(phase0, { version: { ...ok, spawnError: true } }), 'binary_unavailable'],
    ['offline status', compatibleClient(phase0, { status: { ...ok, code: 1 } }), 'source_offline'],
    ['missing snapshot', compatibleClient(phase0, { snapshot: { ...ok, code: 1 } }), 'snapshot_unavailable'],
  ];
  for (const [, client, reasonCode] of cases) {
    const result = await probeHerdrCompatibility(source, capabilities, client, 'linux', 'x64');
    assert.equal(result.reasonCode, reasonCode);
    assert.notEqual(result.readiness, 'ready');
    assert.equal(result.transport, null);
    assert.deepEqual(result.capabilities, { discovery: false, output: false, actions: false, attach: false, create: false });
  }
  const unsupported = await probeHerdrCompatibility(source, capabilities, compatibleClient(phase0), 'darwin', 'arm64');
  assert.equal(unsupported.readiness, 'platform_unsupported');
  assert.equal(unsupported.transport, null);
});
