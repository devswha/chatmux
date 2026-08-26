import path from 'node:path';

import spawn from 'cross-spawn';

import type { LLMProvider } from '@/shared/types.js';

/** Wall-clock budget for one native skill catalog probe. */
export const NATIVE_SKILL_PROBE_TIMEOUT_MS = 4000;

/** Independent byte budget applied to the child stdout and stderr streams. */
export const NATIVE_SKILL_PROBE_OUTPUT_LIMIT_BYTES = 1024 * 1024;

/** Upper bound on normalized records returned to provider adapters. */
export const NATIVE_SKILL_PROBE_ENTRY_LIMIT = 500;

export type NativeSkillProbeStream = 'stdout' | 'stderr';

export type NativeSkillProbeFailureCategory =
  | 'missing-binary'
  | 'spawn-failed'
  | 'timeout'
  | 'nonzero-exit'
  | 'output-too-large'
  | 'invalid-json';

/**
 * Sanitized description of a failed probe.
 *
 * Every field is safe to log: `message` is a fixed sentence per category and no
 * field ever carries child stdout/stderr, argv values, or filesystem paths.
 */
export type NativeSkillProbeFailure = {
  category: NativeSkillProbeFailureCategory;
  message: string;
  exitCode: number | null;
  signal: string | null;
  stream: NativeSkillProbeStream | null;
};

/**
 * One normalized native skill record.
 *
 * Unknown native fields are dropped instead of forwarded so downstream adapters
 * cannot depend on undocumented CLI output. `sourcePath` stays `null` when the
 * native payload declares no truthful origin.
 */
export type NativeSkillProbeEntry = {
  name: string;
  description: string;
  sourcePath: string | null;
  scope: string | null;
  source: string | null;
  enabled: boolean;
  shadowedBy: string | null;
};

export type NativeSkillProbeSuccess = {
  ok: true;
  entries: NativeSkillProbeEntry[];
  truncated: boolean;
  skippedCount: number;
};

export type NativeSkillProbeFailureResult = {
  ok: false;
  failure: NativeSkillProbeFailure;
};

export type NativeSkillProbeResult = NativeSkillProbeSuccess | NativeSkillProbeFailureResult;

export type NativeSkillProbeOptions = {
  provider: LLMProvider;
  workspacePath: string;
  command: string;
  args: readonly string[];
};

const FAILURE_MESSAGES: Record<NativeSkillProbeFailureCategory, string> = {
  'missing-binary': 'The provider skill command is not installed.',
  'spawn-failed': 'The provider skill command could not be started.',
  timeout: 'The provider skill command exceeded its time budget.',
  'nonzero-exit': 'The provider skill command exited with a failure status.',
  'output-too-large': 'The provider skill command produced too much output.',
  'invalid-json': 'The provider skill command did not return the expected JSON catalog.',
};

const RECORD_LIST_KEYS = ['skills', 'entries', 'items', 'results', 'commands'] as const;

const failure = (
  category: NativeSkillProbeFailureCategory,
  details: Partial<Pick<NativeSkillProbeFailure, 'exitCode' | 'signal' | 'stream'>> = {},
): NativeSkillProbeFailureResult => ({
  ok: false,
  failure: {
    category,
    message: FAILURE_MESSAGES[category],
    exitCode: details.exitCode ?? null,
    signal: details.signal ?? null,
    stream: details.stream ?? null,
  },
});

