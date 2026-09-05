import { opendir } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import type { LLMProvider } from '@/shared/types.js';

// Before bounded admission, only these periodic lanes had an implemented
// reconcile() method. GJC was event/restart-driven; the non-pi methods are absent.
export const PERIODIC_SESSION_INDEX_PROVIDERS: readonly LLMProvider[] = ['omp', 'omo'];

export async function* reconcilePeriodicSessionIndex(options: {
  provider: LLMProvider;
  signal: AbortSignal;
  reconcile: (provider: LLMProvider, signal: AbortSignal) => Promise<{ sessionIds: string[] }>;
  onIndexed: (provider: LLMProvider, sessionId: string) => void;
}): AsyncGenerator<void> {
  const { provider, signal } = options;
  signal.throwIfAborted();
  if (!PERIODIC_SESSION_INDEX_PROVIDERS.includes(provider)) return;
  // Keep the provider's shared-cursor and pending-file rules. No full walk or
  // single-file fallback on this path, even when incremental reconciliation fails.
  const result = await options.reconcile(provider, signal);
  for (const sessionId of result.sessionIds) {
    signal.throwIfAborted();
    options.onIndexed(provider, sessionId);
    yield;
  }
}

/** Transcript-only scan scope; receipt watchers remain owned by discovery. */
export function sessionIndexScanScope(provider: LLMProvider, roots: readonly string[], receiptRoot: string) {
  return {
    roots: provider === 'gjc' ? roots.filter((root) => path.resolve(root) !== path.resolve(receiptRoot)) : roots,
    // Pi's existing provider guard rejects files deeper than root/project/file.
    maxDirectoryDepth: provider === 'gjc' || provider === 'omp' || provider === 'omo' ? 1 : undefined,
  };
}

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build']);

type Options = {
  roots: readonly string[];
  signal: AbortSignal;
  isTarget: (filePath: string) => boolean;
  index: (filePath: string) => Promise<void>;
  maxDirectoryDepth?: number;
  openDirectory?: typeof opendir;
};

/**
 * Recover watcher gaps without a timestamp cursor or an in-memory file list.
 * Directory iteration retains a small dirent buffer per depth; file indexing
 * is serial and yields even when a provider's implementation is synchronous.
 */
export async function* reconcileSessionIndexFiles(options: Options): AsyncGenerator<void> {
  const { signal } = options;
  let failed = false;
  let entriesSeen = 0;
  async function* visit(directory: string, depth = 0): AsyncGenerator<void> {
    signal.throwIfAborted();
    try {
      const handle = await (options.openDirectory ?? opendir)(directory, { bufferSize: 16 });
      for await (const entry of handle) {
        signal.throwIfAborted();
        if (++entriesSeen % 32 === 0) {
          await yieldToEventLoop(undefined, { signal });
          yield;
        }
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
          if (depth < (options.maxDirectoryDepth ?? Infinity)) yield* visit(filePath, depth + 1);
        } else if (entry.isFile() && options.isTarget(filePath)) {
          try {
            await options.index(filePath);
          } catch {
            signal.throwIfAborted();
            failed = true;
          }
          await yieldToEventLoop(undefined, { signal });
          yield;
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      // Missing roots/entries are normal while providers create or rotate
      // files. Permission and I/O failures keep the recovery obligation alive.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true;
    }
  }
  for (const root of new Set(options.roots)) yield* visit(root);
  signal.throwIfAborted();
  if (failed) throw new Error('Session indexing reconciliation incomplete.');
}
