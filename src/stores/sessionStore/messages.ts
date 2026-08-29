/**
 * Session-store message vocabulary: the normalized transcript row, the per-session
 * slot the store keeps, and the store-wide capacity constants. Split from the
 * former `useSessionStore.ts` — import from there (the facade), not here.
 */

import type { LLMProvider } from '../../types/app';

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification';

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Per-run monotonic sequence number assigned by the backend to live
   * websocket events. Used to compute `lastSeq` for `chat.subscribe` replay;
   * REST history messages do not carry it.
   */
  seq?: number;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Mirrors optional transcript metadata from the server.
   *
   * These fields are currently used by Claude history normalization so local
   * slash commands, local stdout, and compact summaries do not disappear when
   * the session store hydrates from REST history.
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  images?: Array<{ path?: string; data?: string; name?: string }>;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  toolResultTruncated?: boolean;
  toolResultBytes?: number;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  success?: boolean;
  aborted?: boolean;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentTools?: unknown[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  /**
   * @internal Monotonic ticket per server fetch (fetch/refresh/fetchMore).
   * Only the latest ticket may replace a session's loaded server window.
   */
  _fetchSeq: number;
  /** @internal Outstanding paginated request, if any. */
  _fetchMoreTicket: number | null;
  /** @internal Number of server requests still using this slot. */
  _pendingRequests: number;
  /** @internal Reconcile requested while another server request was active. */
  _reconcilePending: boolean;
  /** @internal Request currently allowed to settle `loading`. */
  _loadingTicket: number | null;
  /** Whether subsequent pages/reconciles should request image attachment data. */
  _includeImages: boolean;
  /** @internal Whether a provider history epoch has been observed for this slot. */
  _historyEpochKnown: boolean;
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  historyEpoch: string | null;
  tokenUsage: unknown;
}

export const EMPTY: NormalizedMessage[] = [];

export function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
    _fetchSeq: 0,
    _fetchMoreTicket: null,
    _pendingRequests: 0,
    _reconcilePending: false,
    _loadingTicket: null,
    _includeImages: true,
    _historyEpochKnown: false,
    historyEpoch: null,
  };
}

export const STALE_THRESHOLD_MS = 30_000;

export const MAX_REALTIME_MESSAGES = 500;
export const MAX_SESSION_SLOTS = 50;

export function dedupeMessagesById(messages: NormalizedMessage[]): NormalizedMessage[] {
  const ids = new Set<string>();
  return messages.filter((message) => {
    // An empty id is not a stable identity. Retain it rather than collapsing
    // potentially distinct legacy rows.
    if (!message.id || ids.has(message.id)) {
      return !message.id;
    }
    ids.add(message.id);
    return true;
  });
}
