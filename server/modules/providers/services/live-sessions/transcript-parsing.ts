import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';

import { recordHostCommand } from '../host-command-metrics.service.js';

import type { RuntimeReceipt } from './session-correlation.js';
import type { RuntimeReceiptAttempt } from './runtime-receipts.js';
import { GJC_RUNTIME_DESCRIPTOR_LIMIT, permissionIssue } from './runtime-receipts.js';
import { SESSIONS_SEGMENT, SESSION_FILE_RE } from './process-parsing.js';
import { resolveInteractiveSessionTranscript } from './session-correlation.js';

/**
 * Compatibility fallback for GJC versions without pane receipts. It examines
 * only the proven GJC process's descriptors, never the full session tree.
 */
export async function readOpenGjcTranscript(agentPid: number): Promise<RuntimeReceiptAttempt> {
  let descriptors: string[];
  try {
    recordHostCommand('read', ['proc']);
    descriptors = await readdir(`/proc/${agentPid}/fd`);
  } catch (error) {
    return {
      receipt: null,
      attempts: 0,
      attemptedEntry: null,
      issue: permissionIssue(error),
    };
  }

  const transcripts = new Map<string, RuntimeReceipt>();
  let denied = false;
  await Promise.all(descriptors.slice(0, GJC_RUNTIME_DESCRIPTOR_LIMIT).map(async (descriptor) => {
    try {
      const path = await realpath(`/proc/${agentPid}/fd/${descriptor}`);
      const transcript = resolveInteractiveSessionTranscript(path);
      if (!transcript?.sessionFile) return;
      const metadata = await stat(transcript.sessionFile);
      const existing = transcripts.get(transcript.sessionId);
      if (!existing || metadata.mtimeMs > existing.mtimeMs) {
        transcripts.set(transcript.sessionId, {
          ...transcript,
          cwd: null,
          mtimeMs: metadata.mtimeMs,
        });
      }
    } catch (error) {
      denied ||= permissionIssue(error) !== undefined;
    }
  }));

  if (transcripts.size === 1) {
    return {
      receipt: transcripts.values().next().value ?? null,
      attempts: 0,
      attemptedEntry: null,
    };
  }
  return {
    receipt: null,
    attempts: 0,
    attemptedEntry: null,
    issue: transcripts.size > 1
      ? 'transcript_ambiguous'
      : denied ? 'transcript_permission_denied' : undefined,
  };
}

/** Maps session id → transcript path from lsof `n` lines (first path wins). */
export function extractSessionPathsFromLsof(output: string): Map<string, string> {
  const paths = new Map<string, string>();
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.startsWith('n') || !raw.includes(SESSIONS_SEGMENT)) {
      continue;
    }
    const match = SESSION_FILE_RE.exec(raw);
    if (match && !paths.has(match[1])) {
      paths.set(match[1], raw.slice(1));
    }
  }
  return paths;
}

export type GjcSessionPreferences = {
  model: string | null;
  effort: string | null;
};

/** Latest model and reasoning-effort changes in transcript text. */
export function parseLastSessionPreferences(tailText: string): GjcSessionPreferences {
  const lines = tailText.split(/\r?\n/);
  let model: string | null = null;
  let effort: string | null = null;
  for (let i = lines.length - 1; i >= 0 && (!model || !effort); i -= 1) {
    if (!lines[i].includes('"model_change"')
      && !lines[i].includes('"thinking_level_change"')
      && !lines[i].includes('"configured_model_chain"')
      && !lines[i].includes('"thinkingLevel"')) {
      continue;
    }
    try {
      const entry = JSON.parse(lines[i]) as {
        type?: unknown;
        model?: unknown;
        thinkingLevel?: unknown;
        entries?: unknown;
      };
      if (!model && entry.type === 'model_change' && typeof entry.model === 'string' && entry.model) {
        model = entry.model;
      }
      if (!effort
        && (entry.type === 'thinking_level_change' || entry.type === 'session')
        && typeof entry.thinkingLevel === 'string'
        && entry.thinkingLevel
        && entry.thinkingLevel !== 'inherit') {
        effort = entry.thinkingLevel;
      }
      if (!effort && entry.type === 'configured_model_chain' && Array.isArray(entry.entries)) {
        const configured = entry.entries.find((value): value is string => typeof value === 'string');
        const separator = configured?.lastIndexOf(':') ?? -1;
        if (configured && separator >= 0 && separator < configured.length - 1) {
          effort = configured.slice(separator + 1);
        }
      }
    } catch {
      // Partial boundary line or malformed entry — keep scanning.
    }
  }
  return { model, effort };
}

