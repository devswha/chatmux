import os from 'node:os';
import path from 'node:path';
import { open } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

const CODEX_TITLE_SCAN_CHUNK_BYTES = 256 * 1024;

function parseCodexTaskCompleteTitle(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    const payload = data.payload as Record<string, unknown> | undefined;
    const lastAgentMessage = typeof payload?.last_agent_message === 'string'
      ? payload.last_agent_message
      : undefined;
    return data.type === 'event_msg'
      && payload?.type === 'task_complete'
      && lastAgentMessage?.trim()
      ? lastAgentMessage
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;
  private readonly codexHome = path.join(os.homedir(), '.codex');

  /**
   * Scans ~/.codex/sessions and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.codexHome, 'sessions'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const existingSession = sessionsDb.getSessionByProviderSessionId(this.provider, parsed.sessionId)
        ?? sessionsDb.getSessionById(parsed.sessionId);
      if (existingSession) {
        // If session name is untitled and we now have a name, update it
        if (existingSession.custom_name === 'Untitled Codex Session' && parsed.sessionName && parsed.sessionName !== 'Untitled Codex Session') {
          sessionsDb.updateSessionCustomName(existingSession.session_id, parsed.sessionName);
        }
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Codex session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
  }

  /**
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const payload = data.payload as Record<string, unknown> | undefined;
      const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
      const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(this.provider, parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Codex Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Codex Session'),
      };
    }

    // Sessions started by sending a message from ChatMux carry a distinct
    // app-allocated session_id mapped to the provider id. For these we title the
    // conversation from the first user message the user typed, instead of the
    // generic "Untitled Codex Session" placeholder. Sessions discovered purely
    // by indexing (session_id === provider_session_id) keep the existing
    // thread_name/last-agent-message setup below.
    const isAppCreated =
      existingSession != null &&
      existingSession.provider_session_id != null &&
      existingSession.session_id !== existingSession.provider_session_id;

    let sessionName = isAppCreated
      ? await this.extractFirstUserMessageFromStart(filePath)
      : undefined;
    if (!sessionName) {
      sessionName = nameMap.get(parsed.sessionId);
    }
    if (!sessionName) {
      sessionName = await this.extractLastAgentMessageFromEnd(filePath);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Codex Session'),
    };
  }

  /**
   * Returns the first user message text in a Codex transcript, used to title
   * app-created sessions from the prompt the user sent from ChatMux.
   *
   * Reads the `event_msg`/`user_message` payload rather than the raw
   * `response_item` user turn so injected `<environment_context>` boilerplate is
   * never mistaken for the user's prompt.
   */
  private async extractFirstUserMessageFromStart(filePath: string): Promise<string | undefined> {
    return (await extractFirstValidJsonlData<string>(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const payload = data.payload as Record<string, unknown> | undefined;
      const message = typeof payload?.message === 'string' ? payload.message : undefined;
      return data.type === 'event_msg'
        && payload?.type === 'user_message'
        && message?.trim()
        ? message
        : undefined;
    })) ?? undefined;
  }

  private async extractLastAgentMessageFromEnd(filePath: string): Promise<string | undefined> {
    const handle = await open(filePath, 'r').catch(() => null);
    if (!handle) {
      return undefined;
    }

    try {
      const { size } = await handle.stat();
      let position = size;
      let leadingFragment = Buffer.alloc(0);

      while (position > 0) {
        const start = Math.max(0, position - CODEX_TITLE_SCAN_CHUNK_BYTES);
        const buffer = Buffer.allocUnsafe(position - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        if (bytesRead === 0) {
          break;
        }

        const combined = leadingFragment.length > 0
          ? Buffer.concat([buffer.subarray(0, bytesRead), leadingFragment])
          : buffer.subarray(0, bytesRead);
        let lineEnd = combined.length;
        let newline = combined.lastIndexOf(0x0a, lineEnd - 1);
        while (newline >= 0) {
          const title = parseCodexTaskCompleteTitle(
            combined.subarray(newline + 1, lineEnd).toString('utf8'),
          );
          if (title) {
            return title;
          }
          lineEnd = newline;
          newline = combined.lastIndexOf(0x0a, lineEnd - 1);
        }

        leadingFragment = Buffer.from(combined.subarray(0, lineEnd));
        position = start;
      }

      return parseCodexTaskCompleteTitle(leadingFragment.toString('utf8'));
    } catch {
      return undefined;
    } finally {
      await handle.close();
    }
  }
}
