import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { open, readFile, stat, access, readdir } from 'node:fs/promises';

import type { ProviderConnectionIssue } from '../../../../../shared/provider-connection.js';
import { processStartMs } from '../process-start-time.service.js';
import { recordHostCommand } from '../host-command-metrics.service.js';

import { GJC_CMDLINE_MAX_BYTES, RECEIPT_ATTEMPT_LIMIT, RUNTIME_RECEIPT_FALLBACK_LIMIT, parseTerminalSessionReceipt, resolveInteractiveSessionTranscript, safeRealpath } from './session-correlation.js';
import type { RuntimeReceipt } from './session-correlation.js';
import { readAt } from './activity-scanner.js';

export const RUNTIME_RECEIPT_DIR_LIMIT = RECEIPT_ATTEMPT_LIMIT;

export const RUNTIME_RECEIPT_DIR_RE = /^_session-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const RUNTIME_RECEIPT_READ_CONCURRENCY = 1;

/**
 * Canonical UUIDv7 session directory names sort chronologically after case
 * normalization. Validate before spending the bounded scan budget; slicing raw
 * readdir order retained old sessions and excluded the current one.
 */
export function selectRuntimeReceiptDirectories(
  entries: readonly string[],
  limit = RUNTIME_RECEIPT_DIR_LIMIT,
  excludedEntries: ReadonlySet<string> = new Set(),
): string[] {
  const excluded = new Set([...excludedEntries].map((entry) => entry.toLowerCase()));
  return entries
    .filter((entry) => RUNTIME_RECEIPT_DIR_RE.test(entry) && !excluded.has(entry.toLowerCase()))
    .sort((left, right) => {
      const normalizedLeft = left.toLowerCase();
      const normalizedRight = right.toLowerCase();
      return normalizedLeft < normalizedRight ? 1 : normalizedLeft > normalizedRight ? -1 : 0;
    })
    .slice(0, limit);
}

export function resumeSessionIdFromCmdline(cmdline: Buffer): string | null {
  const argv = cmdline.toString('utf8').split('\0');
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const candidate = value === '--resume' ? argv[index + 1] : value.startsWith('--resume=') ? value.slice(9) : null;
    if (candidate && RUNTIME_RECEIPT_DIR_RE.test(`_session-${candidate}`)) return candidate.toLowerCase();
  }
  return null;
}

export type RuntimeReceiptAttempt = {
  receipt: RuntimeReceipt | null;
  attempts: 0 | 1;
  attemptedEntry: string | null;
  issue?: ProviderConnectionIssue;
};

export function permissionIssue(error: unknown): ProviderConnectionIssue | undefined {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : null;
  return code === 'EACCES' || code === 'EPERM'
    ? 'transcript_permission_denied'
    : undefined;
}

export function runtimeReceiptFallbackBudget(consumedAttempts: number): number {
  return Math.min(
    RUNTIME_RECEIPT_FALLBACK_LIMIT,
    Math.max(0, RECEIPT_ATTEMPT_LIMIT - Math.max(0, consumedAttempts)),
  );
}

export async function readExactResumeReceipt(
  paneCwd: string,
  agentPid: number,
  agentStartMs: number,
): Promise<RuntimeReceiptAttempt> {
  let attemptedEntry: string | null = null;
  try {
    recordHostCommand('read', ['proc']);
    const cmdlineHandle = await open(`/proc/${agentPid}/cmdline`, 'r');
    let sessionId: string | null = null;
    try {
      const argv = Buffer.allocUnsafe(GJC_CMDLINE_MAX_BYTES);
      const bytesRead = await readAt(cmdlineHandle, argv, 0);
      sessionId = resumeSessionIdFromCmdline(argv.subarray(0, bytesRead));
    } finally {
      await cmdlineHandle.close();
    }
    if (!sessionId) return { receipt: null, attempts: 0, attemptedEntry: null };
    attemptedEntry = `_session-${sessionId}`;
    const receiptPath = join(paneCwd, '.gjc', attemptedEntry, 'runtime', 'runtime-state.json');
    recordHostCommand('read', ['runtime-receipt']);
    const [content, meta] = await Promise.all([readFile(receiptPath, 'utf8'), stat(receiptPath)]);
    const parsed = JSON.parse(content) as { session_id?: unknown; cwd?: unknown; session_file?: unknown };
    if (parsed.session_id !== sessionId || typeof parsed.session_file !== 'string' || meta.mtimeMs < agentStartMs) {
      return { receipt: null, attempts: 1, attemptedEntry };
    }
    const transcript = resolveInteractiveSessionTranscript(parsed.session_file);
    if (!transcript?.sessionFile || transcript.sessionId.toLowerCase() !== sessionId) {
      return { receipt: null, attempts: 1, attemptedEntry };
    }
    await access(transcript.sessionFile, fsConstants.R_OK);
    const receiptCwd = typeof parsed.cwd === 'string' ? ((await safeRealpath(parsed.cwd)) ?? parsed.cwd) : null;
    if (
      (receiptCwd !== null && receiptCwd !== paneCwd)
      || (await processStartMs(agentPid)) !== agentStartMs
    ) {
      return { receipt: null, attempts: 1, attemptedEntry };
    }
    return {
      receipt: {
        sessionId: transcript.sessionId,
        sessionFile: transcript.sessionFile,
        cwd: receiptCwd,
        mtimeMs: meta.mtimeMs,
      },
      attempts: 1,
      attemptedEntry,
    };
  } catch (error) {
    return {
      receipt: null,
      attempts: attemptedEntry === null ? 0 : 1,
      attemptedEntry,
      issue: permissionIssue(error),
    };
  }
}

