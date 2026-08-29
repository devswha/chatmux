import { open, stat } from 'node:fs/promises';

import { transcriptChangeVersion } from '../transcript-change.service.js';

import type { ActivityReadDiagnostics, GjcSessionPreferences, TurnActivityState } from './transcript-parsing.js';
import type { LiveGjcSession } from './process-parsing.js';
import { ACTIVITY_BOUNDARY_DIGEST_BYTES, ACTIVITY_MAX_SCAN_BYTES, activityCache, parseLastSessionPreferences } from './transcript-parsing.js';
import { digestRange, scanTurnActivityBackwards, setActivityCache } from './activity-scanner.js';

/** Latest turn activity from the transcript. null on any read/parse failure. */
export async function readTurnActivityFromFile(
  path: string,
  diagnostics?: ActivityReadDiagnostics,
): Promise<TurnActivityState> {
  if (diagnostics) diagnostics.bytesRead = 0;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    const identity = await handle.stat();
    const cached = activityCache.get(path);
    const boundaryBuffer = Buffer.allocUnsafe(ACTIVITY_BOUNDARY_DIGEST_BYTES);
    const identityMatches = cached !== undefined && cached.dev === identity.dev && cached.ino === identity.ino;
    const canValidate = identityMatches
      && identity.size >= cached.size
      && cached.boundaryEnd <= cached.size
      && cached.boundaryStart >= 0
      && cached.decisiveStart !== null
      && cached.decisiveEnd !== null;
    if (canValidate) {
      const decisiveDigest = await digestRange(
        handle,
        cached.decisiveStart!,
        cached.decisiveEnd!,
        boundaryBuffer,
        diagnostics,
      );
      const boundaryDigest = await digestRange(
        handle,
        cached.boundaryStart,
        cached.boundaryEnd,
        boundaryBuffer,
        diagnostics,
      );
      if (decisiveDigest === cached.decisiveDigest && boundaryDigest === cached.boundaryDigest) {
        if (identity.size === cached.size) {
          setActivityCache(path, cached);
          return cached.activity;
        }
        const scanStart = cached.scannedTo;
        const scanned = await scanTurnActivityBackwards(handle, scanStart, identity.size, diagnostics);
        // A bounded suffix scan cannot prove the previous verdict remained current
        // when an unscanned portion of this append sits before it.
        if (
          scanned.activity === null
          && (scanned.coveredStart !== scanStart || scanned.coveredEnd !== identity.size)
        ) {
          activityCache.delete(path);
          return null;
        }
        const activity = scanned.activity ?? cached.activity;
        setActivityCache(path, {
          dev: identity.dev, ino: identity.ino, size: identity.size,
          scannedTo: scanned.boundaryEnd, activity,
          decisiveStart: scanned.decisiveStart ?? cached.decisiveStart,
          decisiveEnd: scanned.decisiveEnd ?? cached.decisiveEnd,
          decisiveDigest: scanned.decisiveDigest ?? cached.decisiveDigest,
          boundaryStart: scanned.boundaryStart,
          boundaryEnd: scanned.boundaryEnd,
          boundaryDigest: scanned.boundaryDigest,
        });
        return activity;
      }
    }
    activityCache.delete(path);

    const scanStart = Math.max(0, identity.size - ACTIVITY_MAX_SCAN_BYTES);
    const scanned = await scanTurnActivityBackwards(handle, scanStart, identity.size, diagnostics);
    setActivityCache(path, {
      dev: identity.dev, ino: identity.ino, size: identity.size,
      scannedTo: scanned.boundaryEnd,
      activity: scanned.activity,
      decisiveStart: scanned.decisiveStart,
      decisiveEnd: scanned.decisiveEnd,
      decisiveDigest: scanned.decisiveDigest,
      boundaryStart: scanned.boundaryStart,
      boundaryEnd: scanned.boundaryEnd,
      boundaryDigest: scanned.boundaryDigest,
    });
    return scanned.activity;
  } catch {
    activityCache.delete(path);
    return null;
  } finally {
    await handle?.close();
  }
}

export const MODEL_SCAN_WINDOW_BYTES = 512 * 1024;

export const MODEL_SCAN_OVERLAP_BYTES = 2 * 1024;

/**
 * Per-transcript incremental preference cache. Model and reasoning effort
 * changes can sit near the start of a huge append-only transcript, so cold
 * reads scan backwards and later polls inspect only the appended delta.
 */
export const modelCache = new Map<string, {
  scannedTo: number;
  model: string | null;
  effort: string | null;
}>();