/** Last `model_change` model in transcript text. */
export function parseLastModelChange(tailText: string): string | null {
  return parseLastSessionPreferences(tailText).model;
}

/**
 * Latest transcript activity (measured GJC schema), scanned backwards so the
 * last turn-relevant record decides:
 * - assistant stopReason 'stop' → ready
 * - assistant stopReason 'error' or a raw provider error record → error
 * - assistant toolUse, user, or toolResult → running
 * Returns null when the input has no relevant complete record.
 */
export type TurnActivityState = 'running' | 'ready' | 'error' | null;

export function parseTurnActivityRecord(line: string): TurnActivityState {
  try {
    const record = JSON.parse(line) as {
      type?: unknown;
      message?: { role?: unknown; stopReason?: unknown };
    };
    if (record.type === 'error') {
      return 'error';
    }
    if (record.type !== 'message' || !record.message || typeof record.message !== 'object') {
      return null;
    }
    const { role, stopReason } = record.message;
    if (role === 'assistant') {
      if (stopReason === 'error') return 'error';
      return stopReason === 'stop' ? 'ready' : 'running';
    }
    if (role === 'user' || role === 'toolResult') {
      return 'running';
    }
  } catch {
    // Partial or malformed records are not turn-relevant.
  }
  return null;
}

export function parseTurnActivityState(tailText: string): TurnActivityState {
  const lines = tailText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const activity = parseTurnActivityRecord(lines[i]);
    if (activity !== null) return activity;
  }
  return null;
}

export function parseTurnActivity(tailText: string): boolean | null {
  const activity = parseTurnActivityState(tailText);
  return activity === null ? null : activity === 'running';
}

export const ACTIVITY_SCAN_CHUNK_BYTES = 64 * 1024;

export const ACTIVITY_MAX_SCAN_BYTES = 2 * 1024 * 1024;

export const ACTIVITY_MAX_RECORD_BYTES = 256 * 1024;

export const ACTIVITY_BOUNDARY_DIGEST_BYTES = 4 * 1024;

export const ACTIVITY_MAX_READ_BYTES_PER_ATTEMPT = 2_363_392;

export const ACTIVITY_MAX_RETAINED_INPUT_BYTES = 331_776;

export const TRANSCRIPT_ENRICHMENT_CONCURRENCY = 4;

export const ACTIVITY_CACHE_MAX_ENTRIES = 256;

export type ActivityReadDiagnostics = {
  bytesRead: number;
};

export let activeTranscriptEnrichments = 0;

export const queuedTranscriptEnrichments: Array<() => void> = [];

export async function mapTranscriptEnrichments<T, R>(
  values: readonly T[],
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  return Promise.all(values.map(async (value) => {
    if (activeTranscriptEnrichments >= TRANSCRIPT_ENRICHMENT_CONCURRENCY) {
      await new Promise<void>((resolve) => queuedTranscriptEnrichments.push(resolve));
    }
    activeTranscriptEnrichments += 1;
    try {
      return await map(value);
    } finally {
      activeTranscriptEnrichments -= 1;
      queuedTranscriptEnrichments.shift()?.();
    }
  }));
}

export type ActivityScanResult = {
  activity: TurnActivityState;
  completeEnd: number;
  decisiveStart: number | null;
  decisiveEnd: number | null;
  decisiveDigest: string | null;
  boundaryStart: number;
  boundaryEnd: number;
  boundaryDigest: string;
  /** Contiguous suffix of the requested range successfully read by this scan. */
  coveredStart: number;
  coveredEnd: number;
  bytesRead: number;
  retainedInputBytes: number;
  oversizeRecords: number;
};

export type ActivityCacheEntry = {
  dev: number;
  ino: number;
  size: number;
  scannedTo: number;
  activity: TurnActivityState;
  decisiveStart: number | null;
  decisiveEnd: number | null;
  decisiveDigest: string | null;
  boundaryStart: number;
  boundaryEnd: number;
  boundaryDigest: string;
};

export const activityCache = new Map<string, ActivityCacheEntry>();

export function digest(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export const EMPTY_ACTIVITY_DIGEST = createHash('sha256').digest('hex');
