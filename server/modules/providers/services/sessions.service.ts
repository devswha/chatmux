import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types.js';
import { AppError, validateWorkspacePath } from '@/shared/utils.js';

type CreateAppSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
};

const HISTORY_TOOL_OUTPUT_PREVIEW_BYTES = 64 * 1024;

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

function utf8SafeHeadEnd(source: Buffer, requestedEnd: number): number {
  let end = Math.min(Math.max(0, requestedEnd), source.length);
  while (end > 0 && end < source.length && isUtf8ContinuationByte(source[end])) {
    end -= 1;
  }
  return end;
}

function utf8SafeTailStart(source: Buffer, requestedStart: number): number {
  let start = Math.min(Math.max(0, requestedStart), source.length);
  while (start < source.length && isUtf8ContinuationByte(source[start])) {
    start += 1;
  }
  return start;
}

function stringifyToolOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content, null, 2) ?? String(content ?? '');
  } catch {
    return String(content ?? '');
  }
}

function buildToolOutputPreview(content: unknown): {
  content: unknown;
  truncated: boolean;
  bytes: number;
} {
  const serialized = stringifyToolOutput(content);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= HISTORY_TOOL_OUTPUT_PREVIEW_BYTES) {
    return { content, truncated: false, bytes };
  }

  const source = Buffer.from(serialized);
  const headBytes = Math.floor(HISTORY_TOOL_OUTPUT_PREVIEW_BYTES * 0.75);
  const tailBytes = HISTORY_TOOL_OUTPUT_PREVIEW_BYTES - headBytes;
  const headEnd = utf8SafeHeadEnd(source, headBytes);
  const tailStart = utf8SafeTailStart(source, source.length - tailBytes);
  const head = source.subarray(0, headEnd).toString('utf8');
  const tail = source.subarray(tailStart).toString('utf8');
  return {
    content: `${head}\n\n… [${tailStart - headEnd} bytes omitted] …\n\n${tail}`,
    truncated: true,
    bytes,
  };
}

/**
 * Keeps history pages cheap to transfer without discarding persisted data.
 * The full tool result remains available through fetchToolResult().
 */
export function prepareHistoryMessagesForTransport(
  messages: NormalizedMessage[],
  includeImages = true,
): NormalizedMessage[] {
  return messages.map((message) => {
    let prepared = includeImages || message.images === undefined
      ? message
      : { ...message, images: undefined };

    if (message.kind === 'tool_result') {
      const preview = buildToolOutputPreview(message.content);
      if (preview.truncated) {
        prepared = {
          ...prepared,
          content: preview.content as string,
          toolResultTruncated: true,
          toolResultBytes: preview.bytes,
        };
      }
    }

    if (message.toolResult && 'content' in message.toolResult) {
      const preview = buildToolOutputPreview(message.toolResult.content);
      if (preview.truncated) {
        prepared = {
          ...prepared,
          toolResult: {
            ...message.toolResult,
            content: preview.content as string,
          },
          toolResultTruncated: true,
          toolResultBytes: preview.bytes,
        };
      }
    }

    return prepared;
  });
}
function normalizeJsonlPath(filePath: string): string {
  return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(filePath);
}

