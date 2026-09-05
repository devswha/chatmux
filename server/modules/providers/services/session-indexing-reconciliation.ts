import { opendir } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build']);

type Options = {
  roots: readonly string[];
  signal: AbortSignal;
  isTarget: (filePath: string) => boolean;
  index: (filePath: string) => Promise<void>;
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
  async function* visit(directory: string): AsyncGenerator<void> {
    signal.throwIfAborted();
    try {
      const handle = await opendir(directory, { bufferSize: 16 });
      for await (const entry of handle) {
        signal.throwIfAborted();
        if (++entriesSeen % 32 === 0) {
          await yieldToEventLoop(undefined, { signal });
          yield;
        }
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
          yield* visit(filePath);
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
