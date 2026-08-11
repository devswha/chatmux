import fsSync from 'node:fs';

import { sessionsDb } from '@/modules/database/index.js';
import { toImageAttachments } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, sliceTailPage } from '@/shared/utils.js';

const PROVIDER = 'codex';

export function normalizeCodexToolName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return 'Unknown';
  }
  return value === 'request_user_input' ? 'AskUserQuestion' : value;
}

type CodexHistoryResult =
  | NormalizedMessage[]
  | {
      messages?: NormalizedMessage[];
      total?: number;
      hasMore?: boolean;
      sourceStatus?: 'available' | 'missing' | 'unreadable';
      offset?: number;
      limit?: number | null;
      tokenUsage?: unknown;
    };

function isVisibleCodexUserMessage(payload: AnyRecord | null | undefined): boolean {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  return typeof payload.message === 'string' && payload.message.trim().length > 0;
}

/**
 * Reads the image attachments Codex records on `user_message` events.
 * Turns sent with `local_image` input items land in `local_images` as file
 * paths (verified against real rollout JSONL); the `images` array can carry
 * base64 data URLs, which are passed through as inline `data` attachments so
 * the UI can preview them without a file lookup.
 *
 * Exported for tests.
 */
export function extractCodexUserImages(
  payload: AnyRecord | null | undefined,
): Array<{ path?: string; data?: string }> | undefined {
  if (!payload) {
    return undefined;
  }

  const candidates = [
    ...(Array.isArray(payload.local_images) ? payload.local_images : []),
    ...(Array.isArray(payload.images) ? payload.images : []),
  ];

  const attachments: Array<{ path?: string; data?: string }> = [];
  for (const entry of candidates) {
    if (typeof entry !== 'string' || !entry.trim()) {
      continue;
    }
    if (entry.startsWith('data:')) {
      attachments.push({ data: entry });
    } else {
      attachments.push(...toImageAttachments([entry]));
    }
  }

  return attachments.length > 0 ? attachments : undefined;
}

function extractCodexTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const record = item as AnyRecord;
      if (
        (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text')
        && typeof record.text === 'string'
      ) {
        return record.text;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

type CodexHistoryAccumulator = {
  messages: AnyRecord[];
  tokenUsage: AnyRecord | null;
  malformed: boolean;
};

type CodexHistoryCacheEntry = {
  filePath: string;
  device: number | bigint;
  inode: number | bigint;
  changedAtMs: number;
  offset: number;
  tail: string;
  boundary: Buffer;
  messages: NormalizedMessage[];
  tokenUsage: AnyRecord | null;
  malformed: boolean;
  normalizedBytes: number;
  toolResults: Map<string, NormalizedMessage>;
  toolUses: Map<string, NormalizedMessage[]>;
  sortTimestamps: WeakMap<NormalizedMessage, number>;
};

type CodexHistoryNormalizer = (
  raw: AnyRecord,
  sessionId: string | null,
) => NormalizedMessage[];

const CODEX_HISTORY_CACHE_MAX_ENTRIES = 4;
// Bound cached *normalized* history rather than the raw rollout size. Codex
// rollouts often contain large context records that never become UI messages;
// evicting based on raw bytes made those files get reparsed from byte zero on
// every 20-message page request.
const CODEX_HISTORY_CACHE_MAX_NORMALIZED_BYTES = 96 * 1024 * 1024;
const CODEX_HISTORY_BOUNDARY_BYTES = 4 * 1024;
const codexHistoryCache = new Map<string, CodexHistoryCacheEntry>();
const codexHistoryRefreshes = new Map<string, Promise<CodexHistoryCacheEntry>>();

function parseCodexHistoryLine(line: string, accumulator: CodexHistoryAccumulator): void {
  if (!line.trim()) return;
  try {
    const entry = JSON.parse(line) as AnyRecord;

    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
      const info = entry.payload.info as AnyRecord;
      if (info.total_token_usage) {
        const usage = info.total_token_usage as AnyRecord;
        const inputTokens = Number(usage.input_tokens || 0);
        const outputTokens = Number(usage.output_tokens || 0);
        accumulator.tokenUsage = {
          used: usage.total_tokens || 0,
          total: info.model_context_window || 200000,
          inputTokens,
          outputTokens,
          breakdown: {
            input: inputTokens,
            output: outputTokens,
          },
        };
      }
    }

    if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload as AnyRecord)) {
      accumulator.messages.push({
        type: 'user',
        timestamp: entry.timestamp,
        message: {
          role: 'user',
          content: entry.payload.message,
        },
        images: extractCodexUserImages(entry.payload as AnyRecord),
      });
    }

    if (
      entry.type === 'response_item'
      && entry.payload?.type === 'message'
      && entry.payload.role === 'assistant'
    ) {
      const textContent = extractCodexTextContent(entry.payload.content);
      if (textContent.trim()) {
        accumulator.messages.push({
          type: 'assistant',
          timestamp: entry.timestamp,
          message: {
            role: 'assistant',
            content: textContent,
          },
        });
      }
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
      const summaryText = Array.isArray(entry.payload.summary)
        ? entry.payload.summary
            .map((item: AnyRecord) => item?.text)
            .filter(Boolean)
            .join('\n')
        : '';

      if (summaryText.trim()) {
        accumulator.messages.push({
          type: 'thinking',
          timestamp: entry.timestamp,
          message: {
            role: 'assistant',
            content: summaryText,
          },
        });
      }
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
      let toolName = normalizeCodexToolName(entry.payload.name);
      let toolInput = entry.payload.arguments;

      if (toolName === 'shell_command') {
        toolName = 'Bash';
        try {
          const args = JSON.parse(entry.payload.arguments) as AnyRecord;
          toolInput = JSON.stringify({ command: args.command });
        } catch {
          // Keep original arguments when parsing fails.
        }
      }

      accumulator.messages.push({
        type: 'tool_use',
        timestamp: entry.timestamp,
        toolName,
        toolInput,
        toolCallId: entry.payload.call_id,
      });
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
      accumulator.messages.push({
        type: 'tool_result',
        timestamp: entry.timestamp,
        toolCallId: entry.payload.call_id,
        output: entry.payload.output,
      });
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call') {
      const toolName = entry.payload.name || 'custom_tool';
      const input = entry.payload.input || '';

      if (toolName === 'apply_patch') {
        const fileMatch = String(input).match(/\*\*\* Update File: (.+)/);
        const filePath = fileMatch ? fileMatch[1].trim() : 'unknown';
        const lines = String(input).split('\n');
        const oldLines: string[] = [];
        const newLines: string[] = [];

        for (const lineContent of lines) {
          if (lineContent.startsWith('-') && !lineContent.startsWith('---')) {
            oldLines.push(lineContent.slice(1));
          } else if (lineContent.startsWith('+') && !lineContent.startsWith('+++')) {
            newLines.push(lineContent.slice(1));
          }
        }

        accumulator.messages.push({
          type: 'tool_use',
          timestamp: entry.timestamp,
          toolName: 'Edit',
          toolInput: JSON.stringify({
            file_path: filePath,
            old_string: oldLines.join('\n'),
            new_string: newLines.join('\n'),
          }),
          toolCallId: entry.payload.call_id,
        });
      } else {
        accumulator.messages.push({
          type: 'tool_use',
          timestamp: entry.timestamp,
          toolName,
          toolInput: input,
          toolCallId: entry.payload.call_id,
        });
      }
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call_output') {
      accumulator.messages.push({
        type: 'tool_result',
        timestamp: entry.timestamp,
        toolCallId: entry.payload.call_id,
        output: entry.payload.output || '',
      });
    }
  } catch {
    accumulator.malformed = true;
    // Skip malformed lines so history can still render valid records.
  }
}

/** Exported for focused cache-budget regression tests. */
export function isCodexHistoryCacheable(
  normalizedBytes: number,
  tailBytes: number,
  boundaryBytes: number,
  maxBytes = CODEX_HISTORY_CACHE_MAX_NORMALIZED_BYTES,
): boolean {
  return normalizedBytes + tailBytes + boundaryBytes <= maxBytes;
}

function codexHistoryRetainedBytes(entry: CodexHistoryCacheEntry): number {
  return entry.normalizedBytes + Buffer.byteLength(entry.tail) + entry.boundary.byteLength;
}

