import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

import Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { getOpenCodeDatabasePath } from '@/shared/utils.js';

import {
  resolveCodexRolloutPath,
  type ExternalCliSession,
  type ExternalLocalCliKind,
} from './external-cli-sessions.service.js';
import { recordHostCommand } from './host-command-metrics.service.js';
import { transcriptChangeVersion } from './transcript-change.service.js';

export type ExternalSessionActivity = 'running' | 'waiting_user' | 'asking_user' | 'unknown';
export type ExternalSessionTerminalOutcome = 'reply_ready' | 'failed' | 'none' | 'unknown';
export type ExternalSessionDisplayActivity = ExternalSessionActivity | 'error';

export type ExternalSessionActivityEvidence = {
  activity: ExternalSessionActivity;
  terminalOutcome: ExternalSessionTerminalOutcome;
  /**
   * Opaque, provider-scoped hashes for monitor cursors and diagnostics. They
   * never contain transcript content, database paths, or provider session IDs.
   */
  evidenceCursor: string;
  evidenceDigest: string;
};

export type ExternalSessionActivityEvidenceReadResult =
  | { status: 'resolved'; evidence: ExternalSessionActivityEvidence }
  | {
    status: 'unavailable';
    activity: 'unknown';
    reasonCode: ExternalSessionActivityUnavailableReasonCode;
  };

export type ExternalSessionParsedActivityEvidence = Pick<
  ExternalSessionActivityEvidence,
  'activity' | 'terminalOutcome'
>;
export type ExternalSessionActivityUnavailableReasonCode =
  | 'unsupported_session_kind'
  | 'provider_session_id_unavailable'
  | 'app_session_lookup_unavailable'
  | 'app_session_unavailable'
  | 'codex_rollout_unavailable'
  | 'codex_synchronization_unavailable'
  | 'transcript_path_unavailable'
  | 'transcript_read_unavailable'
  | 'opencode_database_unavailable';

export type ExternalSessionActivityReadResult =
  | { status: 'resolved'; activity: ExternalSessionActivity }
  | {
    status: 'unavailable';
    activity: 'unknown';
    reasonCode: ExternalSessionActivityUnavailableReasonCode;
  };

export type ExternalTranscriptEndedReadResult =
  | { status: 'resolved'; transcriptEnded: boolean }
  | {
    status: 'unavailable';
    transcriptEnded: false;
    reasonCode: Extract<
      ExternalSessionActivityUnavailableReasonCode,
      'transcript_path_unavailable' | 'transcript_read_unavailable'
    >;
  };

export type ExternalSessionAppSession = {
  session_id: string;
  project_path: string | null;
  custom_name: string | null;
};

export type ExternalSessionActivityAppSession = ExternalSessionAppSession & {
  jsonl_path: string | null;
};

export type ExternalSessionActivityResolutionResult =
  | {
    status: 'resolved';
    activity: ExternalSessionActivity;
    terminalOutcome?: ExternalSessionTerminalOutcome;
    /** Opaque evidence values; never transcript content, paths, or native IDs. */
    evidenceCursor?: string;
    evidenceDigest?: string;
    appSession: ExternalSessionAppSession | null;
    transcriptEnded: boolean;
  }
  | {
    status: 'unavailable';
    activity: 'unknown';
    reasonCode: ExternalSessionActivityUnavailableReasonCode;
    appSession: ExternalSessionAppSession | null;
    transcriptEnded: false;
  };

export function toExternalSessionDisplayActivity(
  resolution: ExternalSessionActivityResolutionResult,
): ExternalSessionDisplayActivity {
  return resolution.status === 'resolved' && resolution.terminalOutcome === 'failed'
    ? 'error'
    : resolution.activity;
}

export type ExternalSessionActivityResolverDependencies = {
  getAppSession?: (
    provider: ExternalLocalCliKind,
    providerSessionId: string,
  ) => ExternalSessionActivityAppSession | null;
  resolveCodexRolloutPath?: (providerSessionId: string) => Promise<string | null>;
  synchronizeCodexRollout?: (rolloutPath: string) => Promise<unknown>;
  readActivityEvidence?: (input: {
    kind: ExternalLocalCliKind;
    providerSessionId: string | null | undefined;
    jsonlPath: string | null | undefined;
  }) => Promise<ExternalSessionActivityEvidenceReadResult>;
  readTranscriptEnded?: (input: {
    kind: ExternalLocalCliKind;
    jsonlPath: string | null | undefined;
  }) => Promise<ExternalTranscriptEndedReadResult>;
};

