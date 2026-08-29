/**
 * Chat frame routing for the open session's owning host.
 *
 * The chat composer and session hooks emit one frame shape, addressed by a bare
 * local session id. That id only identifies a session inside one installation,
 * so every frame is routed here first: a frame for this installation is passed
 * through untouched (local behaviour is unchanged), while a frame for a peer is
 * translated into the host-qualified form the hub's `/remote-chat` gateway
 * accepts, or blocked with an explicit reason.
 *
 * Blocking is deliberate. A remote frame is never retargeted at another host or
 * session, never silently degraded, and a send is never re-emitted after an
 * uncertain outcome: the contract requires reconciliation plus fresh user intent.
 */

export type HostChatAvailability = 'ready' | 'syncing' | 'unavailable';

export type ChatBlockReason =
  | 'host-unavailable'
  | 'host-syncing'
  | 'reconcile-required'
  | 'session-mismatch'
  | 'attachments-unsupported'
  | 'unsupported-frame';

export type HostChatContext = {
  /** Host owning the open session, or null when no session is open. */
  readonly hostId: string | null;
  readonly localHostId: string | null;
  /** Local id of the open session, or null when no session is open. */
  readonly sessionId: string | null;
  readonly availability: HostChatAvailability;
  /** True while an uncertain mutation outcome for this session is unreconciled. */
  readonly reconcileRequired: boolean;
};

export type RemoteChatFrame = Readonly<Record<string, unknown>> & {
  readonly type: string;
  readonly hostId: string;
  readonly sessionId: string;
};

export type ChatFrameRouting =
  | { readonly kind: 'local' }
  | { readonly kind: 'remote'; readonly frames: readonly RemoteChatFrame[] }
  | { readonly kind: 'blocked'; readonly reason: ChatBlockReason };

const LOCAL: ChatFrameRouting = { kind: 'local' };

/** Frame types that carry a session and therefore belong to its owning host. */
const SESSION_FRAME_PREFIX = 'chat.';
const SESSION_FRAME_TYPES = new Set([
  'chat.send',
  'chat.abort',
  'chat.subscribe',
  'chat.permission-response',
  'chat.prompt-response',
  'chat.approval-response',
]);

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function blocked(reason: ChatBlockReason): ChatFrameRouting {
  return { kind: 'blocked', reason };
}

function hostBlock(availability: HostChatAvailability): ChatFrameRouting | null {
  switch (availability) {
    case 'ready':
      return null;
    case 'syncing':
      return blocked('host-syncing');
    case 'unavailable':
      return blocked('host-unavailable');
  }
}

/** Subscribe is a batch locally; only the open remote session belongs to this host. */
function namedSessions(frame: Readonly<Record<string, unknown>>): readonly string[] | null {
  if (frame.type === 'chat.subscribe') {
    const sessions = frame.sessions;
    if (Array.isArray(sessions)) {
      return sessions
        .map((entry) => record(entry)?.sessionId)
        .filter((sessionId): sessionId is string => typeof sessionId === 'string');
    }
  }
  // Permission, prompt and approval responses are addressed by request id: they
  // belong to the session on screen, so there is nothing to cross-check.
  return typeof frame.sessionId === 'string' ? [frame.sessionId] : null;
}

function hasAttachments(frame: Readonly<Record<string, unknown>>): boolean {
  const options = record(frame.options);
  return Array.isArray(options?.images) && options.images.length > 0;
}

function remote(frames: readonly RemoteChatFrame[]): ChatFrameRouting {
  return { kind: 'remote', frames };
}

function translate(
  frame: Readonly<Record<string, unknown>>,
  target: { readonly hostId: string; readonly sessionId: string },
): ChatFrameRouting {
  const base = { hostId: target.hostId, sessionId: target.sessionId };
  switch (frame.type) {
    case 'chat.send':
      if (hasAttachments(frame)) return blocked('attachments-unsupported');
      return remote([{ type: 'chat.send', ...base, content: String(frame.content ?? '') }]);
    case 'chat.abort':
      return remote([{ type: 'chat.abort', ...base }]);
    case 'chat.subscribe': {
      const matching = Array.isArray(frame.sessions)
        ? frame.sessions.map(record).find((entry) => entry?.sessionId === target.sessionId)
        : null;
      const lastSeq = typeof matching?.lastSeq === 'number' && Number.isFinite(matching.lastSeq)
        ? Math.max(0, Math.floor(matching.lastSeq))
        : 0;
      return remote([{ type: 'chat.subscribe', ...base, lastSeq }]);
    }
    case 'chat.permission-response':
      return remote([{ type: 'chat.permission-response', ...base, allow: frame.allow === true }]);
    case 'chat.prompt-response':
      return remote([{ ...frame, ...base, type: 'chat.prompt-response' }]);
    case 'chat.approval-response':
      return remote([{ ...frame, ...base, type: 'chat.approval-response' }]);
    default:
      return blocked('unsupported-frame');
  }
}

export function routeChatFrame(value: unknown, context: HostChatContext): ChatFrameRouting {
  const frame = record(value);
  if (frame === null || typeof frame.type !== 'string') {
    return LOCAL;
  }
  const isLocalHost = context.hostId === null || context.hostId === context.localHostId;
  // Hub-level frames (fleet roster, discovery, pane streams) are not session
  // traffic: they always belong to the browser's own socket. Every `chat.` frame
  // is session traffic, so an unsupported one is blocked rather than delegated
  // to the hub, whose database holds a different session with the same id.
  if (isLocalHost || !frame.type.startsWith(SESSION_FRAME_PREFIX)) {
    return LOCAL;
  }
  const hostId = context.hostId;
  const sessionId = context.sessionId;
  if (hostId === null || sessionId === null) {
    return blocked('session-mismatch');
  }
  const named = namedSessions(frame);
  if (!SESSION_FRAME_TYPES.has(frame.type)) {
    return blocked('unsupported-frame');
  }
  if (named !== null && !named.includes(sessionId)) {
    return blocked('session-mismatch');
  }
  if (context.reconcileRequired && frame.type !== 'chat.subscribe') {
    return blocked('reconcile-required');
  }
  return hostBlock(context.availability) ?? translate(frame, { hostId, sessionId });
}
