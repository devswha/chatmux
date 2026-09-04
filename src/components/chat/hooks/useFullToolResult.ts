import { useEffect, useMemo, useRef, useState } from 'react';

import { FLEET_TOOL_RESULT_CHUNK_BYTES, type FleetToolResultChunk } from '../../../../shared/fleet';
import { useFleetHost } from '../../../fleet/FleetSessionRoute';
import { hostToolResultUrl, isLocalHostScope } from '../../../fleet/hostApi/urls';
import { authenticatedFetch } from '../../../utils/api';
import type { ToolResult } from '../types/types';

function chunk(value: unknown, toolId: string, offset: number, revision: string | null, total: number | null): FleetToolResultChunk {
  if (!value || typeof value !== 'object') throw new Error('Invalid tool output chunk');
  const data = value as FleetToolResultChunk;
  if (data.toolId !== toolId || data.offset !== offset || typeof data.content !== 'string'
    || typeof data.isError !== 'boolean' || typeof data.revision !== 'string' || !/^[0-9a-f]{64}$/.test(data.revision)
    || (revision !== null && data.revision !== revision) || !Number.isSafeInteger(data.totalBytes) || data.totalBytes < offset
    || (total !== null && data.totalBytes !== total)) throw new Error('Tool output target or revision changed');
  const bytes = new TextEncoder().encode(data.content).length;
  const end = offset + bytes;
  if (bytes > FLEET_TOOL_RESULT_CHUNK_BYTES || end > data.totalBytes
    || (data.nextOffset === null ? end !== data.totalBytes : data.nextOffset !== end || end <= offset || end >= data.totalBytes)) {
    throw new Error('Invalid tool output continuation');
  }
  return data;
}

/** A full result belongs to the captured host/session/tool, including late responses. */
export function useFullToolResult(sessionId: string | undefined, toolId: string | undefined) {
  const { storeScope } = useFleetHost();
  const { hostId, localHostId } = storeScope;
  const target = useMemo(() => ({ hostId, localHostId, sessionId, toolId }), [hostId, localHostId, sessionId, toolId]);
  const pending = useRef<{ target: typeof target; controller: AbortController } | null>(null);
  const [state, setState] = useState<{ target: typeof target; result: ToolResult | null; loading: boolean; error: boolean } | null>(null);
  useEffect(() => () => {
    if (pending.current?.target === target) {
      pending.current.controller.abort();
      pending.current = null;
    }
  }, [target]);

  const loadFullToolResult = async () => {
    if (!sessionId || !toolId || pending.current?.target === target) return;
    pending.current?.controller.abort();
    const operation = { target, controller: new AbortController() };
    pending.current = operation;
    setState({ target, result: null, loading: true, error: false });
    try {
      const local = isLocalHostScope(target);
      const parts: string[] = [];
      let offset = 0;
      let revision: string | null = null;
      let total: number | null = null;
      let result: ToolResult;
      while (true) {
        const params = new URLSearchParams({ toolId });
        if (!local) {
          params.set('offset', String(offset));
          if (revision !== null) params.set('revision', revision);
        }
        const response = await authenticatedFetch(hostToolResultUrl(target, sessionId, params.toString()), { signal: operation.controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        operation.controller.signal.throwIfAborted();
        if (pending.current !== operation) return;
        const data = body?.data ?? body;
        if (local) {
          if (data?.toolId !== toolId || !data.toolResult || typeof data.toolResult !== 'object') throw new Error('Missing tool result');
          const content = typeof data.toolResult.content === 'string' ? data.toolResult.content : JSON.stringify(data.toolResult.content ?? '', null, 2);
          result = { ...data.toolResult, content };
          break;
        }
        const part = chunk(data, toolId, offset, revision, total);
        revision = part.revision;
        total = part.totalBytes;
        parts.push(part.content);
        if (part.nextOffset === null) {
          result = { content: parts.join(''), isError: part.isError };
          break;
        }
        offset = part.nextOffset;
      }
      setState({ target, result, loading: false, error: false });
    } catch {
      if (!operation.controller.signal.aborted && pending.current === operation) setState({ target, result: null, loading: false, error: true });
    } finally {
      if (pending.current === operation) pending.current = null;
    }
  };
  const current = state?.target === target ? state : null;
  return { fullToolResult: current?.result ?? null, isLoadingFullToolResult: current?.loading ?? false,
    fullToolResultError: current?.error ?? false, loadFullToolResult };
}