type JsonRecord = Record<string, unknown>;
type FileTail = {
  size: number;
  mtimeMs: number;
  digest: string;
  text: string;
};

const FILE_TAIL_BYTES = 128 * 1024;
const fileActivityCache = new Map<string, {
  size: number;
  mtimeMs: number;
  digest: string;
  activity: ExternalSessionActivity;
}>();

const asRecord = (value: unknown): JsonRecord | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
);

const readString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const parseRecord = (value: unknown): JsonRecord | null => {
  if (typeof value !== 'string') {
    return asRecord(value);
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
};

const parseJsonLines = (tailText: string): JsonRecord[] => {
  const records: JsonRecord[] = [];
  for (const line of tailText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = parseRecord(line);
    if (record) records.push(record);
  }
  return records;
};

const normalizeToolName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const isAskingToolName = (value: string): boolean => {
  const normalized = normalizeToolName(value);
  return normalized === 'ask'
    || normalized === 'askuserquestion'
    || normalized === 'requestuserinput'
    || normalized === 'question'
    || normalized === 'permissionrequest';
};

const collectToolNames = (value: unknown, names: string[], depth = 0): void => {
  if (depth > 6 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectToolNames(item, names, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const key of ['name', 'tool', 'toolName']) {
    const name = readString(record[key]);
    if (name) names.push(name);
  }
  for (const nested of Object.values(record)) collectToolNames(nested, names, depth + 1);
};

const containsAskingTool = (value: unknown): boolean => {
  const names: string[] = [];
  collectToolNames(value, names);
  return names.some(isAskingToolName);
};

const containsToolCall = (value: unknown, depth = 0): boolean => {
  if (depth > 6 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => containsToolCall(item, depth + 1));
  const record = asRecord(value);
  if (!record) return false;
  const type = readString(record.type)?.toLowerCase().replace(/_/g, '-');
  if (type === 'tool-use' || type === 'tool-call' || type === 'function-call' || type === 'custom-tool-call') {
    return true;
  }
  return Object.values(record).some((nested) => containsToolCall(nested, depth + 1));
};

const evidence = (
  activity: ExternalSessionActivity,
  terminalOutcome: ExternalSessionTerminalOutcome,
): ExternalSessionParsedActivityEvidence => ({ activity, terminalOutcome });

const parseOmpEvidence = (records: JsonRecord[]): ExternalSessionParsedActivityEvidence => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const type = readString(record.type)?.toLowerCase();
    const message = asRecord(record.message);
    if (type === 'error' || isErrorRecord(record) || isErrorRecord(message ?? {})) {
      return evidence('waiting_user', 'failed');
    }
    if (type !== 'message') continue;
    const role = readString(message?.role);
    if (role === 'assistant') {
      const stopReason = readString(message?.stopReason)?.toLowerCase();
      if (stopReason === 'error') return evidence('waiting_user', 'failed');
      if (containsAskingTool(message?.content)) return evidence('asking_user', 'none');
      if (!stopReason || stopReason === 'tooluse' || stopReason === 'tool-use') return evidence('running', 'none');
      if (stopReason === 'stop') return evidence('waiting_user', 'reply_ready');
      return evidence('unknown', 'unknown');
    }
    if (role === 'user' || role === 'toolResult') return evidence('running', 'none');
  }
  return evidence('unknown', 'unknown');
};

const isErrorRecord = (record: JsonRecord): boolean => (
  record.is_error === true
  || record.isError === true
  || readString(record.subtype)?.toLowerCase().includes('error') === true
  || readString(record.resultSubtype)?.toLowerCase().includes('error') === true
  || (record.error !== null && record.error !== undefined)
);