const readTrimmedString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const readFirstTrimmedString = (
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null => {
  for (const key of keys) {
    const value = readTrimmedString(record[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
};

/**
 * Extracts the native record list from a parsed JSON payload.
 *
 * Native CLIs either return a bare array or wrap the array in one documented
 * envelope key, optionally below a `data` member.
 */
const extractRecordList = (payload: unknown): unknown[] | null => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  for (const key of RECORD_LIST_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  const data = record.data;
  if (Array.isArray(data)) {
    return data;
  }
  if (typeof data === 'object' && data !== null) {
    for (const key of RECORD_LIST_KEYS) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }

  return null;
};

const normalizeRecord = (value: unknown): NativeSkillProbeEntry | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const name = readTrimmedString(record.name);
  if (name === null) {
    return null;
  }

  return {
    name,
    description: readTrimmedString(record.description) ?? '',
    sourcePath: readFirstTrimmedString(record, ['path', 'sourcePath', 'file', 'filePath']),
    scope: readTrimmedString(record.scope),
    source: readTrimmedString(record.source),
    enabled: record.enabled !== false && record.disabled !== true,
    shadowedBy: readFirstTrimmedString(record, ['shadowedBy', 'shadowed_by']),
  };
};

/**
 * Orders records by case-insensitive name and keeps native precedence for ties
 * so adapters can still resolve shadowing from the returned order.
 */
const orderEntries = (entries: NativeSkillProbeEntry[]): NativeSkillProbeEntry[] => (
  entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftKey = left.entry.name.toLowerCase();
      const rightKey = right.entry.name.toLowerCase();
      if (leftKey !== rightKey) {
        return leftKey < rightKey ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(({ entry }) => entry)
);

const parseCatalog = (stdout: string): NativeSkillProbeResult => {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return failure('invalid-json');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return failure('invalid-json');
  }

  const records = extractRecordList(payload);
  if (records === null) {
    return failure('invalid-json');
  }

  const normalized: NativeSkillProbeEntry[] = [];
  let skippedCount = 0;
  for (const record of records) {
    const entry = normalizeRecord(record);
    if (entry === null) {
      skippedCount += 1;
      continue;
    }
    normalized.push(entry);
  }

  const ordered = orderEntries(normalized);
  return {
    ok: true,
    entries: ordered.slice(0, NATIVE_SKILL_PROBE_ENTRY_LIMIT),
    truncated: ordered.length > NATIVE_SKILL_PROBE_ENTRY_LIMIT,
    skippedCount,
  };
};

/**
 * Runs the native command once and resolves a bounded, sanitized outcome.
 */
const runProbe = (options: NativeSkillProbeOptions): Promise<NativeSkillProbeResult> => (
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.workspacePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve(failure('spawn-failed'));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalFailure: NativeSkillProbeFailureResult | null = null;
    let settled = false;

    const finish = (result: NativeSkillProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    const abort = (result: NativeSkillProbeFailureResult): void => {
      if (terminalFailure === null) {
        terminalFailure = result;
      }
      child.kill('SIGKILL');
    };

    const timeoutHandle = setTimeout(() => {
      abort(failure('timeout'));
    }, NATIVE_SKILL_PROBE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > NATIVE_SKILL_PROBE_OUTPUT_LIMIT_BYTES) {
        stdoutChunks.length = 0;
        abort(failure('output-too-large', { stream: 'stdout' }));
        return;
      }
      stdoutChunks.push(chunk);
    });

    // stderr is counted but never retained: diagnostics must not carry raw output.
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > NATIVE_SKILL_PROBE_OUTPUT_LIMIT_BYTES) {
        abort(failure('output-too-large', { stream: 'stderr' }));
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(failure(error.code === 'ENOENT' ? 'missing-binary' : 'spawn-failed'));
    });

    child.on('close', (code, signal) => {
      if (terminalFailure !== null) {
        finish(terminalFailure);
        return;
      }
      if (code !== 0) {
        finish(failure('nonzero-exit', { exitCode: code, signal: signal ?? null }));
        return;
      }
      finish(parseCatalog(Buffer.concat(stdoutChunks).toString('utf8')));
    });
  })
);

const inFlightProbes = new Map<string, Promise<NativeSkillProbeResult>>();

const singleFlightKey = (options: NativeSkillProbeOptions): string => [
  options.provider,
  path.resolve(options.workspacePath),
  options.command,
  ...options.args,
].join('\u0000');

/**
 * Probes a provider CLI for its native machine-readable skill catalog.
 *
 * The child runs through argv without a shell, is killed after the documented
 * timeout, and has independent stdout/stderr byte budgets. Identical in-flight
 * provider/workspace/argv requests share one child process; results are never
 * cached beyond the in-flight window.
 */
export const probeNativeSkillCatalog = (
  options: NativeSkillProbeOptions,
): Promise<NativeSkillProbeResult> => {
  const key = singleFlightKey(options);
  const pending = inFlightProbes.get(key);
  if (pending) {
    return pending;
  }

  const probe = runProbe(options).finally(() => {
    inFlightProbes.delete(key);
  });
  inFlightProbes.set(key, probe);
  return probe;
};
