import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { getOpenCodeDatabasePath } from '@/shared/utils.js';

import {
  resolveCodexRolloutPath,
  type ExternalCliSession,
  type ExternalLocalCliKind,
} from './external-cli-sessions.service.js';
import { recordHostCommand } from './host-command-metrics.service.js';

export type ExternalSessionActivity = 'running' | 'waiting_user' | 'asking_user' | 'unknown';
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

export type ExternalSessionActivityResolverDependencies = {
  getAppSession?: (
    provider: ExternalLocalCliKind,
    providerSessionId: string,
  ) => ExternalSessionActivityAppSession | null;
  resolveCodexRolloutPath?: (providerSessionId: string) => Promise<string | null>;
  synchronizeCodexRollout?: (rolloutPath: string) => Promise<unknown>;
  readActivity?: (input: {
    kind: ExternalLocalCliKind;
    providerSessionId: string | null | undefined;
    jsonlPath: string | null | undefined;
  }) => Promise<ExternalSessionActivityReadResult>;
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

const parseOmpActivity = (records: JsonRecord[]): ExternalSessionActivity => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.type !== 'message') continue;
    const message = asRecord(record.message);
    const role = readString(message?.role);
    if (role === 'assistant') {
      if (containsAskingTool(message?.content)) return 'asking_user';
      const stopReason = readString(message?.stopReason);
      return stopReason === 'stop' || stopReason === 'error' ? 'waiting_user' : 'running';
    }
    if (role === 'user' || role === 'toolResult') return 'running';
  }
  return 'unknown';
};

const parseClaudeActivity = (records: JsonRecord[]): ExternalSessionActivity => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const type = readString(record.type);
    if (type === 'result' || type === 'error') return 'waiting_user';
    if (type !== 'assistant' && type !== 'user') continue;
    const message = asRecord(record.message);
    const role = readString(message?.role) ?? type;
    if (role === 'user') return 'running';
    if (role !== 'assistant') continue;
    if (containsAskingTool(message?.content)) return 'asking_user';
    const stopReason = readString(message?.stop_reason) ?? readString(message?.stopReason);
    if (!stopReason || stopReason === 'tool_use') return 'running';
    return 'waiting_user';
  }
  return 'unknown';
};

const parseCodexActivity = (records: JsonRecord[]): ExternalSessionActivity => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const type = readString(record.type);
    const payload = asRecord(record.payload);
    const payloadType = readString(payload?.type);

    if (type === 'turn_complete' || type === 'turn_failed' || type === 'error') return 'waiting_user';
    if (type === 'event_msg') {
      if (payloadType === 'task_complete' || payloadType === 'turn_complete' || payloadType === 'turn_failed' || payloadType === 'error') {
        return 'waiting_user';
      }
      if (containsAskingTool(payload)) return 'asking_user';
      if (payloadType === 'task_started' || payloadType === 'user_message' || payloadType === 'turn_started') {
        return 'running';
      }
      continue;
    }
    if (type === 'response_item') {
      if (containsAskingTool(payload)) return 'asking_user';
      const role = readString(payload?.role);
      if (role === 'user' || containsToolCall(payload) || payloadType === 'function_call_output') return 'running';
      if (role === 'assistant') return 'running';
      continue;
    }
    if (type === 'turn_context') return 'running';
  }
  return 'unknown';
};

const parseCursorActivity = (records: JsonRecord[]): ExternalSessionActivity => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const message = asRecord(record.message);
    const role = readString(record.role) ?? readString(message?.role);
    const content = record.content ?? message?.content;
    if (role === 'user' || role === 'tool') return 'running';
    if (role !== 'assistant') continue;
    if (containsAskingTool(content)) return 'asking_user';
    return containsToolCall(content) ? 'running' : 'waiting_user';
  }
  return 'unknown';
};

export function parseExternalJsonlActivity(
  kind: Exclude<ExternalLocalCliKind, 'opencode'>,
  tailText: string,
): ExternalSessionActivity {
  const records = parseJsonLines(tailText);
  if (kind === 'omp') return parseOmpActivity(records);
  if (kind === 'claude') return parseClaudeActivity(records);
  if (kind === 'codex') return parseCodexActivity(records);
  return parseCursorActivity(records);
}

const isPendingQuestionPart = (value: unknown): boolean => {
  const record = parseRecord(value);
  if (!record || !containsAskingTool(record)) return false;
  const state = asRecord(record.state);
  const status = readString(state?.status)?.toLowerCase();
  return status === 'pending' || status === 'running';
};

export function parseOpenCodeActivity(
  messageData: unknown,
  partData: readonly unknown[] = [],
): ExternalSessionActivity {
  const message = parseRecord(messageData);
  if (!message) return 'unknown';
  const role = readString(message.role);
  if (role === 'user') return 'running';
  if (role !== 'assistant') return 'unknown';
  if (message.error !== null && message.error !== undefined) return 'waiting_user';
  if (partData.some(isPendingQuestionPart)) return 'asking_user';
  const time = asRecord(message.time);
  const completed = time?.completed;
  if (completed === null || completed === undefined) return 'running';
  const finish = readString(message.finish)?.toLowerCase();
  return finish === 'tool-calls' ? 'running' : 'waiting_user';
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
export async function resolveExternalSessionActivity(
  session: Pick<ExternalCliSession, 'kind' | 'providerSessionId'>,
  dependencies: ExternalSessionActivityResolverDependencies = {},
): Promise<ExternalSessionActivityResolutionResult> {
  if (session.kind === 'ssh' || session.kind === 'shell') {
    return unavailableResolution('unsupported_session_kind', null);
  }
  if (!session.providerSessionId) {
    return unavailableResolution('provider_session_id_unavailable', null);
  }

  const getAppSession: NonNullable<ExternalSessionActivityResolverDependencies['getAppSession']> = dependencies.getAppSession
    ?? ((provider: ExternalLocalCliKind, providerSessionId: string) => (
      sessionsDb.getSessionByProviderSessionId(provider, providerSessionId)
    ));
  const syncCodexRollout: NonNullable<ExternalSessionActivityResolverDependencies['synchronizeCodexRollout']> = dependencies.synchronizeCodexRollout
    ?? ((rolloutPath: string) => sessionSynchronizerService.synchronizeProviderFile('codex', rolloutPath));
  const resolveCodexRollout: NonNullable<ExternalSessionActivityResolverDependencies['resolveCodexRolloutPath']> = dependencies.resolveCodexRolloutPath
    ?? resolveCodexRolloutPath;
  const readActivity: NonNullable<ExternalSessionActivityResolverDependencies['readActivity']> = dependencies.readActivity
    ?? readExternalSessionActivityDetailed;
  const readTranscriptEnded: NonNullable<ExternalSessionActivityResolverDependencies['readTranscriptEnded']> = dependencies.readTranscriptEnded
    ?? readExternalTranscriptEndedDetailed;

  let appSession: ExternalSessionActivityAppSession | null;
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

  let activityResult: ExternalSessionActivityReadResult;
  let transcriptEndedResult: ExternalTranscriptEndedReadResult;
  try {
    [activityResult, transcriptEndedResult] = await Promise.all([
      readActivity({
        kind: session.kind,
        providerSessionId: session.providerSessionId,
        jsonlPath: appSession?.jsonl_path,
      }),
      readTranscriptEnded({
        kind: session.kind,
        jsonlPath: appSession?.jsonl_path,
      }),
    ]);
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
    activity: activityResult.activity,
    appSession: appSessionMetadata(appSession),
    transcriptEnded: transcriptEndedResult.transcriptEnded,
  };
}