const parseClaudeEvidence = (records: JsonRecord[]): ExternalSessionParsedActivityEvidence => {
  let turnEnded = false;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const type = readString(record.type)?.toLowerCase();
    const message = asRecord(record.message);
    if (type === 'error' || isErrorRecord(record) || isErrorRecord(message ?? {})) {
      return evidence('waiting_user', 'failed');
    }
    if (type === 'result') {
      const subtype = readString(record.subtype)?.toLowerCase();
      if (subtype === 'success') return evidence('waiting_user', 'reply_ready');
      if (subtype === 'error' || subtype === 'cancelled' || subtype === 'canceled' || subtype === 'interrupted') {
        return evidence('waiting_user', 'failed');
      }
      return evidence('unknown', 'unknown');
    }
    if (
      type === 'system'
      && readString(record.subtype)?.toLowerCase() === 'turn_duration'
    ) {
      turnEnded = true;
      continue;
    }
    if (type !== 'assistant' && type !== 'user') continue;
    const role = readString(message?.role) ?? type;
    if (role === 'user') {
      return turnEnded
        ? evidence('waiting_user', 'none')
        : evidence('running', 'none');
    }
    if (role !== 'assistant') continue;
    if (containsAskingTool(message?.content)) return evidence('asking_user', 'none');
    const stopReason = readString(message?.stop_reason) ?? readString(message?.stopReason);
    if (!stopReason || stopReason === 'tool_use') return evidence('running', 'none');
    if (stopReason === 'end_turn') return evidence('waiting_user', 'reply_ready');
    return evidence('unknown', 'unknown');
  }
  return evidence('unknown', 'unknown');
};

const parseCodexEvidence = (records: JsonRecord[]): ExternalSessionParsedActivityEvidence => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const type = readString(record.type)?.toLowerCase();
    const payload = asRecord(record.payload);
    const payloadType = readString(payload?.type)?.toLowerCase();

    if (type === 'turn_aborted') return evidence('waiting_user', 'none');
    if (type === 'turn_failed' || type === 'error' || isErrorRecord(record) || isErrorRecord(payload ?? {})) {
      return evidence('waiting_user', 'failed');
    }
    if (type === 'turn_complete') return evidence('waiting_user', 'reply_ready');
    if (type === 'event_msg') {
      if (payloadType === 'turn_aborted') return evidence('waiting_user', 'none');
      if (payloadType === 'turn_failed' || payloadType === 'error') return evidence('waiting_user', 'failed');
      if (payloadType === 'task_complete' || payloadType === 'turn_complete') return evidence('waiting_user', 'reply_ready');
      if (containsAskingTool(payload)) return evidence('asking_user', 'none');
      if (payloadType === 'task_started' || payloadType === 'user_message' || payloadType === 'turn_started') {
        return evidence('running', 'none');
      }
      continue;
    }
    if (type === 'response_item') {
      if (payloadType === 'error' || payloadType === 'turn_failed' || (payload?.error !== null && payload?.error !== undefined)) {
        return evidence('waiting_user', 'failed');
      }
      if (containsAskingTool(payload)) return evidence('asking_user', 'none');
      const role = readString(payload?.role);
      if (role === 'user' || containsToolCall(payload) || payloadType === 'function_call_output' || role === 'assistant') {
        return evidence('running', 'none');
      }
      continue;
    }
    if (type === 'turn_context') return evidence('running', 'none');
  }
  return evidence('unknown', 'unknown');
};

const parseCursorEvidence = (records: JsonRecord[]): ExternalSessionParsedActivityEvidence => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const message = asRecord(record.message);
    const role = readString(record.role) ?? readString(message?.role);
    const content = record.content ?? message?.content;
    if (role === 'user' || role === 'tool') return evidence('running', 'none');
    if (role !== 'assistant') continue;
    if (containsAskingTool(content)) return evidence('asking_user', 'none');
    return evidence(containsToolCall(content) ? 'running' : 'waiting_user', 'unknown');
  }
  return evidence('unknown', 'unknown');
};

export function parseExternalJsonlActivityEvidence(
  kind: Exclude<ExternalLocalCliKind, 'opencode'>,
  tailText: string,
): ExternalSessionParsedActivityEvidence {
  const records = parseJsonLines(tailText);
  if (kind === 'omp') return parseOmpEvidence(records);
  if (kind === 'claude') return parseClaudeEvidence(records);
  if (kind === 'codex') return parseCodexEvidence(records);
  return parseCursorEvidence(records);
}