/** Reads all parseable session receipts under `<paneCwd>/.gjc` (missing dir → []). */
export async function readPaneRuntimeReceipts(
  paneCwd: string,
  limit: number,
  excludedEntries: ReadonlySet<string>,
): Promise<RuntimeReceipt[]> {
  let entries: string[];
  try {
    entries = await readdir(`${paneCwd}/.gjc`);
  } catch {
    return [];
  }
  const candidates = selectRuntimeReceiptDirectories(entries, limit, excludedEntries);
  const receipts: RuntimeReceipt[] = [];
  for (let offset = 0; offset < candidates.length; offset += RUNTIME_RECEIPT_READ_CONCURRENCY) {
    const batch = await Promise.all(
      candidates
        .slice(offset, offset + RUNTIME_RECEIPT_READ_CONCURRENCY)
        .map(async (entry): Promise<RuntimeReceipt | null> => {
          const statePath = `${paneCwd}/.gjc/${entry}/runtime/runtime-state.json`;
          try {
            recordHostCommand('read', ['runtime-receipt']);
            const [content, meta] = await Promise.all([readFile(statePath, 'utf8'), stat(statePath)]);
            const parsed = JSON.parse(content) as { session_id?: unknown; cwd?: unknown; session_file?: unknown };
            const receiptFile = typeof parsed.session_file === 'string' ? parsed.session_file : null;
            const transcript = receiptFile ? resolveInteractiveSessionTranscript(receiptFile) : null;
            const sessionFile = transcript?.sessionFile ?? receiptFile;
            if (sessionFile !== null) {
              await stat(sessionFile); // the transcript must exist — throws (→ skip) otherwise
            }
            return {
              sessionId: transcript?.sessionId ?? (
                typeof parsed.session_id === 'string' ? parsed.session_id : ''
              ),
              cwd: typeof parsed.cwd === 'string' ? ((await safeRealpath(parsed.cwd)) ?? parsed.cwd) : null,
              sessionFile,
              mtimeMs: meta.mtimeMs,
            };
          } catch {
            return null;
          }
        }),
    );
    receipts.push(...batch.filter((receipt): receipt is RuntimeReceipt => receipt !== null));
  }
  return receipts;
}

/** Reads gjc 0.11+'s pane-specific `terminal-sessions/tmux-%N` receipt. */
export async function readPaneTerminalReceipt(paneId: string): Promise<RuntimeReceiptAttempt> {
  let attempted = false;
  try {
    if (!/^%\d+$/.test(paneId)) {
      return { receipt: null, attempts: 0, attemptedEntry: null };
    }
    const receiptPath = join(homedir(), '.gjc', 'agent', 'terminal-sessions', `tmux-${paneId}`);
    attempted = true;
    recordHostCommand('read', ['runtime-receipt']);
    const [content, meta] = await Promise.all([readFile(receiptPath, 'utf8'), stat(receiptPath)]);
    const receipt = parseTerminalSessionReceipt(content, meta.mtimeMs);
    if (!receipt?.sessionFile) {
      return { receipt: null, attempts: 1, attemptedEntry: null };
    }
    await access(receipt.sessionFile, fsConstants.R_OK);
    return {
      receipt: {
        ...receipt,
        cwd: receipt.cwd ? ((await safeRealpath(receipt.cwd)) ?? receipt.cwd) : null,
      },
      attempts: 1,
      attemptedEntry: null,
    };
  } catch (error) {
    return {
      receipt: null,
      attempts: attempted ? 1 : 0,
      attemptedEntry: null,
      issue: permissionIssue(error),
    };
  }
}

export const GJC_RUNTIME_DESCRIPTOR_LIMIT = 2_048;