export const LIVE_ENRICHMENT_CACHE_MS = 30_000;

export const LIVE_ENRICHMENT_CACHE_MAX_ENTRIES = 256;

export const liveEnrichmentCache = new Map<string, {
  path: string;
  version: string;
  expiresAtMs: number;
  value: {
    model: string | null;
    effort: string | null;
    running: boolean | null;
    error: boolean | null;
  };
}>();

export async function readLiveTranscriptEnrichment(
  sessionId: string,
  path: string,
): Promise<{
  model: string | null;
  effort: string | null;
  running: boolean | null;
  error: boolean | null;
}> {
  const version = transcriptChangeVersion('gjc', sessionId);
  const now = Date.now();
  const cached = liveEnrichmentCache.get(sessionId);
  if (
    cached
    && cached.path === path
    && cached.version === version
    && cached.expiresAtMs > now
  ) {
    liveEnrichmentCache.delete(sessionId);
    liveEnrichmentCache.set(sessionId, cached);
    return cached.value;
  }
  const preferences = await readLastSessionPreferencesFromFile(path);
  const activity = await readTurnActivityFromFile(path);
  const value = {
    model: preferences.model,
    effort: preferences.effort,
    running: activity === null ? null : activity === 'running',
    error: activity === null ? null : activity === 'error',
  };
  liveEnrichmentCache.delete(sessionId);
  liveEnrichmentCache.set(sessionId, {
    path,
    version,
    expiresAtMs: now + LIVE_ENRICHMENT_CACHE_MS,
    value,
  });
  if (liveEnrichmentCache.size > LIVE_ENRICHMENT_CACHE_MAX_ENTRIES) {
    liveEnrichmentCache.delete(liveEnrichmentCache.keys().next().value!);
  }
  return value;
}

export async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Reads the session's current model from the transcript. null on any failure. */
export async function readLastSessionPreferencesFromFile(
  path: string,
): Promise<GjcSessionPreferences> {
  try {
    const { size } = await stat(path);
    const cached = modelCache.get(path);
    if (cached && size >= cached.scannedTo) {
      if (size === cached.scannedTo) {
        return { model: cached.model, effort: cached.effort };
      }
      // Only the appended delta. Parse up to the last COMPLETE line so a
      // mid-write entry is re-read next poll instead of being lost.
      const delta = await readRange(path, cached.scannedTo, size);
      const lastNewline = delta.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        return { model: cached.model, effort: cached.effort };
      }
      const found = parseLastSessionPreferences(
        delta.subarray(0, lastNewline + 1).toString('utf8'),
      );
      const next = {
        scannedTo: cached.scannedTo + lastNewline + 1,
        model: found.model ?? cached.model,
        effort: found.effort ?? cached.effort,
      };
      modelCache.set(path, next);
      return { model: next.model, effort: next.effort };
    }

    // Cold scan: parse only up to the last COMPLETE line, and remember that
    // boundary so a preference entry being written mid-scan is retried.
    let parseEnd = size;
    if (size > 0) {
      const tail = await readRange(path, Math.max(0, size - MODEL_SCAN_WINDOW_BYTES), size);
      const lastNewline = tail.lastIndexOf(0x0a);
      parseEnd = lastNewline < 0 ? 0 : Math.max(0, size - tail.length) + lastNewline + 1;
    }
    let model: string | null = null;
    let effort: string | null = null;
    let end = parseEnd;
    while (end > 0 && (!model || !effort)) {
      const start = Math.max(0, end - MODEL_SCAN_WINDOW_BYTES);
      const found = parseLastSessionPreferences(
        (await readRange(path, start, end)).toString('utf8'),
      );
      model ??= found.model;
      effort ??= found.effort;
      end = start === 0 ? 0 : start + MODEL_SCAN_OVERLAP_BYTES;
    }
    modelCache.set(path, { scannedTo: parseEnd, model, effort });
    return { model, effort };
  } catch {
    return { model: null, effort: null };
  }
}

/**
 * Returns live gjc sessions with their tmux session name + generation id.
 * Empty when tmux is absent. A ps failure marks the lane unavailable because
 * process lineage is required before any pane may be bound or controlled.
 *
 * Concurrent callers share one in-flight scan (single-flight): several browser
 * clients share one tmux/ps/receipt pass.
 */
export type LiveGjcSessionsDetailedResult = {
  /** False when tmux or the process roster is unavailable. */
  ok: boolean;
  sessions: LiveGjcSession[];
  /** session id → open transcript path (server-internal; NOT for API responses). */
  transcriptPaths: Map<string, string>;
};