export function parseExternalJsonlActivity(
  kind: Exclude<ExternalLocalCliKind, 'opencode'>,
  tailText: string,
): ExternalSessionActivity {
  return parseExternalJsonlActivityEvidence(kind, tailText).activity;
}

const isPendingQuestionPart = (value: unknown): boolean => {
  const record = parseRecord(value);
  if (!record || !containsAskingTool(record)) return false;
  const state = asRecord(record.state);
  const status = readString(state?.status)?.toLowerCase();
  return status === 'pending' || status === 'running';
};
const normalizeOpenCodeFinish = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 ? value.toLowerCase() : null
);

export function parseOpenCodeActivityEvidence(
  messageData: unknown,
  partData: readonly unknown[] = [],
): ExternalSessionParsedActivityEvidence {
  const message = parseRecord(messageData);
  if (!message) return evidence('unknown', 'unknown');
  const role = readString(message.role);
  if (role === 'user') return evidence('running', 'none');
  if (role !== 'assistant') return evidence('unknown', 'unknown');
  if (message.error !== null && message.error !== undefined) return evidence('waiting_user', 'failed');
  if (partData.some(isPendingQuestionPart)) return evidence('asking_user', 'none');
  const time = asRecord(message.time);
  const completed = time?.completed;
  if (completed === null || completed === undefined) return evidence('running', 'none');
  const finish = normalizeOpenCodeFinish(message.finish);
  if (finish === 'tool-calls') return evidence('running', 'none');
  if (finish === 'stop') return evidence('waiting_user', 'reply_ready');
  return evidence('unknown', 'unknown');
}

export function parseOpenCodeActivity(
  messageData: unknown,
  partData: readonly unknown[] = [],
): ExternalSessionActivity {
  return parseOpenCodeActivityEvidence(messageData, partData).activity;
}

async function readFileTail(filePath: string): Promise<FileTail> {
  recordHostCommand('read', ['transcript']);
  const fileStat = await stat(filePath);
  const size = fileStat.size;
  const start = Math.max(0, size - FILE_TAIL_BYTES);
  const length = size - start;
  if (length === 0) {
    return {
      size,
      mtimeMs: fileStat.mtimeMs,
      digest: createHash('sha256').digest('hex'),
      text: '',
    };
  }

  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const tail = buffer.subarray(0, bytesRead);
    const rawText = tail.toString('utf8');
    const lastNewline = rawText.lastIndexOf('\n');
    return {
      size,
      mtimeMs: fileStat.mtimeMs,
      digest: createHash('sha256').update(tail).digest('hex'),
      text: lastNewline >= 0 ? rawText.slice(0, lastNewline + 1) : '',
    };
  } finally {
    await handle.close();
  }
}

const sameTailIdentity = (
  cached: Pick<FileTail, 'size' | 'mtimeMs' | 'digest'>,
  tail: Pick<FileTail, 'size' | 'mtimeMs' | 'digest'>,
): boolean => (
  cached.size === tail.size
  && cached.mtimeMs === tail.mtimeMs
  && cached.digest === tail.digest
);

const transcriptEndedCache = new Map<string, {
  size: number;
  mtimeMs: number;
  digest: string;
  ended: boolean;
}>();

/**
 * Detects a transcript whose final record marks the session stream as closed
 * while the CLI process may still be alive in tmux (recorder died mid-run).
 * Currently only omp writes an explicit `session_exit` custom record.
 */
export function parseOmpTranscriptEnded(records: JsonRecord[]): boolean {
  const last = records[records.length - 1];
  if (!last || last.type !== 'custom') return false;
  return readString(last.customType) === 'session_exit';
}

export async function readExternalTranscriptEndedDetailed(input: {
  kind: ExternalLocalCliKind;
  jsonlPath: string | null | undefined;
}): Promise<ExternalTranscriptEndedReadResult> {
  if (input.kind !== 'omp') return { status: 'resolved', transcriptEnded: false };
  if (!input.jsonlPath) {
    return {
      status: 'unavailable',
      transcriptEnded: false,
      reasonCode: 'transcript_path_unavailable',
    };
  }

  try {
    const tail = await readFileTail(input.jsonlPath);
    const cached = transcriptEndedCache.get(input.jsonlPath);
    if (cached && sameTailIdentity(cached, tail)) {
      return { status: 'resolved', transcriptEnded: cached.ended };
    }

    const transcriptEnded = parseOmpTranscriptEnded(parseJsonLines(tail.text));
    transcriptEndedCache.set(input.jsonlPath, {
      size: tail.size,
      mtimeMs: tail.mtimeMs,
      digest: tail.digest,
      ended: transcriptEnded,
    });
    return { status: 'resolved', transcriptEnded };
  } catch {
    return {
      status: 'unavailable',
      transcriptEnded: false,
      reasonCode: 'transcript_read_unavailable',
    };
  }
}

