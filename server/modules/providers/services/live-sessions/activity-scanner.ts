import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

import type { ActivityCacheEntry, ActivityReadDiagnostics, ActivityScanResult } from './transcript-parsing.js';
import { ACTIVITY_BOUNDARY_DIGEST_BYTES, ACTIVITY_CACHE_MAX_ENTRIES, ACTIVITY_MAX_RECORD_BYTES, ACTIVITY_MAX_SCAN_BYTES, ACTIVITY_SCAN_CHUNK_BYTES, EMPTY_ACTIVITY_DIGEST, activityCache, digest, parseTurnActivityRecord } from './transcript-parsing.js';

export async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  position: number,
  diagnostics?: ActivityReadDiagnostics,
): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    if (diagnostics) diagnostics.bytesRead += bytesRead;
  }
  return offset;
}

export async function digestRange(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  end: number,
  buffer: Buffer,
  diagnostics?: ActivityReadDiagnostics,
): Promise<string | null> {
  if (start < 0 || end < start || buffer.length === 0) return null;
  const hash = createHash('sha256');
  let cursor = start;
  while (cursor < end) {
    const length = Math.min(buffer.length, end - cursor);
    const bytesRead = await readAt(handle, buffer.subarray(0, length), cursor, diagnostics);
    if (bytesRead !== length) return null;
    hash.update(buffer.subarray(0, length));
    cursor += length;
  }
  return hash.digest('hex');
}

/**
 * Scans one bounded range with a single handle and three fixed buffers. Records
 * larger than the scratch space are ignored through their terminating newline.
 */
export async function scanTurnActivityBackwards(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  end: number,
  diagnostics?: ActivityReadDiagnostics,
): Promise<ActivityScanResult> {
  const chunk = Buffer.allocUnsafe(ACTIVITY_SCAN_CHUNK_BYTES);
  const scratch = Buffer.allocUnsafe(ACTIVITY_MAX_RECORD_BYTES);
  let cursor = end;
  let completeEnd = start;
  let boundaryStart = start;
  let boundaryEnd = start;
  let boundaryDigest = EMPTY_ACTIVITY_DIGEST;
  let recordLength = 0;
  let discardRecord = false;
  let bytesRead = 0;
  let oversizeRecords = 0;
  let foundEnd = false;
  let coveredStart = end;

  const resetRecord = () => {
    recordLength = 0;
    discardRecord = false;
  };
  const appendSegment = (segment: Buffer) => {
    if (discardRecord || segment.length === 0) return;
    if (recordLength + segment.length > scratch.length) {
      discardRecord = true;
      oversizeRecords += 1;
      return;
    }
    segment.copy(scratch, scratch.length - recordLength - segment.length);
    recordLength += segment.length;
  };

  while (cursor > start && bytesRead < ACTIVITY_MAX_SCAN_BYTES) {
    const chunkStart = Math.max(start, cursor - Math.min(chunk.length, ACTIVITY_MAX_SCAN_BYTES - bytesRead));
    const length = cursor - chunkStart;
    const received = await readAt(handle, chunk.subarray(0, length), chunkStart, diagnostics);
    bytesRead += received;
    if (received !== length) break;
    coveredStart = chunkStart;

    let segmentEnd = length;
    for (let index = length - 1; index >= 0; index -= 1) {
      if (chunk[index] !== 0x0a) continue;
      const newlineEnd = chunkStart + index + 1;
      if (!foundEnd) {
        foundEnd = true;
        completeEnd = newlineEnd;
        boundaryStart = Math.max(start, newlineEnd - ACTIVITY_BOUNDARY_DIGEST_BYTES);
        boundaryEnd = newlineEnd;
        boundaryDigest = digest(chunk.subarray(boundaryStart - chunkStart, index + 1));
        segmentEnd = index;
        resetRecord();
        continue;
      }
      appendSegment(chunk.subarray(index + 1, segmentEnd));
      const recordStart = newlineEnd;
      const recordEnd = recordStart + recordLength;
      if (!discardRecord && recordLength > 0) {
        const record = scratch.subarray(scratch.length - recordLength);
        const activity = parseTurnActivityRecord(record.toString('utf8').replace(/\r$/, ''));
        if (activity !== null) {
          return {
            activity,
            completeEnd,
            decisiveStart: recordStart,
            decisiveEnd: recordEnd,
            decisiveDigest: digest(record),
            boundaryStart,
            boundaryEnd,
            boundaryDigest,
            coveredStart,
            coveredEnd: end,
            bytesRead,
            retainedInputBytes: chunk.length + scratch.length + ACTIVITY_BOUNDARY_DIGEST_BYTES,
            oversizeRecords,
          };
        }
      }
      resetRecord();
      segmentEnd = index;
    }
    if (foundEnd) appendSegment(chunk.subarray(0, segmentEnd));
    cursor = chunkStart;
  }

  if (foundEnd && cursor === start) {
    const recordStart = start;
    const recordEnd = recordStart + recordLength;
    if (!discardRecord && recordLength > 0) {
      const record = scratch.subarray(scratch.length - recordLength);
      const activity = parseTurnActivityRecord(record.toString('utf8').replace(/\r$/, ''));
      if (activity !== null) {
        return {
          activity,
          completeEnd,
          decisiveStart: recordStart,
          decisiveEnd: recordEnd,
          decisiveDigest: digest(record),
          boundaryStart,
          boundaryEnd,
          boundaryDigest,
          coveredStart,
          coveredEnd: end,
          bytesRead,
          retainedInputBytes: chunk.length + scratch.length + ACTIVITY_BOUNDARY_DIGEST_BYTES,
          oversizeRecords,
        };
      }
    }
  }
  return {
    activity: null,
    completeEnd,
    decisiveStart: null,
    decisiveEnd: null,
    decisiveDigest: null,
    boundaryStart,
    boundaryEnd,
    boundaryDigest,
    coveredStart,
    coveredEnd: end,
    bytesRead,
    retainedInputBytes: chunk.length + scratch.length + ACTIVITY_BOUNDARY_DIGEST_BYTES,
    oversizeRecords,
  };
}

export function setActivityCache(path: string, entry: ActivityCacheEntry): void {
  activityCache.delete(path);
  activityCache.set(path, entry);
  if (activityCache.size > ACTIVITY_CACHE_MAX_ENTRIES) {
    activityCache.delete(activityCache.keys().next().value!);
  }
}

export function getActivityCacheDiagnostics(path?: string): {
  entries: number;
  containsPath?: boolean;
} {
  return {
    entries: activityCache.size,
    ...(path === undefined ? {} : { containsPath: activityCache.has(path) }),
  };
}
