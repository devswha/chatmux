import { createHash } from 'node:crypto';

import { FLEET_TOOL_RESULT_CHUNK_BYTES, type FleetToolResultChunk } from '../../../../../shared/fleet.js';

import { FleetReadRpcError } from './errors.js';

const CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_ENTRIES = 64;
const CACHE_TTL_MS = 60_000;
type Options = Readonly<{ toolId: string; offset: number; revision: string | null }>;
type Snapshot = Readonly<{ sessionId: string; identity: string; toolId: string; content: Buffer; revision: string; isError: boolean; expiresAt: number }>;
type Dependencies = Readonly<{
  identity: (sessionId: string) => string | null;
  read: (sessionId: string, toolId: string) => Promise<{ toolResult: { content?: unknown; isError?: boolean } }>;
  now?: () => number;
}>;

/** Private bounded cache of read snapshots; every hit still validates its target. */
export function createToolResultReader(dependencies: Dependencies) {
  const cache = new Map<string, Snapshot>();
  let bytes = 0;
  const now = dependencies.now ?? Date.now;
  const remove = (key: string): void => {
    bytes -= cache.get(key)?.content.length ?? 0;
    cache.delete(key);
  };
  return async (sessionId: string, options: Options, signal: AbortSignal): Promise<FleetToolResultChunk> => {
    signal.throwIfAborted();
    const identity = dependencies.identity(sessionId);
    if (identity === null) throw new FleetReadRpcError('HOST_NOT_FOUND', 'local session was not found');
    for (const [key, value] of cache) if (value.expiresAt <= now()) remove(key);
    let snapshot = options.revision === null ? undefined : cache.get(options.revision);
    if (snapshot && (snapshot.sessionId !== sessionId || snapshot.identity !== identity || snapshot.toolId !== options.toolId)) {
      throw new FleetReadRpcError('FLEET_MALFORMED_FRAME', 'tool snapshot target does not match');
    }
    if (!snapshot) {
      let result: Awaited<ReturnType<Dependencies['read']>>;
      try { result = await dependencies.read(sessionId, options.toolId); }
      catch (error) {
        if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404) throw new FleetReadRpcError('HOST_NOT_FOUND', 'local tool result was not found');
        throw error;
      }
      signal.throwIfAborted();
      if (dependencies.identity(sessionId) !== identity) throw new FleetReadRpcError('FLEET_MALFORMED_FRAME', 'tool snapshot session changed');
      const text = typeof result.toolResult.content === 'string'
        ? result.toolResult.content : JSON.stringify(result.toolResult.content ?? '', null, 2);
      const content = Buffer.from(text);
      const isError = result.toolResult.isError === true;
      const revision = createHash('sha256').update(JSON.stringify([sessionId, identity, options.toolId, isError])).update(content).digest('hex');
      if (options.revision !== null && options.revision !== revision) {
        throw new FleetReadRpcError('FLEET_MALFORMED_FRAME', 'tool output revision changed');
      }
      snapshot = { sessionId, identity, toolId: options.toolId, content, revision, isError, expiresAt: now() + CACHE_TTL_MS };
      if (content.length <= CACHE_BYTES) {
        remove(revision);
        while (cache.size && (bytes + content.length > CACHE_BYTES || cache.size >= CACHE_ENTRIES)) remove(cache.keys().next().value!);
        cache.set(revision, snapshot);
        bytes += content.length;
      }
    }
    const { content, revision, isError } = snapshot;
    if (!Number.isSafeInteger(options.offset) || options.offset < 0 || options.offset > content.length
      || (options.offset < content.length && (content[options.offset]! & 0xc0) === 0x80)) {
      throw new FleetReadRpcError('FLEET_MALFORMED_FRAME', 'tool output byte offset is invalid');
    }
    let end = Math.min(content.length, options.offset + FLEET_TOOL_RESULT_CHUNK_BYTES);
    while (end < content.length && (content[end]! & 0xc0) === 0x80) end -= 1;
    return { toolId: options.toolId, revision, isError, content: content.subarray(options.offset, end).toString('utf8'),
      offset: options.offset, nextOffset: end === content.length ? null : end, totalBytes: content.length };
  };
}