export async function readExternalTranscriptEnded(input: {
  kind: ExternalLocalCliKind;
  jsonlPath: string | null | undefined;
}): Promise<boolean> {
  return (await readExternalTranscriptEndedDetailed(input)).transcriptEnded;
}

async function readJsonlActivity(
  kind: Exclude<ExternalLocalCliKind, 'opencode'>,
  filePath: string,
): Promise<ExternalSessionActivityReadResult> {
  try {
    const tail = await readFileTail(filePath);
    const cached = fileActivityCache.get(filePath);
    if (cached && sameTailIdentity(cached, tail)) {
      return { status: 'resolved', activity: cached.activity };
    }

    const activity = parseExternalJsonlActivity(kind, tail.text);
    fileActivityCache.set(filePath, {
      size: tail.size,
      mtimeMs: tail.mtimeMs,
      digest: tail.digest,
      activity,
    });
    return { status: 'resolved', activity };
  } catch {
    return {
      status: 'unavailable',
      activity: 'unknown',
      reasonCode: 'transcript_read_unavailable',
    };
  }
}

function readOpenCodeActivity(providerSessionId: string): ExternalSessionActivityReadResult {
  let db: Database.Database | null = null;
  let result: ExternalSessionActivityReadResult;
  try {
    db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
    const message = db.prepare(`
      SELECT id, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created DESC, time_updated DESC, id DESC
      LIMIT 1
    `).get(providerSessionId) as { id?: string; data?: string } | undefined;
    if (!message?.id || !message.data) {
      result = { status: 'resolved', activity: 'unknown' };
    } else {
      const parts = db.prepare(`
        SELECT data
        FROM part
        WHERE message_id = ?
        ORDER BY time_updated DESC, time_created DESC, id DESC
        LIMIT 32
      `).all(message.id) as Array<{ data?: string }>;
      result = {
        status: 'resolved',
        activity: parseOpenCodeActivity(message.data, parts.map((part) => part.data)),
      };
    }
  } catch {
    result = {
      status: 'unavailable',
      activity: 'unknown',
      reasonCode: 'opencode_database_unavailable',
    };
  }

  try {
    db?.close();
  } catch {
    return {
      status: 'unavailable',
      activity: 'unknown',
      reasonCode: 'opencode_database_unavailable',
    };
  }
  return result;
}
const opaqueEvidence = (
  kind: ExternalLocalCliKind,
  providerSessionId: string,
  sourceDigest: string,
  parsed: ExternalSessionParsedActivityEvidence,
): ExternalSessionActivityEvidence => {
  const evidenceDigest = createHash('sha256')
    .update('external-session-activity:evidence-digest:v1\0')
    .update(kind)
    .update('\0')
    .update(sourceDigest)
    .digest('hex');
  const evidenceCursor = createHash('sha256')
    .update('external-session-activity:evidence-cursor:v1\0')
    .update(kind)
    .update('\0')
    .update(providerSessionId)
    .update('\0')
    .update(evidenceDigest)
    .digest('hex');
  return { ...parsed, evidenceCursor, evidenceDigest };
};

const fileTailEvidenceDigest = (tail: Pick<FileTail, 'size' | 'digest'>): string => (
  createHash('sha256')
    .update('external-session-activity:file-tail:v1\0')
    .update(String(tail.size))
    .update('\0')
    .update(tail.digest)
    .digest('hex')
);