/**
 * Removes one transcript file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}


/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Returns app-facing ids for provider runs that are currently processing.
   *
   * This is intentionally status-only: callers that only need sidebar activity
   * indicators should not attach to chat streams or request replayed messages.
   */
  listRunningSessions(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return chatRunRegistry.listRunningRuns();
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Allocates a stable app-facing session id before any provider run happens.
   *
   * This is the entry point of the session gateway: the frontend calls this
   * (via `POST /api/providers/sessions`) when the user starts a brand-new
   * chat, navigates to the returned id immediately, and the id never changes
   * for the lifetime of the conversation. The provider-native id is mapped to
   * this row later, when the provider runtime announces it mid-run.
   */
  async createAppSession(
    provider: LLMProvider,
    projectPath: string,
    deps: { validate?: typeof validateWorkspacePath; isDirectory?: (candidate: string) => Promise<boolean> } = {},
  ): Promise<CreateAppSessionResult> {
    const normalizedProjectPath = projectPath.trim();
    if (!normalizedProjectPath) {
      throw new AppError('projectPath is required.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }
    // Registering a directory as a project hands every file and git route its
    // root, so the browser only gets to register existing directories that the
    // workspace policy allows (under WORKSPACES_ROOT, never a system path).
    const validation = await (deps.validate ?? validateWorkspacePath)(normalizedProjectPath);
    if (!validation.valid) {
      throw new AppError(validation.error ?? 'projectPath is not allowed.', {
        code: 'INVALID_PROJECT_PATH',
        statusCode: 400,
      });
    }
    const isDirectory = deps.isDirectory ?? (async (candidate: string) => { try { return (await fsp.stat(candidate)).isDirectory(); } catch { return false; } });
    if (!(await isDirectory(normalizedProjectPath))) {
      throw new AppError('projectPath must be an existing directory.', {
        code: 'PROJECT_PATH_NOT_FOUND',
        statusCode: 400,
      });
    }

    const sessionId = randomUUID();
    sessionsDb.createAppSession(sessionId, provider, normalizedProjectPath);

    return {
      sessionId,
      provider,
      projectPath: normalizedProjectPath,
    };
  },

  /**
   * Fetches persisted history by app session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database. The provider adapter receives the
   * provider-native session id (the one written into transcripts on disk),
   * and every returned message is remapped back to the app session id so
   * provider ids never reach the frontend.
   */
  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset' | 'includeImages'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // App-created sessions that never produced a provider transcript yet
    // (e.g. first message still streaming) simply have no history.
    if (!session.provider_session_id) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const provider = session.provider as LLMProvider;
    const result = await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
      limit: options.limit ?? null,
      offset: options.offset ?? 0,
      projectPath: session.project_path ?? '',
      providerSessionId: session.provider_session_id,
    });

    return {
      ...result,
      messages: prepareHistoryMessagesForTransport(
        result.messages.map((message) => ({
          ...message,
          sessionId,
        })),
        options.includeImages !== false,
      ),
    };
  },

  /** Loads one complete persisted tool result only when the user requests it. */
  async fetchToolResult(
    sessionId: string,
    toolId: string,
  ): Promise<{ toolId: string; toolResult: NonNullable<NormalizedMessage['toolResult']> }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session?.provider_session_id) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const provider = providerRegistry.resolveProvider(session.provider as LLMProvider);
    const history = await provider.sessions.fetchHistory(sessionId, {
      limit: null,
      offset: 0,
      projectPath: session.project_path ?? '',
      providerSessionId: session.provider_session_id,
    });
    const toolUse = history.messages.find(
      (message) => message.kind === 'tool_use' && message.toolId === toolId && message.toolResult,
    );
    const standaloneResult = history.messages.find(
      (message) => message.kind === 'tool_result' && message.toolId === toolId,
    );
    const toolResult = toolUse?.toolResult ?? (standaloneResult
      ? {
          content: standaloneResult.content,
          isError: standaloneResult.isError,
          toolUseResult: standaloneResult.toolUseResult,
        }
      : null);

    if (!toolResult) {
      throw new AppError(`Tool result "${toolId}" was not found.`, {
        code: 'TOOL_RESULT_NOT_FOUND',
        statusCode: 404,
      });
    }
    return { toolId, toolResult };
  },

  /**
   * Permanently deletes one persisted session row and its transcript file.
   */
  async deleteSessionById(
    sessionId: string,
  ): Promise<{ sessionId: string; action: 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const transcriptPath = session.jsonl_path?.trim() || null;
    if (transcriptPath) {
      const normalizedTranscriptPath = normalizeJsonlPath(transcriptPath);
      const sharedOwner = sessionsDb.getAllSessions().find((candidate) => {
        const candidatePath = candidate.jsonl_path?.trim();
        if (candidate.session_id === sessionId || !candidatePath) {
          return false;
        }
        return normalizeJsonlPath(candidatePath) === normalizedTranscriptPath;
      });

      if (sharedOwner) {
        throw new AppError('This transcript is shared with another session.', {
          code: 'SESSION_TRANSCRIPT_SHARED',
          statusCode: 409,
        });
      }
    }

    const deletedFromDisk = transcriptPath
      ? await removeFileIfExists(transcriptPath)
      : false;
    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk,
    };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },
};