function touchCodexHistoryCache(sessionId: string, entry: CodexHistoryCacheEntry): void {
  codexHistoryCache.delete(sessionId);
  if (!isCodexHistoryCacheable(
    entry.normalizedBytes,
    Buffer.byteLength(entry.tail),
    entry.boundary.byteLength,
  )) {
    return;
  }

  codexHistoryCache.set(sessionId, entry);
  const cachedBytes = () => Array.from(codexHistoryCache.values())
    .reduce((total, candidate) => total + codexHistoryRetainedBytes(candidate), 0);
  while (
    codexHistoryCache.size > CODEX_HISTORY_CACHE_MAX_ENTRIES
    || cachedBytes() > CODEX_HISTORY_CACHE_MAX_NORMALIZED_BYTES
  ) {
    codexHistoryCache.delete(codexHistoryCache.keys().next().value!);
  }
}

function estimateCodexMessageBytes(message: NormalizedMessage): number {
  let value: string;
  try {
    value = JSON.stringify({
      content: message.content,
      images: message.images,
      toolInput: message.toolInput,
    }) || '';
  } catch {
    value = String(message.content || '');
  }
  return Buffer.byteLength(value) + 256;
}

async function readCodexHistoryBoundary(filePath: string, offset: number): Promise<Buffer> {
  if (offset <= 0) return Buffer.alloc(0);
  const length = Math.min(offset, CODEX_HISTORY_BOUNDARY_BYTES);
  const buffer = Buffer.allocUnsafe(length);
  const handle = await fsSync.promises.open(filePath, 'r');
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function codexMessageTimestamp(
  message: NormalizedMessage,
  sortTimestamps?: WeakMap<NormalizedMessage, number>,
): number {
  const cached = sortTimestamps?.get(message);
  if (cached !== undefined) return cached;
  const timestamp = new Date(message.timestamp || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function appendNormalizedCodexHistory(
  entry: CodexHistoryCacheEntry,
  rawMessages: AnyRecord[],
  sessionId: string,
  normalize: CodexHistoryNormalizer,
): void {
  let lastTimestamp = entry.messages.length > 0
    ? codexMessageTimestamp(entry.messages[entry.messages.length - 1], entry.sortTimestamps)
    : 0;
  let needsSort = false;

  for (const raw of rawMessages) {
    const rawTimestamp = new Date(raw.timestamp || 0).getTime();
    const sortTimestamp = Number.isFinite(rawTimestamp) ? rawTimestamp : 0;
    for (const message of normalize(raw, sessionId)) {
      entry.normalizedBytes += estimateCodexMessageBytes(message);
      entry.sortTimestamps.set(message, sortTimestamp);

      if (message.kind === 'tool_result' && message.toolId) {
        entry.toolResults.set(message.toolId, message);
        const matchingToolUses = entry.toolUses.get(message.toolId) ?? [];
        for (const toolUse of matchingToolUses) {
          toolUse.toolResult = { content: message.content, isError: message.isError };
        }
        if (matchingToolUses.length > 0) {
          entry.toolUses.delete(message.toolId);
          entry.toolResults.delete(message.toolId);
        }
      } else if (message.kind === 'tool_use' && message.toolId) {
        const toolResult = entry.toolResults.get(message.toolId);
        if (toolResult) {
          message.toolResult = { content: toolResult.content, isError: toolResult.isError };
          entry.toolResults.delete(message.toolId);
        } else {
          const toolUses = entry.toolUses.get(message.toolId) ?? [];
          toolUses.push(message);
          entry.toolUses.set(message.toolId, toolUses);
        }
      }

      // Tool results are represented inside their tool-use card. Returning the
      // standalone result as well doubled large outputs and also made limit /
      // offset count a different list than the frontend received.
      if (message.kind === 'tool_result') continue;

      if (sortTimestamp < lastTimestamp) needsSort = true;
      lastTimestamp = Math.max(lastTimestamp, sortTimestamp);
      entry.messages.push(message);
    }
  }

  if (needsSort) {
    entry.messages.sort(
      (a, b) => codexMessageTimestamp(a, entry.sortTimestamps)
        - codexMessageTimestamp(b, entry.sortTimestamps),
    );
  }
}

async function refreshCodexHistoryCache(
  sessionId: string,
  sessionFilePath: string,
  normalize: CodexHistoryNormalizer,
): Promise<CodexHistoryCacheEntry> {
  const metadata = await fsSync.promises.stat(sessionFilePath);
  let entry = codexHistoryCache.get(sessionId);
  const sameFile = entry != null
    && entry.filePath === sessionFilePath
    && entry.device === metadata.dev
    && entry.inode === metadata.ino;
  // Appends naturally change ctime, so only use it to reject an otherwise
  // indistinguishable same-length in-place rewrite. mtime can be restored by
  // callers and the EOF boundary does not cover edits earlier in the file.
  const sameLengthUnchanged = entry == null
    || metadata.size !== entry.offset
    || metadata.ctimeMs === entry.changedAtMs;
  const boundaryMatches = entry != null
    && sameFile
    && sameLengthUnchanged
    && metadata.size >= entry.offset
    && (entry.offset === 0
      || (await readCodexHistoryBoundary(sessionFilePath, entry.offset)).equals(entry.boundary));
  const appendOnly = entry != null && boundaryMatches;

  if (!entry || !appendOnly) {
    entry = {
      filePath: sessionFilePath,
      device: metadata.dev,
      inode: metadata.ino,
      changedAtMs: metadata.ctimeMs,
      offset: 0,
      tail: '',
      boundary: Buffer.alloc(0),
      messages: [],
      tokenUsage: null,
      normalizedBytes: 0,
      malformed: false,
      toolResults: new Map(),
      toolUses: new Map(),
      sortTimestamps: new WeakMap(),
    };
  }

  if (metadata.size > entry.offset) {
    const appended: CodexHistoryAccumulator = {
      messages: [],
      tokenUsage: entry.tokenUsage,
      malformed: entry.malformed,
    };
    let tail = entry.tail;
    const fileStream = fsSync.createReadStream(sessionFilePath, {
      start: entry.offset,
      end: metadata.size - 1,
      encoding: 'utf8',
    });
    for await (const chunk of fileStream) {
      const lines = `${tail}${chunk}`.split(/\r?\n/);
      tail = lines.pop() ?? '';
      for (const line of lines) {
        parseCodexHistoryLine(line, appended);
        if (appended.messages.length > 0) {
          appendNormalizedCodexHistory(entry, appended.messages, sessionId, normalize);
          appended.messages.length = 0;
        }
      }
    }

    entry.tokenUsage = appended.tokenUsage;
    entry.tail = tail;
    entry.offset = metadata.size;
    entry.changedAtMs = metadata.ctimeMs;
    entry.boundary = await readCodexHistoryBoundary(sessionFilePath, entry.offset);
    entry.malformed = appended.malformed;
  }

  touchCodexHistoryCache(sessionId, entry);
  return entry;
}

function loadCodexHistory(
  sessionId: string,
  sessionFilePath: string,
  normalize: CodexHistoryNormalizer,
): Promise<CodexHistoryCacheEntry> {
  const current = codexHistoryRefreshes.get(sessionId);
  if (current) return current;
  const refresh = refreshCodexHistoryCache(sessionId, sessionFilePath, normalize)
    .finally(() => {
      if (codexHistoryRefreshes.get(sessionId) === refresh) {
        codexHistoryRefreshes.delete(sessionId);
      }
    });
  codexHistoryRefreshes.set(sessionId, refresh);
  return refresh;
}

async function getCodexSessionMessages(
  sessionId: string,
  normalize: CodexHistoryNormalizer,
  limit: number | null = null,
  offset = 0,
): Promise<CodexHistoryResult> {
  try {
    const sessionFilePath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

    if (!sessionFilePath) {
      console.warn(`Codex session file not found for session ${sessionId}`);
      return { messages: [], total: 0, hasMore: false, sourceStatus: 'missing' };
    }

    const { messages, tokenUsage, malformed } = await loadCodexHistory(sessionId, sessionFilePath, normalize);
    const total = messages.length;
    const sourceStatus = malformed ? 'unreadable' : 'available';

    if (limit !== null) {
      const startIndex = Math.max(0, total - offset - limit);
      const endIndex = total - offset;
      const paginatedMessages = messages.slice(startIndex, endIndex);
      const hasMore = startIndex > 0;

      return {
        messages: paginatedMessages,
        total,
        hasMore,
        offset,
        limit,
        tokenUsage,
        sourceStatus,
      };
    }

    return { messages, tokenUsage, sourceStatus };
  } catch (error) {
    console.error(`Error reading Codex session messages for ${sessionId}:`, error);
    const code = error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
    return {
      messages: [],
      total: 0,
      hasMore: false,
      sourceStatus: code === 'ENOENT' ? 'missing' : 'unreadable',
    };
  }
}

export class CodexSessionsProvider implements IProviderSessions {
  /**
   * Normalizes a persisted Codex JSONL entry.
   *
   * Live Codex SDK events are transformed before they reach normalizeMessage(),
   * while history entries already use a compact message/tool shape from projects.js.
   */
  private normalizeHistoryEntry(raw: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');

    if (raw.type === 'thinking' || raw.isReasoning) {
      const thinkingContent = typeof raw.message?.content === 'string'
        ? raw.message.content
        : '';
      if (!thinkingContent.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: thinkingContent,
      })];
    }

    if (raw.message?.role === 'user') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : String(raw.message.content || '');
      const rawImages = Array.isArray(raw.images) && raw.images.length > 0 ? raw.images : undefined;
      if (!content.trim() && !rawImages) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        content,
        images: rawImages,
      })];
    }

    if (raw.message?.role === 'assistant') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : '';
      if (!content.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content,
      })];
    }

    if (raw.type === 'tool_use' || raw.toolName) {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: normalizeCodexToolName(raw.toolName),
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      })];
    }

    if (raw.type === 'tool_result') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: Boolean(raw.isError),
      })];
    }

    return [];
  }

  /**
   * Normalizes either a Codex history entry or a transformed live SDK event.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (raw.message?.role) {
      return this.normalizeHistoryEntry(raw, sessionId);
    }

    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');

    if (raw.type === 'item') {
      switch (raw.itemType) {
        case 'agent_message':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: raw.message?.content || '',
          })];
        case 'reasoning':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'thinking',
            content: raw.message?.content || '',
          })];
        case 'command_execution':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'Bash',
            toolInput: { command: raw.command },
            toolId: baseId,
            output: raw.output,
            exitCode: raw.exitCode,
            status: raw.status,
          })];
        case 'file_change':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'FileChanges',
            toolInput: raw.changes,
            toolId: baseId,
            status: raw.status,
          })];
        case 'mcp_tool_call':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: raw.tool || 'MCP',
            toolInput: raw.arguments,
            toolId: baseId,
            server: raw.server,
            result: raw.result,
            error: raw.error,
            status: raw.status,
          })];
        case 'web_search':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'WebSearch',
            toolInput: { query: raw.query },
            toolId: baseId,
          })];
        case 'todo_list':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'TodoList',
            toolInput: { items: raw.items },
            toolId: baseId,
          })];
        case 'error':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'error',
            content: raw.message?.content || 'Unknown error',
          })];
        default:
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: raw.itemType || 'Unknown',
            toolInput: raw.item || raw,
            toolId: baseId,
          })];
      }
    }

    if (raw.type === 'turn_complete') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'complete',
      })];
    }
    if (raw.type === 'turn_failed') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'error',
        content: raw.error?.message || 'Turn failed',
      })];
    }
    // Top-level SDK error (openai-codex transforms `error` → {type:'error'}); without
    // this branch the live error event was silently dropped and never shown.
    if (raw.type === 'error') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'error',
        content: (typeof raw.message === 'string' ? raw.message : raw.message?.content) || 'Codex error',
      })];
    }

    return [];
  }

  /**
   * Loads Codex JSONL history and keeps token usage metadata when projects.js
   * provides it.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    let result: CodexHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = await getCodexSessionMessages(
        sessionId,
        (raw, targetSessionId) => this.normalizeHistoryEntry(raw, targetSessionId),
        null,
        0,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodexProvider] Failed to load session ${sessionId}:`, message);
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: 0,
        limit: null,
        sourceStatus: 'unreadable',
      };
    }

    const normalized = Array.isArray(result) ? result : (result.messages || []);
    const tokenUsage = Array.isArray(result) ? undefined : result.tokenUsage;
    const sourceStatus = Array.isArray(result) ? 'available' : result.sourceStatus;

    const total = normalized.length;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      tokenUsage,
      sourceStatus,
    };
  }
}