async function readJsonlActivityEvidence(
  kind: Exclude<ExternalLocalCliKind, 'opencode'>,
  providerSessionId: string,
  filePath: string,
): Promise<ExternalSessionActivityEvidenceReadResult> {
  try {
    const tail = await readFileTail(filePath);
    return {
      status: 'resolved',
      evidence: opaqueEvidence(
        kind,
        providerSessionId,
        fileTailEvidenceDigest(tail),
        parseExternalJsonlActivityEvidence(kind, tail.text),
      ),
    };
  } catch {
    return {
      status: 'unavailable',
      activity: 'unknown',
      reasonCode: 'transcript_read_unavailable',
    };
  }
}
async function readOmpActivityAndTranscriptEvidence(
  providerSessionId: string,
  filePath: string,
): Promise<{
  activityResult: ExternalSessionActivityEvidenceReadResult;
  transcriptEndedResult: ExternalTranscriptEndedReadResult;
}> {
  try {
    const tail = await readFileTail(filePath);
    const records = parseJsonLines(tail.text);
    return {
      activityResult: {
        status: 'resolved',
        evidence: opaqueEvidence(
          'omp',
          providerSessionId,
          fileTailEvidenceDigest(tail),
          parseOmpEvidence(records),
        ),
      },
      transcriptEndedResult: {
        status: 'resolved',
        transcriptEnded: parseOmpTranscriptEnded(records),
      },
    };
  } catch {
    return {
      activityResult: {
        status: 'unavailable',
        activity: 'unknown',
        reasonCode: 'transcript_read_unavailable',
      },
      transcriptEndedResult: {
        status: 'unavailable',
        transcriptEnded: false,
        reasonCode: 'transcript_read_unavailable',
      },
    };
  }
}

function readOpenCodeActivityEvidence(
  providerSessionId: string,
): ExternalSessionActivityEvidenceReadResult {
  let db: Database.Database | null = null;
  let result: ExternalSessionActivityEvidenceReadResult;
  try {
    db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
    const message = db.prepare(`
      SELECT id, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created DESC, time_updated DESC, id DESC
      LIMIT 1
    `).get(providerSessionId) as { id?: string; data?: string } | undefined;
    if (!message?.id || !message.data) {
      result = {
        status: 'resolved',
        evidence: opaqueEvidence(
          'opencode',
          providerSessionId,
          createHash('sha256').update('empty').digest('hex'),
          evidence('unknown', 'unknown'),
        ),
      };
    } else {
      const parts = db.prepare(`
        SELECT data
        FROM part
        WHERE message_id = ?
        ORDER BY time_updated DESC, time_created DESC, id DESC
        LIMIT 32
      `).all(message.id) as Array<{ data?: string }>;
      const sourceDigest = createHash('sha256')
        .update('opencode-message-and-parts:v1\0')
        .update(message.id)
        .update('\0')
        .update(message.data)
        .update('\0')
        .update(JSON.stringify(parts.map((part) => part.data ?? null)))
        .digest('hex');
      result = {
        status: 'resolved',
        evidence: opaqueEvidence(
          'opencode',
          providerSessionId,
          sourceDigest,
          parseOpenCodeActivityEvidence(message.data, parts.map((part) => part.data)),
        ),
      };
    }
  } catch {
    result = {
      status: 'unavailable',
      activity: 'unknown',
      reasonCode: 'opencode_database_unavailable',
    };
  }

  try {
    db?.close();
  } catch {
    return {
      status: 'unavailable',
      activity: 'unknown',
      reasonCode: 'opencode_database_unavailable',
    };
  }
  return result;
}

export async function readExternalSessionActivityEvidenceDetailed(input: {
  kind: ExternalLocalCliKind;
  providerSessionId: string | null | undefined;
  jsonlPath: string | null | undefined;
}): Promise<ExternalSessionActivityEvidenceReadResult> {
  if (!input.providerSessionId) {
    return {
      status: 'unavailable',
      activity: 'unknown',
      reasonCode: 'provider_session_id_unavailable',
    };
  }
  if (input.kind === 'opencode') return readOpenCodeActivityEvidence(input.providerSessionId);
  if (!input.jsonlPath) {
    return {
      status: 'unavailable',
      activity: 'unknown',
      reasonCode: 'transcript_path_unavailable',
    };
  }
  return readJsonlActivityEvidence(input.kind, input.providerSessionId, input.jsonlPath);
}

