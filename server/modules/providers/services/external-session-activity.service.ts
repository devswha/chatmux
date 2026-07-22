import { open, stat } from 'node:fs/promises';

import Database from 'better-sqlite3';

import { getOpenCodeDatabasePath } from '@/shared/utils.js';

import type { ExternalLocalCliKind } from './external-cli-sessions.service.js';

export type ExternalSessionActivity = 'running' | 'waiting_user' | 'asking_user' | 'unknown';

type JsonRecord = Record<string, unknown>;

const FILE_TAIL_BYTES = 128 * 1024;
const fileActivityCache = new Map<string, { size: number; activity: ExternalSessionActivity }>();

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

async function readFileTail(filePath: string): Promise<{ size: number; text: string }> {
  const fileStat = await stat(filePath);
  const size = fileStat.size;
  const start = Math.max(0, size - FILE_TAIL_BYTES);
  const length = size - start;
  if (length === 0) return { size, text: '' };
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    return { size, text: lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '' };
  } finally {
    await handle.close();
  }
}

async function readJsonlActivity(
  kind: Exclude<ExternalLocalCliKind, 'opencode'>,
  filePath: string,
): Promise<ExternalSessionActivity> {
  try {
    const fileStat = await stat(filePath);
    const cached = fileActivityCache.get(filePath);
    if (cached?.size === fileStat.size) return cached.activity;
    const tail = await readFileTail(filePath);
    const activity = parseExternalJsonlActivity(kind, tail.text);
    fileActivityCache.set(filePath, { size: tail.size, activity });
    return activity;
  } catch {
    return 'unknown';
  }
}

function readOpenCodeActivity(providerSessionId: string): ExternalSessionActivity {
  let db: Database.Database | null = null;
  try {
    db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
    const message = db.prepare(`
      SELECT id, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created DESC, time_updated DESC, id DESC
      LIMIT 1
    `).get(providerSessionId) as { id?: string; data?: string } | undefined;
    if (!message?.id || !message.data) return 'unknown';
    const parts = db.prepare(`
      SELECT data
      FROM part
      WHERE message_id = ?
      ORDER BY time_updated DESC, time_created DESC, id DESC
      LIMIT 32
    `).all(message.id) as Array<{ data?: string }>;
    return parseOpenCodeActivity(message.data, parts.map((part) => part.data));
  } catch {
    return 'unknown';
  } finally {
    db?.close();
  }
}

export async function readExternalSessionActivity(input: {
  kind: ExternalLocalCliKind;
  providerSessionId: string | null | undefined;
  jsonlPath: string | null | undefined;
}): Promise<ExternalSessionActivity> {
  if (!input.providerSessionId) return 'unknown';
  if (input.kind === 'opencode') return readOpenCodeActivity(input.providerSessionId);
  if (!input.jsonlPath) return 'unknown';
  return readJsonlActivity(input.kind, input.jsonlPath);
}
