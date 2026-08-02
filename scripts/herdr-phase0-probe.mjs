#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, platform, arch, tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';

const EXPECTED_PROTOCOL = 17;
const OFFICIAL_SHA256 = '3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253';
const COMMAND_TIMEOUT_MS = 10_000;
const SERVER_START_TIMEOUT_MS = 10_000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_NDJSON_LINE_BYTES = 2 * 1024 * 1024;
const MAX_NDJSON_RECORDS = 2_048;
const MAX_ENCODED_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_DECODED_FRAME_BYTES = 1024 * 1024;
const MAX_TOTAL_DECODED_FRAME_BYTES = 4 * 1024 * 1024;
const REQUIRED_METHODS = ['agent.list', 'events.subscribe', 'pane.get', 'pane.list', 'pane.move', 'pane.process_info', 'pane.read', 'pane.send_keys', 'pane.send_text', 'session.snapshot'];
const METHOD_RESULT_TAGS = Object.freeze({
  'agent.list': 'agent_list',
  'events.subscribe': 'subscription_started',
  'pane.get': 'pane_info',
  'pane.list': 'pane_list',
  'pane.move': 'pane_move',
  'pane.process_info': 'pane_process_info',
  'pane.read': 'pane_read',
  'pane.send_keys': 'ok',
  'pane.send_text': 'ok',
  'session.snapshot': 'session_snapshot',
});
const CONTROL_SEMANTICS = Object.freeze({
  transport: {
    executable: 'verified absolute path',
    argv: ['--session', '<validated-name>', 'terminal', 'session', 'control', '<pane-id>', '--cols', '<1..1000>', '--rows', '<1..1000>'],
    stdin: 'newline-delimited JSON',
    stdout: 'newline-delimited JSON',
    shell: false,
    pty: false,
    takeover: false,
  },
  inputVariants: [
    { type: { const: 'terminal.input' }, text: { type: 'string' }, exclusiveWith: 'bytes' },
    { type: { const: 'terminal.input' }, bytes: { type: 'string', encoding: 'base64' }, exclusiveWith: 'text' },
  ],
  resize: { type: { const: 'terminal.resize' }, cols: { type: 'integer', minimum: 1 }, rows: { type: 'integer', minimum: 1 } },
  scroll: { type: { const: 'terminal.scroll' }, direction: { enum: ['up', 'down'] }, lines: { type: 'integer', minimum: 1 } },
  release: { type: { const: 'terminal.release' }, effect: 'controller exits and no-takeover reacquisition succeeds' },
  frame: {
    required: ['type', 'seq', 'encoding', 'width', 'height', 'full', 'bytes'],
    properties: {
      type: { const: 'terminal.frame' },
      seq: { type: 'integer', ordering: 'strictly contiguous within one controller' },
      encoding: { const: 'ansi' },
      width: { type: 'integer', minimum: 1 },
      height: { type: 'integer', minimum: 1 },
      full: { type: 'boolean' },
      bytes: { type: 'string', encoding: 'base64' },
    },
  },
  closed: { required: ['type', 'reason'], properties: { type: { const: 'terminal.closed' }, reason: { type: 'string' } } },
  busy: { record: 'terminal.closed', reasonContains: 'already has an attached client', processExitCodeAuthoritative: false },
  sourceSelection: { namedSessionRequired: true, missingSnapshotFails: true, missingStatusNotRunning: true, missingControlFails: true, postControlSocketAbsent: true },
});

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function semanticFingerprint(value) { return sha256(canonicalJson(value)); }
function schemaDefinitionRefs(value) {
  const refs = [];
  for (const match of JSON.stringify(value).matchAll(/#\/schemas\/([^/]+)\/\$defs\/([^"]+)/g)) {
    refs.push({ schemaName: match[1], definitionName: match[2] });
  }
  return refs;
}
function collectSchemaDefinitions(schemas, retainedValues) {
  const selected = {};
  const pending = retainedValues.flatMap(schemaDefinitionRefs);
  while (pending.length) {
    const { schemaName, definitionName } = pending.shift();
    selected[schemaName] ??= {};
    if (selected[schemaName][definitionName]) continue;
    const definition = schemas[schemaName]?.$defs?.[definitionName];
    if (!definition) throw new Error(`unresolved schema definition ${schemaName}.${definitionName}`);
    selected[schemaName][definitionName] = definition;
    pending.push(...schemaDefinitionRefs(definition));
  }
  return Object.fromEntries(Object.entries(selected)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([schemaName, definitions]) => [
      schemaName,
      Object.fromEntries(Object.entries(definitions).sort(([left], [right]) => left.localeCompare(right))),
    ]));
}
function assertSemanticReferenceClosure(manifest) {
  for (const { schemaName, definitionName } of schemaDefinitionRefs(manifest)) {
    if (!manifest.api.definitions[schemaName]?.[definitionName]) {
      throw new Error(`semantic manifest has unresolved reference ${schemaName}.${definitionName}`);
    }
  }
}
function extractApiSemantics(schema) {
  const requests = REQUIRED_METHODS.map(method => {
    const request = schema.schemas.request.oneOf.find(item => item.properties?.method?.const === method);
    if (!request) throw new Error(`required method ${method} is absent`);
    return {
      method,
      required: [...(request.required ?? [])].sort(),
      params: request.properties?.params ?? null,
    };
  });
  const successSchema = schema.schemas.success_response;
  const errorSchema = schema.schemas.error_response;
  const resultVariants = Object.values(METHOD_RESULT_TAGS).map(tag => {
    const variant = successSchema.$defs.ResponseResult.oneOf.find(item => item.properties?.type?.const === tag);
    if (!variant) throw new Error(`required response result ${tag} is absent`);
    return variant;
  });
  const successEnvelope = structuredClone(Object.fromEntries(Object.entries(successSchema).filter(([key]) => key !== '$defs')));
  successEnvelope.properties.result = { oneOf: resultVariants };
  const errorEnvelope = Object.fromEntries(Object.entries(errorSchema).filter(([key]) => key !== '$defs'));
  const eventEnvelope = Object.fromEntries(Object.entries(schema.schemas.event).filter(([key]) => key !== '$defs'));
  const subscriptionEventEnvelope = Object.fromEntries(Object.entries(schema.schemas.subscription_event).filter(([key]) => key !== '$defs'));
  const retainedValues = [...requests.map(request => request.params), ...resultVariants, successEnvelope, errorEnvelope, eventEnvelope, subscriptionEventEnvelope];
  return {
    requests,
    methodResultTags: METHOD_RESULT_TAGS,
    successEnvelope,
    selectedResultVariants: resultVariants,
    errorEnvelope,
    eventEnvelope,
    subscriptionEventEnvelope,
    definitions: collectSchemaDefinitions(schema.schemas, retainedValues),
  };
}
function parseArgs(argv) {
  const options = { binary: '', expectedSha256: '', expectedAbsentPath: '', output: '', restrictedOutput: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--binary') options.binary = argv[++i] ?? '';
    else if (key === '--expected-sha256') options.expectedSha256 = argv[++i] ?? '';
    else if (key === '--expected-absent-path') options.expectedAbsentPath = argv[++i] ?? '';
    else if (key === '--output') options.output = argv[++i] ?? '';
    else if (key === '--restricted-output') options.restrictedOutput = argv[++i] ?? '';
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!isAbsolute(options.binary) || !isAbsolute(options.expectedAbsentPath) || !isAbsolute(options.output) || !isAbsolute(options.restrictedOutput)) throw new Error('--binary, --expected-absent-path, --output, and --restricted-output must be absolute');
  if (options.output === options.restrictedOutput) throw new Error('public and restricted output paths must differ');
  if (!/^[0-9a-f]{64}$/i.test(options.expectedSha256)) throw new Error('--expected-sha256 must be a SHA-256 hex digest');
  if (options.expectedSha256.toLowerCase() !== OFFICIAL_SHA256) throw new Error('expected digest must equal the pinned official v0.7.5 Linux x86_64 digest');
  return options;
}
function boundedAppend(current, chunk, label, limit = MAX_CAPTURE_BYTES) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  if (next.length > limit) throw new Error(`${label} exceeded ${limit} bytes`);
  return next;
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
async function regularOwnedExecutable(path, uid) {
  const info = await lstat(path);
  return info.isFile() && !info.isSymbolicLink() && info.uid === uid && (info.mode & 0o777) === 0o755;
}
function safeError(error) { return error instanceof Error ? error.message.replaceAll(homedir(), '<home>') : String(error); }
function redact(value, sensitive) {
  if (typeof value === 'string') return sensitive.reduce((text, item) => item ? text.replaceAll(item, '<redacted>') : text, value);
  if (Array.isArray(value)) return value.map(item => redact(item, sensitive));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, sensitive)]));
  return value;
}
function createTracker(runRoot, baseEnv, cancellation) {
  const children = new Set();
  return {
    spawn(binary, args, options = {}) {
      const { allowAfterCancel = false, ...spawnOptions } = options;
      if (cancellation.signal && allowAfterCancel) cancellation.cleanupSpawnsAfterSignal += 1;
      if (cancellation.signal && !allowAfterCancel) {
        cancellation.blockedProductSpawnAttempts += 1;
        const error = new Error(`Phase 0 cancelled by ${cancellation.signal}`);
        error.code = 'PHASE0_CANCELLED';
        throw error;
      }
      const child = spawn(binary, args, {
        cwd: runRoot,
        ...spawnOptions,
        env: { ...process.env, NO_COLOR: '1', ...baseEnv, ...spawnOptions.env },
      });
      children.add(child);
      child.once('close', () => children.delete(child));
      child.once('error', () => children.delete(child));
      return child;
    },
    async closeAll() {
      const active = [...children].filter(child => child.exitCode === null);
      for (const child of active) child.kill('SIGTERM');
      await Promise.all(active.map(async child => {
        try {
          await waitForExit(child, 1_000, 'tracked child');
        } catch {
          if (child.exitCode === null) child.kill('SIGKILL');
          await waitForExit(child, 1_000, 'tracked child SIGKILL');
        }
      }));
      await new Promise(resolve => setImmediate(resolve));
    },
    activeChildCount() { return [...children].filter(child => child.exitCode === null).length; },
  };
}
function run(tracker, binary, args, { timeoutMs = COMMAND_TIMEOUT_MS, allowFailure = false, allowAfterCancel = false, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = tracker.spawn(binary, args, { allowAfterCancel, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let settled = false;
    const fail = error => { if (!settled) { settled = true; child.kill('SIGTERM'); clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => fail(new Error(`${basename(binary)} ${args.join(' ')} timed out`)), timeoutMs);
    child.stdout.on('data', chunk => { try { stdout = boundedAppend(stdout, chunk, 'stdout'); } catch (error) { fail(error); } });
    child.stderr.on('data', chunk => { try { stderr = boundedAppend(stderr, chunk, 'stderr'); } catch (error) { fail(error); } });
    child.once('error', fail);
    child.once('close', (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const result = { code: code ?? -1, signal, stdout, stderr };
      if (!allowFailure && result.code !== 0) reject(new Error(`${basename(binary)} ${args.join(' ')} failed (${result.code}): ${stderr.toString('utf8').trim()}`));
      else resolve(result);
    });
  });
}
function jsonOutput(result) { return JSON.parse(result.stdout.toString('utf8')); }
function waitUntil(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch (error) {
        if (error?.code === 'PHASE0_CANCELLED') return reject(error);
      }
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(poll, 50);
    }; poll();
  });
}
async function waitForExit(child, timeoutMs, label) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([new Promise(resolve => child.once('close', code => resolve(code ?? -1))), new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs))]);
}
function lineReader(stream, label) {
  let pending = Buffer.alloc(0); const values = []; let failure = null; let encodedBytes = 0; let receivedBytes = 0;
  stream.on('data', chunk => {
    if (failure) return;
    try {
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > MAX_CAPTURE_BYTES) throw new Error(`${label} exceeded cumulative NDJSON byte limit`);
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      let newline;
      while ((newline = pending.indexOf(0x0a)) >= 0) {
        const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
        if (!line.length) continue;
        encodedBytes += line.length;
        if (line.length > MAX_NDJSON_LINE_BYTES || encodedBytes > MAX_CAPTURE_BYTES || values.length >= MAX_NDJSON_RECORDS) throw new Error(`${label} exceeded NDJSON limits`);
        values.push(JSON.parse(line.toString('utf8')));
      }
      if (pending.length > MAX_NDJSON_LINE_BYTES) throw new Error(`${label} line exceeds ${MAX_NDJSON_LINE_BYTES} bytes`);
    } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
  });
  return { values, get failure() { return failure; } };
}
function validateFrames(frames) {
  let decodedTotal = 0; const decoded = [];
  for (const frame of frames) {
    if (!Number.isInteger(frame.seq)) throw new Error('terminal.frame seq must be an integer');
    if (frame.type !== 'terminal.frame' || frame.encoding !== 'ansi' || !Number.isInteger(frame.width) || frame.width < 1 || !Number.isInteger(frame.height) || frame.height < 1 || typeof frame.full !== 'boolean') throw new Error('terminal.frame shape mismatch');
    if (typeof frame.bytes !== 'string' || Buffer.byteLength(frame.bytes, 'ascii') > MAX_ENCODED_FRAME_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.bytes)) throw new Error('terminal.frame bytes is invalid or exceeds encoded limit');
    const value = Buffer.from(frame.bytes, 'base64');
    if (value.length > MAX_DECODED_FRAME_BYTES || (decodedTotal += value.length) > MAX_TOTAL_DECODED_FRAME_BYTES) throw new Error('terminal.frame decoded bytes exceed limit');
    decoded.push(value);
  }
  if (!frames.length) throw new Error('control emitted no terminal.frame');
  const contiguous = frames.every((frame, index) => index === 0 || frame.seq === frames[index - 1].seq + 1);
  if (!contiguous) throw new Error('terminal.frame sequence is not contiguous');
  const text = Buffer.concat(decoded).toString('utf8');
  return {
    frameObserved: true,
    sequence: { firstIsOne: frames[0].seq === 1, contiguous, lastAtLeastFirst: frames.at(-1).seq >= frames[0].seq },
    shapeValidated: true,
    validBase64BeforeAllocation: true,
    encodedWithinLimit: true,
    decodedWithinLimit: true,
    cumulativeDecodedWithinLimit: decodedTotal <= MAX_TOTAL_DECODED_FRAME_BYTES,
    ansiEvidence: text.includes('\x1b['),
    utf8Evidence: ['한', '글', '🐑'].every(value => text.includes(value)),
  };
}
async function startServer(tracker, binary, session) {
  const child = tracker.spawn(binary, ['--session', session, 'server'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = Buffer.alloc(0); child.stderr.on('data', chunk => { try { stderr = boundedAppend(stderr, chunk, 'server stderr'); } catch { child.kill('SIGTERM'); } });
  try {
    await waitUntil(async () => child.exitCode === null && (await run(tracker, binary, ['--session', session, 'status', 'server'], { allowFailure: true })).stdout.toString('utf8').includes('status: running'), SERVER_START_TIMEOUT_MS, 'Herdr server startup');
  } catch (error) {
    throw new Error(`${safeError(error)}; serverExit=${child.exitCode}; stderr=${stderr.toString('utf8').trim()}`);
  }
  return child;
}
async function stopServer(tracker, binary, session, child, allowAfterCancel = false) { await run(tracker, binary, ['--session', session, 'server', 'stop'], { allowFailure: true, allowAfterCancel }); if (child) await waitForExit(child, 5_000, 'server exit'); }
function controlArgs(session, paneId) { return ['--session', session, 'terminal', 'session', 'control', paneId, '--cols', '80', '--rows', '24']; }
async function acquireControl(tracker, binary, session, paneId, label) {
  const child = tracker.spawn(binary, controlArgs(session, paneId), { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = lineReader(child.stdout, label); let stderr = Buffer.alloc(0);
  child.stderr.on('data', chunk => { try { stderr = boundedAppend(stderr, chunk, `${label} stderr`); } catch { child.kill('SIGTERM'); } });
  await waitUntil(() => lines.values.some(value => value.type === 'terminal.frame') || lines.failure, 5_000, `${label} initial frame`);
  if (lines.failure) throw lines.failure;
  return { child, lines, stderr: () => stderr };
}
async function releaseControl(control, label) { control.child.stdin.write(`${JSON.stringify({ type: 'terminal.release' })}\n`); control.child.stdin.end(); return waitForExit(control.child, 5_000, label); }
async function controlEvidence(tracker, binary, session, paneId, marker) {
  const first = await acquireControl(tracker, binary, session, paneId, 'control');
  const second = tracker.spawn(binary, controlArgs(session, paneId), { stdio: ['pipe', 'pipe', 'pipe'] }); const secondLines = lineReader(second.stdout, 'second control');
  const secondCode = await waitForExit(second, 5_000, 'second controller rejection');
  first.child.stdin.write(`${JSON.stringify({ type: 'terminal.resize', cols: 100, rows: 30 })}\n`);
  await waitUntil(() => first.lines.values.some(frame => frame.type === 'terminal.frame' && frame.width === 100 && frame.height === 30), 5_000, 'controller resize frame');
  first.child.stdin.write(`${JSON.stringify({ type: 'terminal.scroll', direction: 'down', lines: 1, source: 'wheel', column: 0, row: 0, modifiers: 0 })}\n`);
  const encodedCommand = Buffer.from(`printf '${marker}\\n'`).toString('base64');
  first.child.stdin.write(`${JSON.stringify({ type: 'terminal.input', text: `printf '${encodedCommand}' | base64 -d | sh` })}\n`);
  first.child.stdin.write(`${JSON.stringify({ type: 'terminal.input', bytes: Buffer.from('\r').toString('base64') })}\n`);
  await waitUntil(async () => {
    const pane = await run(tracker, binary, ['--session', session, 'pane', 'read', paneId, '--source', 'visible', '--ansi']);
    return pane.stdout.toString('utf8').includes(marker);
  }, 5_000, 'exact input pane marker');
  const firstCode = await releaseControl(first, 'controller release');
  if (first.lines.failure || secondLines.failure) throw first.lines.failure ?? secondLines.failure;
  const reacquired = await acquireControl(tracker, binary, session, paneId, 'post-release control');
  const reacquireCode = await releaseControl(reacquired, 'post-release controller release');
  if (reacquired.lines.failure) throw reacquired.lines.failure;
  const pane = await run(tracker, binary, ['--session', session, 'pane', 'read', paneId, '--source', 'visible', '--ansi']);
  const frames = first.lines.values.filter(value => value.type === 'terminal.frame'); const frameFacts = validateFrames(frames);
  const reacquisitionFrames = validateFrames(reacquired.lines.values.filter(value => value.type === 'terminal.frame'));
  const paneText = pane.stdout.toString('utf8');
  const paneMarkerOccurrences = paneText.split(marker).length - 1;
  return { firstCode, secondCode, releaseObserved: firstCode === 0, secondControllerRejected: secondLines.values.some(value => value.type === 'terminal.closed' && String(value.reason).includes('already has an attached client')), noTakeoverReacquisition: reacquireCode === 0, takeoverUsed: false, ...frameFacts, exactInputOccurrences: paneMarkerOccurrences, reacquisitionFrames, resizeFrameObserved: frames.some(frame => frame.width === 100 && frame.height === 30), paneMarkerOccurrences, stderrEmpty: first.stderr().length === 0 };
}
async function abruptEofRecovery(tracker, binary, session, paneId) {
  const first = await acquireControl(tracker, binary, session, paneId, 'abrupt EOF control');
  first.child.stdin.end(); const eofCode = await waitForExit(first.child, 5_000, 'abrupt EOF controller exit');
  if (first.lines.failure) throw first.lines.failure;
  const eofFrames = validateFrames(first.lines.values.filter(value => value.type === 'terminal.frame'));
  const recovered = await acquireControl(tracker, binary, session, paneId, 'abrupt EOF recovery control');
  const recoveryCode = await releaseControl(recovered, 'abrupt EOF recovery release');
  if (recovered.lines.failure) throw recovered.lines.failure;
  const recoveryFrames = validateFrames(recovered.lines.values.filter(value => value.type === 'terminal.frame'));
  return { eofExitObserved: eofCode !== null, recoveredWithoutTakeover: recoveryCode === 0, eofFrames, recoveryFrames };
}
async function invalidControlEvidence(tracker, binary, session, paneId) {
  const control = await acquireControl(tracker, binary, session, paneId, 'invalid control');
  const initialFrame = control.lines.values.find(value => value.type === 'terminal.frame');
  control.child.stdin.write('{not-json}\n');
  control.child.stdin.write(`${JSON.stringify({ type: 'terminal.input', text: 'ignored', bytes: 'aWdub3JlZA==' })}\n`);
  control.child.stdin.write(`${JSON.stringify({ type: 'terminal.input', bytes: '***' })}\n`);
  control.child.stdin.write(`${JSON.stringify({ type: 'terminal.resize', cols: 0, rows: 24 })}\n`);
  await waitUntil(() => control.stderr().toString('utf8').split('\n').filter(Boolean).length >= 4, 5_000, 'invalid-control diagnostics');
  const releaseCode = await releaseControl(control, 'invalid control release');
  if (control.lines.failure) throw control.lines.failure;
  const recovered = await acquireControl(tracker, binary, session, paneId, 'invalid control recovery');
  const recoveryCode = await releaseControl(recovered, 'invalid control recovery release');
  if (recovered.lines.failure) throw recovered.lines.failure;
  const diagnostics = control.stderr().toString('utf8');
  return {
    malformedJsonRejected: diagnostics.toLowerCase().includes('invalid json command'),
    conflictingInputRejected: diagnostics.includes('text or bytes'),
    invalidBase64Rejected: diagnostics.includes('invalid terminal.input bytes'),
    zeroResizeRejected: diagnostics.includes('greater than zero') || diagnostics.includes('resize'),
    dimensionsUnchanged: control.lines.values.filter(value => value.type === 'terminal.frame').every(value => value.width === initialFrame.width && value.height === initialFrame.height),
    releaseExitZero: releaseCode === 0,
    recoveredWithoutTakeover: recoveryCode === 0,
  };
}

function frameGuardEvidence() {
  const valid = { type: 'terminal.frame', seq: 1, encoding: 'ansi', width: 80, height: 24, full: true, bytes: '' };
  const rejects = frames => {
    try { validateFrames(frames); return false; } catch { return true; }
  };
  return {
    missingSequenceRejected: rejects([{ ...valid, seq: undefined }]),
    sequenceGapRejected: rejects([valid, { ...valid, seq: 3 }]),
    invalidBase64Rejected: rejects([{ ...valid, bytes: '***' }]),
    encodedOversizeRejected: rejects([{ ...valid, bytes: 'A'.repeat(MAX_ENCODED_FRAME_BYTES + 1) }]),
    decodedOversizeRejected: rejects([{ ...valid, bytes: Buffer.alloc(MAX_DECODED_FRAME_BYTES + 1).toString('base64') }]),
  };
}
async function missingSelectorEvidence(tracker, binary, missingSession, paneId) {
  const snapshot = await run(tracker, binary, ['--session', missingSession, 'api', 'snapshot'], { allowFailure: true });
  const status = await run(tracker, binary, ['--session', missingSession, 'status', 'server'], { allowFailure: true });
  const control = await run(tracker, binary, ['--session', missingSession, 'terminal', 'session', 'control', paneId], { allowFailure: true, timeoutMs: 3_000 });
  const postStatus = await run(tracker, binary, ['--session', missingSession, 'status', 'server'], { allowFailure: true });
  const sessions = jsonOutput(await run(tracker, binary, ['session', 'list', '--json']));
  const entry = sessions.sessions.find(item => item.name === missingSession);
  const statusText = `${status.stdout.toString('utf8')}\n${status.stderr.toString('utf8')}`.toLowerCase();
  const postStatusText = `${postStatus.stdout.toString('utf8')}\n${postStatus.stderr.toString('utf8')}`.toLowerCase();
  const socketAbsentAfterControl = !entry?.socket_path || !(await exists(entry.socket_path));
  const noAutoStart = snapshot.code !== 0
    && statusText.includes('not running')
    && control.code !== 0
    && postStatusText.includes('not running')
    && entry?.running === false
    && socketAbsentAfterControl;
  return {
    missingSnapshotExitNonzero: snapshot.code !== 0,
    missingStatusReportsNotRunning: statusText.includes('not running'),
    missingControlExitNonzero: control.code !== 0,
    postControlStatusReportsNotRunning: postStatusText.includes('not running'),
    postControlSessionNotRunning: entry?.running === false,
    socketAbsentAfterControl,
    noAutoStart,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (platform() !== 'linux' || arch() !== 'x64' || process.getuid() === 0) throw new Error('Phase 0 requires non-root Linux x64');
  const sourceInput = await lstat(options.binary);
  if (sourceInput.isSymbolicLink()) throw new Error('source asset must not be a symbolic link');
  const source = await realpath(options.binary); const sourceStat = await stat(source);
  if (!sourceStat.isFile() || sourceStat.uid !== process.getuid() || (sourceStat.mode & 0o022) !== 0) throw new Error('source asset must be a user-owned regular file that is not group/world-writable');
  if (await exists(options.expectedAbsentPath)) throw new Error('prior user-local Herdr installation is still present');
  const sourceSha256 = sha256(await readFile(source));
  if (sourceSha256 !== options.expectedSha256.toLowerCase()) throw new Error('Herdr binary digest mismatch');
  const runRoot = await mkdtemp(join(tmpdir(), 'cmh0-')); await chmod(runRoot, 0o700); const runRootIdentity = await stat(runRoot);
  const installRoot = join(runRoot, 'install');
  const workspaceRoot = join(runRoot, 'workspace');
  const homeRoot = join(runRoot, 'home');
  const xdgConfigHome = join(runRoot, 'c');
  const xdgStateHome = join(runRoot, 's');
  const xdgCacheHome = join(runRoot, 'k');
  const xdgDataHome = join(runRoot, 'd');
  const configRoot = join(xdgConfigHome, 'herdr');
  const configPath = join(configRoot, 'config.toml');
  const copiedBinary = join(installRoot, 'herdr');
  const ownedRoots = [installRoot, workspaceRoot, homeRoot, xdgConfigHome, xdgStateHome, xdgCacheHome, xdgDataHome];
  const nonce = randomBytes(6).toString('hex'); const session = `chatmux-h0-${nonce}`; const missingSession = `chatmux-h0-missing-${nonce}`;
  const manifest = { runRoot, ownedPaths: [...ownedRoots, configRoot, configPath, copiedBinary] };
  for (const root of ownedRoots) await mkdir(root, { mode: 0o700 });
  await mkdir(configRoot, { mode: 0o700 });
  await cp(source, copiedBinary, { force: false }); await chmod(copiedBinary, 0o755);
  if (!(await regularOwnedExecutable(copiedBinary, process.getuid())) || sha256(await readFile(copiedBinary)) !== sourceSha256) throw new Error('verified executable copy is not user-owned mode-0755 and digest-identical');
  const isolatedEnv = { HOME: homeRoot, XDG_CONFIG_HOME: xdgConfigHome, XDG_STATE_HOME: xdgStateHome, XDG_CACHE_HOME: xdgCacheHome, XDG_DATA_HOME: xdgDataHome, HERDR_CONFIG_PATH: configPath };
  const cancellation = { signal: null, blockedProductSpawnAttempts: 0, cleanupSpawnsAfterSignal: 0, productSpawnsAfterSignal: 0 };
  const tracker = createTracker(runRoot, isolatedEnv, cancellation);
  const secretMarker = `PHASE0_SECRET_${randomBytes(16).toString('hex')}`; const pathMarker = `${runRoot}/${secretMarker}`;
  const sourceIdentity = { dev: sourceStat.dev, ino: sourceStat.ino, uid: sourceStat.uid, mode: sourceStat.mode & 0o777, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs, sha256: sourceSha256 };
  const restricted = {
    schemaVersion: 1,
    runId: nonce,
    generatedAt: new Date().toISOString(),
    source,
    expectedAbsentPath: options.expectedAbsentPath,
    runRoot,
    isolatedEnv,
    plannedPaths: manifest.ownedPaths,
    sessions: { disposable: session, missingProbe: missingSession },
    preflight: { runRootIdentity: { dev: runRootIdentity.dev, ino: runRootIdentity.ino, uid: runRootIdentity.uid }, sourceIdentity, priorUserLocalInstallAbsent: true, isolatedSessionList: null },
    runtime: { serverPid: null, sessionEntry: null, socketIdentity: null, paneIds: [] },
    cleanup: {},
  };
  let server = null; let signalReceived = null;
  const onSignal = signal => {
    signalReceived = signal;
    cancellation.signal = signal;
    tracker.closeAll().catch(() => {});
  };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  const report = { schemaVersion: 3, generatedAt: new Date().toISOString(), cohort: { status: 'live-run', semanticManifestVersion: 3, semanticFingerprint: null }, platform: { os: 'linux', arch: 'x64', nonRoot: true }, binary: { name: 'herdr', sha256: sourceSha256, ownerUidMatches: true, mode: '0755', copiedVerifiedExecutable: true, priorUserLocalInstallAbsent: true, sourceUnchangedAfterRun: false }, provenance: { officialVersion: '0.7.5', releaseTag: 'v0.7.5', releaseUrl: 'https://github.com/herdrdev/herdr/releases/tag/v0.7.5', assetUrl: 'https://github.com/herdrdev/herdr/releases/download/v0.7.5/herdr-linux-x86_64', redirectChainHosts: ['github.com', 'release-assets.githubusercontent.com'], finalHost: 'release-assets.githubusercontent.com', publishedDigestAlgorithm: 'sha256', publishedAt: '2026-07-21T18:11:20Z', evidenceCheckedAt: '2026-07-30', publisher: 'herdrdev/herdr', artifact: 'herdr-linux-x86_64' }, scope: { disposableNamedSession: true, isolatedRunRoot: true, isolatedConfigStateCacheDataHome: true, manifestScoped: true, productSourceMutated: false, shellUsed: false, ptyUsed: false, takeoverAllowed: false, defaultSessionUsed: false }, selectedTransport: 'none', semanticManifest: null, observed: {}, inferred: {}, unsupported: {}, failClosedLimitations: {}, cleanup: { sessionStopped: false, sessionDeleted: false, missingSessionDeleted: false, sessionAbsent: false, socketAbsent: false, childrenClosed: false, runRootRemoved: false, signalFinalizerInstalled: true, postSignalProductSpawns: 0, postStateClean: false }, sanitization: {}, go: false, failures: [] };
  try {
    restricted.preflight.isolatedSessionList = jsonOutput(await run(tracker, copiedBinary, ['session', 'list', '--json']));
    report.observed.version = (await run(tracker, copiedBinary, ['--version'])).stdout.toString('utf8').trim();
    if (report.observed.version !== 'herdr 0.7.5') throw new Error('installed binary version does not exactly match Herdr 0.7.5');
    const schemaResult = await run(tracker, copiedBinary, ['api', 'schema', '--json']); const schema = jsonOutput(schemaResult);
    const methods = schema.schemas.request.oneOf.map(item => item.properties?.method?.const).filter(Boolean).sort();
    report.semanticManifest = {
      version: 3,
      protocol: schema.protocol,
      schemaVersion: schema.schema_version,
      api: extractApiSemantics(schema),
      control: CONTROL_SEMANTICS,
    };
    assertSemanticReferenceClosure(report.semanticManifest);
    report.cohort.semanticFingerprint = semanticFingerprint(report.semanticManifest);
    report.observed.schema = { protocol: schema.protocol, schemaVersion: schema.schema_version, canonicalSha256: sha256(canonicalJson(schema)), byteLength: schemaResult.stdout.length, requiredMethodsPresent: REQUIRED_METHODS.every(method => methods.includes(method)), rawTerminalControlPublished: methods.some(method => method.startsWith('terminal.')), semanticReferenceClosure: true };
    if (schema.protocol !== EXPECTED_PROTOCOL || !report.observed.schema.requiredMethodsPresent || report.observed.schema.rawTerminalControlPublished) throw new Error('schema protocol or published terminal-control boundary mismatch');
    report.selectedTransport = 'herdr terminal session control';
    report.unsupported = { localAgentReplacement: 'not exposed by verified public CLI and therefore not authorized for writable control', liveHandoff: 'not safely triggerable by verified public CLI', slowConsumer: 'upstream backpressure cannot be deterministically injected; the product bridge must release on its own queue limit', sequenceGapInjection: 'not safely injectable upstream; the parser guard rejects any observed gap' };
    report.failClosedLimitations = Object.fromEntries(Object.keys(report.unsupported).map(key => [key, 'product integration must reject writable control when this condition cannot be observed and freshly revalidated']));
    server = await startServer(tracker, copiedBinary, session);
    restricted.runtime.serverPid = server.pid;
    const runningSessions = jsonOutput(await run(tracker, copiedBinary, ['session', 'list', '--json']));
    const runningEntry = runningSessions.sessions.find(item => item.name === session);
    if (!runningEntry?.running || !runningEntry.session_dir.startsWith(`${runRoot}/`) || !runningEntry.socket_path.startsWith(`${runRoot}/`)) throw new Error('Herdr session state escaped the isolated run root');
    const socketInfo = await stat(runningEntry.socket_path);
    if (!socketInfo.isSocket() || socketInfo.uid !== process.getuid()) throw new Error('isolated Herdr socket identity mismatch');
    restricted.runtime.sessionEntry = runningEntry;
    restricted.runtime.socketIdentity = { dev: socketInfo.dev, ino: socketInfo.ino, uid: socketInfo.uid, mode: socketInfo.mode };
    const initial = jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'api', 'snapshot'])).result.snapshot;
    report.observed.initialSnapshotEmpty = initial.panes.length === 0;
    const workspace = jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'workspace', 'create', '--cwd', workspaceRoot, '--label', 'chatmux-phase0', '--no-focus'])).result;
    const paneId = workspace.root_pane.pane_id;
    restricted.runtime.paneIds.push(paneId);
    report.observed.noAutoStart = await missingSelectorEvidence(tracker, copiedBinary, missingSession, paneId);
    const controlMarker = 'CHATMUX_HERDR_CONTROL_OK_한글🐑';
    await run(tracker, copiedBinary, ['--session', session, 'pane', 'run', paneId, `printf '\\033[31m${secretMarker} 한글🐑\\033[0m\\n'`]);
    await waitUntil(async () => {
      const pane = await run(tracker, copiedBinary, ['--session', session, 'pane', 'read', paneId, '--source', 'visible', '--ansi']);
      return pane.stdout.toString('utf8').includes(secretMarker);
    }, 5_000, 'seeded ANSI UTF-8 output');
    report.observed.control = await controlEvidence(tracker, copiedBinary, session, paneId, controlMarker);
    report.observed.abruptEofRecovery = await abruptEofRecovery(tracker, copiedBinary, session, paneId);
    report.observed.invalidControl = await invalidControlEvidence(tracker, copiedBinary, session, paneId);
    report.observed.frameGuards = frameGuardEvidence();
    const beforeMove = jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'pane', 'get', paneId])).result.pane;
    const move = jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'pane', 'move', paneId, '--new-workspace', '--label', 'phase0-moved', '--tab-label', 'moved', '--focus'])).result.move_result;
    const afterMove = jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'pane', 'get', move.previous_pane_id])).result.pane;
    report.observed.moveIdentity = { publicPaneChanged: beforeMove.pane_id !== afterMove.pane_id, oldPaneAliasResolvesCurrent: afterMove.pane_id === move.pane.pane_id, terminalStable: beforeMove.terminal_id === afterMove.terminal_id, hierarchyChanged: beforeMove.workspace_id !== afterMove.workspace_id };
    const firstSplit = jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'pane', 'split', move.pane.pane_id, '--direction', 'right', '--cwd', workspaceRoot, '--no-focus'])).result.pane;
    restricted.runtime.paneIds.push(firstSplit.pane_id);
    const firstSplitGet = jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'pane', 'get', firstSplit.pane_id])).result.pane;
    await run(tracker, copiedBinary, ['--session', session, 'pane', 'close', firstSplit.pane_id]);
    const closedSplit = await run(tracker, copiedBinary, ['--session', session, 'pane', 'get', firstSplit.pane_id], { allowFailure: true });
    const secondSplit = jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'pane', 'split', move.pane.pane_id, '--direction', 'down', '--cwd', workspaceRoot, '--no-focus'])).result.pane;
    restricted.runtime.paneIds.push(secondSplit.pane_id);
    report.observed.splitCloseRecreateIdentity = {
      firstSplitResolved: firstSplitGet.pane_id === firstSplit.pane_id,
      closedPaneInvalidated: closedSplit.code !== 0,
      recreatedPaneChanged: secondSplit.pane_id !== firstSplit.pane_id,
      recreatedTerminalChanged: secondSplit.terminal_id !== firstSplit.terminal_id,
      originalTerminalStable: (jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'pane', 'get', move.pane.pane_id])).result.pane).terminal_id === afterMove.terminal_id,
    };
    const beforeProcess = jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'pane', 'process-info', '--pane', move.pane.pane_id])).result.process_info;
    await run(tracker, copiedBinary, ['--session', session, 'pane', 'run', move.pane.pane_id, 'sleep 1']);
    const activeProcess = await waitUntil(async () => {
      const current = jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'pane', 'process-info', '--pane', move.pane.pane_id])).result.process_info;
      return current.foreground_process_group_id !== beforeProcess.foreground_process_group_id ? current : null;
    }, 1_000, 'foreground process change');
    const restoredProcess = await waitUntil(async () => {
      const current = jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'pane', 'process-info', '--pane', move.pane.pane_id])).result.process_info;
      return current.foreground_process_group_id === beforeProcess.foreground_process_group_id ? current : null;
    }, 2_000, 'foreground process restoration');
    report.observed.processIdentity = { shellPidStable: beforeProcess.shell_pid === restoredProcess.shell_pid, foregroundChanged: beforeProcess.foreground_process_group_id !== activeProcess.foreground_process_group_id, foregroundRestored: beforeProcess.foreground_process_group_id === restoredProcess.foreground_process_group_id, paneRevisionFieldPublished: [beforeProcess.revision, activeProcess.revision, restoredProcess.revision].every(value => Number.isInteger(value)), measuredPaneRevisions: [beforeProcess.revision ?? null, activeProcess.revision ?? null, restoredProcess.revision ?? null] };
    const beforeRestart = jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'pane', 'get', move.pane.pane_id])).result.pane;
    await stopServer(tracker, copiedBinary, session, server); server = null;
    server = await startServer(tracker, copiedBinary, session);
    const afterRestart = jsonOutput(await run(tracker, copiedBinary, ['--session', session, 'pane', 'get', beforeRestart.pane_id])).result.pane;
    const priorTerminalObserve = await run(tracker, copiedBinary, ['--session', session, 'terminal', 'session', 'observe', beforeRestart.terminal_id], { allowFailure: true, timeoutMs: 3_000 });
    report.observed.coldRestartIdentity = {
      workspaceRestored: afterRestart.workspace_id === beforeRestart.workspace_id,
      publicPaneRestored: afterRestart.pane_id === beforeRestart.pane_id,
      terminalChanged: afterRestart.terminal_id !== beforeRestart.terminal_id,
      priorTerminalInvalidated: priorTerminalObserve.code !== 0 || (priorTerminalObserve.stdout.includes(Buffer.from('"terminal.closed"')) && !priorTerminalObserve.stdout.includes(Buffer.from('"terminal.frame"'))),
    };
    await stopServer(tracker, copiedBinary, session, server); server = null;
    report.observed.serverStoppedForCleanup = true;
    const requirements = [signalReceived === null, report.observed.initialSnapshotEmpty, report.observed.noAutoStart.noAutoStart, Boolean(report.cohort.semanticFingerprint), report.observed.schema.semanticReferenceClosure, report.observed.control.releaseObserved, report.observed.control.secondControllerRejected, report.observed.control.noTakeoverReacquisition, report.observed.control.resizeFrameObserved, report.observed.control.sequence.firstIsOne, report.observed.control.sequence.contiguous, report.observed.control.sequence.lastAtLeastFirst, report.observed.control.exactInputOccurrences === 1, report.observed.control.ansiEvidence, report.observed.control.utf8Evidence, report.observed.control.stderrEmpty, report.observed.abruptEofRecovery.recoveredWithoutTakeover, Object.values(report.observed.invalidControl).every(Boolean), Object.values(report.observed.frameGuards).every(Boolean), Object.values(report.observed.moveIdentity).every(Boolean), Object.values(report.observed.splitCloseRecreateIdentity).every(Boolean), report.observed.processIdentity.foregroundChanged, report.observed.processIdentity.foregroundRestored, Object.values(report.observed.coldRestartIdentity).every(Boolean)];
    report.go = requirements.every(Boolean);
  } catch (error) { report.failures.push(safeError(error)); }
  finally {
    try { if (server) await stopServer(tracker, copiedBinary, session, server, true); report.cleanup.sessionStopped = true; } catch (error) { report.failures.push(`cleanup stop: ${safeError(error)}`); }
    try {
      const deleted = jsonOutput(await run(tracker, copiedBinary, ['session', 'delete', session, '--json'], { allowFailure: true, allowAfterCancel: true }));
      report.cleanup.sessionDeleted = deleted.deleted === true;
      const missingDeleted = jsonOutput(await run(tracker, copiedBinary, ['session', 'delete', missingSession, '--json'], { allowFailure: true, allowAfterCancel: true }));
      report.cleanup.missingSessionDeleted = missingDeleted.deleted === true;
      const sessions = jsonOutput(await run(tracker, copiedBinary, ['session', 'list', '--json'], { allowFailure: true, allowAfterCancel: true }));
      report.cleanup.sessionAbsent = !sessions.sessions?.some(item => item.name === session || item.name === missingSession);
      report.cleanup.socketAbsent = !restricted.runtime.sessionEntry?.socket_path || !(await exists(restricted.runtime.sessionEntry.socket_path));
      restricted.cleanup.postSessionList = sessions;
      restricted.cleanup.sessionDeleted = report.cleanup.sessionDeleted;
      restricted.cleanup.missingSessionDeleted = report.cleanup.missingSessionDeleted;
      restricted.cleanup.sessionAbsent = report.cleanup.sessionAbsent;
      restricted.cleanup.socketAbsent = report.cleanup.socketAbsent;
    } catch (error) { report.failures.push(`cleanup delete: ${safeError(error)}`); }
    await tracker.closeAll(); report.cleanup.childrenClosed = tracker.activeChildCount() === 0; restricted.cleanup.childrenClosed = report.cleanup.childrenClosed;
    try {
      const currentSource = await stat(source);
      report.binary.sourceUnchangedAfterRun = currentSource.dev === sourceIdentity.dev
        && currentSource.ino === sourceIdentity.ino
        && currentSource.size === sourceIdentity.size
        && currentSource.mtimeMs === sourceIdentity.mtimeMs
        && sha256(await readFile(source)) === sourceIdentity.sha256;
      const currentRoot = await stat(runRoot);
      const runRootUnchanged = currentRoot.dev === runRootIdentity.dev
        && currentRoot.ino === runRootIdentity.ino
        && currentRoot.uid === process.getuid();
      if (!runRootUnchanged) {
        report.failures.push('cleanup run root: refusing to remove changed or unowned run root');
      } else {
        await rm(runRoot, { recursive: true, force: false });
        report.cleanup.runRootRemoved = !(await exists(runRoot));
      }
      report.cleanup.postStateClean = report.cleanup.runRootRemoved && report.cleanup.childrenClosed && report.cleanup.sessionDeleted && report.cleanup.missingSessionDeleted && report.cleanup.sessionAbsent && report.cleanup.socketAbsent && report.binary.sourceUnchangedAfterRun;
      restricted.cleanup.runRootRemoved = report.cleanup.runRootRemoved;
      restricted.cleanup.sourceUnchanged = report.binary.sourceUnchangedAfterRun;
      restricted.cleanup.signalReceived = signalReceived;
      restricted.cleanup.blockedProductSpawnAttempts = cancellation.blockedProductSpawnAttempts;
      restricted.cleanup.cleanupSpawnsAfterSignal = cancellation.cleanupSpawnsAfterSignal;
      restricted.cleanup.productSpawnsAfterSignal = cancellation.productSpawnsAfterSignal;
      report.cleanup.postSignalProductSpawns = cancellation.productSpawnsAfterSignal;
    } catch (error) { report.failures.push(`cleanup run root: ${safeError(error)}`); }
    try { await writeFile(options.restrictedOutput, `${JSON.stringify(restricted, null, 2)}\n`, { mode: 0o600 }); } catch (error) { report.failures.push(`restricted evidence: ${safeError(error)}`); }
    const sensitive = [secretMarker, pathMarker, runRoot, workspaceRoot, installRoot, homeRoot, xdgConfigHome, xdgStateHome, xdgCacheHome, xdgDataHome, configRoot, configPath, source, options.expectedAbsentPath, copiedBinary, session, missingSession, homedir()];
    report.failures = redact(report.failures, sensitive);
    const serialized = JSON.stringify(report);
    report.sanitization = { secretMarkerExcluded: !serialized.includes(secretMarker), pathMarkerExcluded: !serialized.includes(pathMarker), homePathExcluded: !serialized.includes(homedir()) };
    report.go = report.go && report.cleanup.postStateClean && Object.values(report.sanitization).every(Boolean) && report.failures.length === 0;
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  if (!report.go) process.exitCode = 1;
  console.log(JSON.stringify({ go: report.go, selectedTransport: report.selectedTransport, failures: report.failures }));
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