export async function readExternalSessionActivityDetailed(input: {
  kind: ExternalLocalCliKind;
  providerSessionId: string | null | undefined;
  jsonlPath: string | null | undefined;
}): Promise<ExternalSessionActivityReadResult> {
  if (!input.providerSessionId) {
    return {
      status: 'unavailable',
      activity: 'unknown',
      reasonCode: 'provider_session_id_unavailable',
    };
  }
  if (input.kind === 'opencode') return readOpenCodeActivity(input.providerSessionId);
  if (!input.jsonlPath) {
    return {
      status: 'unavailable',
      activity: 'unknown',
      reasonCode: 'transcript_path_unavailable',
    };
  }
  return readJsonlActivity(input.kind, input.jsonlPath);
}

export async function readExternalSessionActivity(input: {
  kind: ExternalLocalCliKind;
  providerSessionId: string | null | undefined;
  jsonlPath: string | null | undefined;
}): Promise<ExternalSessionActivity> {
  return (await readExternalSessionActivityDetailed(input)).activity;
}

const unavailableResolution = (
  reasonCode: ExternalSessionActivityUnavailableReasonCode,
  appSession: ExternalSessionAppSession | null,
): ExternalSessionActivityResolutionResult => ({
  status: 'unavailable',
  activity: 'unknown',
  reasonCode,
  appSession,
  transcriptEnded: false,
});
const appSessionMetadata = (
  appSession: ExternalSessionActivityAppSession | null,
): ExternalSessionAppSession | null => (
  appSession
    ? {
      session_id: appSession.session_id,
      project_path: appSession.project_path,
      custom_name: appSession.custom_name,
    }
    : null
);

/**
 * Resolves app-owned transcript metadata and external CLI activity once so the
 * route and completion monitor make the same availability decision.
 */
async function resolveExternalSessionActivityUncached(
  session: Pick<ExternalCliSession, 'kind' | 'providerSessionId'>,
  dependencies: ExternalSessionActivityResolverDependencies = {},
): Promise<ExternalSessionActivityResolutionResult> {
  if (session.kind === 'ssh' || session.kind === 'shell') {
    return unavailableResolution('unsupported_session_kind', null);
  }
  if (!session.providerSessionId) {
    return unavailableResolution('provider_session_id_unavailable', null);
  }
  const kind: ExternalLocalCliKind = session.kind;
  const providerSessionId = session.providerSessionId;
  const getAppSession: NonNullable<ExternalSessionActivityResolverDependencies['getAppSession']> = dependencies.getAppSession
    ?? ((provider: ExternalLocalCliKind, nativeSessionId: string) => getConnection().prepare(`
      SELECT session.session_id AS session_id,
             session.project_path AS project_path,
             session.custom_name AS custom_name,
             session.jsonl_path AS jsonl_path
      FROM sessions session
      JOIN projects project ON project.project_path = session.project_path
      WHERE session.provider = ?
        AND session.provider_session_id = ?
      LIMIT 1
    `).get(provider, nativeSessionId) as ExternalSessionActivityAppSession | null);
  const syncCodexRollout: NonNullable<ExternalSessionActivityResolverDependencies['synchronizeCodexRollout']> = dependencies.synchronizeCodexRollout
    ?? ((rolloutPath: string) => sessionSynchronizerService.synchronizeProviderFile('codex', rolloutPath));
  const resolveCodexRollout: NonNullable<ExternalSessionActivityResolverDependencies['resolveCodexRolloutPath']> = dependencies.resolveCodexRolloutPath
    ?? resolveCodexRolloutPath;
  const readActivityEvidence: NonNullable<ExternalSessionActivityResolverDependencies['readActivityEvidence']> = dependencies.readActivityEvidence
    ?? readExternalSessionActivityEvidenceDetailed;
  const readTranscriptEnded: NonNullable<ExternalSessionActivityResolverDependencies['readTranscriptEnded']> = dependencies.readTranscriptEnded
    ?? readExternalTranscriptEndedDetailed;

  let appSession: ExternalSessionActivityAppSession | null = null;
  try {
    appSession = getAppSession(session.kind, session.providerSessionId);
  } catch {
    return unavailableResolution('app_session_lookup_unavailable', null);
  }

  if (!appSession && session.kind === 'codex') {
    let rolloutPath: string | null;
    try {
      rolloutPath = await resolveCodexRollout(session.providerSessionId);
    } catch {
      return unavailableResolution('codex_rollout_unavailable', null);
    }
    if (!rolloutPath) return unavailableResolution('codex_rollout_unavailable', null);

    try {
      await syncCodexRollout(rolloutPath);
    } catch {
      return unavailableResolution('codex_synchronization_unavailable', null);
    }

    try {
      appSession = getAppSession('codex', session.providerSessionId);
    } catch {
      return unavailableResolution('app_session_lookup_unavailable', null);
    }
  }

  if (!appSession && session.kind !== 'opencode') {
    return unavailableResolution('app_session_unavailable', null);
  }

  let activityResult: ExternalSessionActivityEvidenceReadResult;
  let transcriptEndedResult: ExternalTranscriptEndedReadResult;
  try {
    if (
      kind === 'omp'
      && !dependencies.readActivityEvidence
      && !dependencies.readTranscriptEnded
      && appSession?.jsonl_path
    ) {
      ({ activityResult, transcriptEndedResult } = await readOmpActivityAndTranscriptEvidence(
        providerSessionId,
        appSession.jsonl_path,
      ));
    } else {
      [activityResult, transcriptEndedResult] = await Promise.all([
        readActivityEvidence({
          kind,
          providerSessionId: session.providerSessionId,
          jsonlPath: appSession?.jsonl_path ?? null,
        }),
        readTranscriptEnded({
          kind: session.kind,
          jsonlPath: appSession?.jsonl_path ?? null,
        }),
      ]);
    }
  } catch {
    return unavailableResolution('transcript_read_unavailable', appSessionMetadata(appSession));
  }

  if (activityResult.status === 'unavailable') {
    return unavailableResolution(activityResult.reasonCode, appSessionMetadata(appSession));
  }
  if (transcriptEndedResult.status === 'unavailable') {
    return unavailableResolution(transcriptEndedResult.reasonCode, appSessionMetadata(appSession));
  }
  return {
    status: 'resolved',
    activity: activityResult.evidence.activity,
    terminalOutcome: activityResult.evidence.terminalOutcome,
    evidenceCursor: activityResult.evidence.evidenceCursor,
    evidenceDigest: activityResult.evidence.evidenceDigest,
    appSession: appSessionMetadata(appSession),
    transcriptEnded: transcriptEndedResult.transcriptEnded,
  };
}

const ACTIVITY_RESOLUTION_CACHE_MS = 30_000;
const ACTIVITY_RESOLUTION_CACHE_MAX_ENTRIES = 512;
const activityResolutionCache = new Map<string, {
  version: string;
  expiresAtMs: number;
  result: ExternalSessionActivityResolutionResult;
}>();

/**
 * Watcher events invalidate the exact provider/session resolution immediately.
 * The bounded TTL remains a correctness fallback for missed filesystem events.
 */
export async function resolveExternalSessionActivity(
  session: Pick<ExternalCliSession, 'kind' | 'providerSessionId'>,
  dependencies: ExternalSessionActivityResolverDependencies = {},
): Promise<ExternalSessionActivityResolutionResult> {
  if (
    Object.keys(dependencies).length > 0
    || session.kind === 'ssh'
    || session.kind === 'shell'
    || !session.providerSessionId
  ) {
    return resolveExternalSessionActivityUncached(session, dependencies);
  }

  const key = `${session.kind}\0${session.providerSessionId}`;
  const version = transcriptChangeVersion(session.kind, session.providerSessionId);
  const now = Date.now();
  const cached = activityResolutionCache.get(key);
  if (cached && cached.version === version && cached.expiresAtMs > now) {
    activityResolutionCache.delete(key);
    activityResolutionCache.set(key, cached);
    return cached.result;
  }

  const result = await resolveExternalSessionActivityUncached(session);
  activityResolutionCache.delete(key);
  activityResolutionCache.set(key, {
    version,
    expiresAtMs: now + ACTIVITY_RESOLUTION_CACHE_MS,
    result,
  });
  if (activityResolutionCache.size > ACTIVITY_RESOLUTION_CACHE_MAX_ENTRIES) {
    activityResolutionCache.delete(activityResolutionCache.keys().next().value!);
  }
  return result;
}
