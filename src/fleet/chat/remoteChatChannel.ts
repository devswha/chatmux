/**
 * Browser channel for one host's chat traffic.
 *
 * A session owned by another installation cannot use the hub's own chat socket:
 * that socket resolves bare session ids against the hub's database, where the
 * same id names a different session. Host-qualified frames therefore travel on
 * the hub's `/remote-chat` gateway, which routes each frame to the owning peer.
 *
 * Two rules are structural, not incidental:
 *  - a frame is never resent. When a dispatched mutation loses its connection
 *    before acknowledgement, the outcome is reported `unknown` and the caller
 *    must reconcile against host state before the user may act again;
 *  - a reconnect carries no backlog. Queued frames belong to the connection they
 *    were queued for, so only frames still unsent when a socket opens go out.
 */

import type { ServerEvent } from '../../contexts/WebSocketContext';

import type { RemoteChatFrame } from './chatFrames';

export const REMOTE_CHAT_PATH = '/remote-chat';

/** The part of the WebSocket surface this channel uses. */
export type ChatSocketLike = {
  send: (data: string) => void;
  close: () => void;
  addEventListener: (
    type: 'open' | 'message' | 'close',
    listener: (event: { data?: unknown }) => void,
  ) => void;
};

export type RemoteChatEvent =
  | { readonly kind: 'frame'; readonly hostId: string; readonly frame: ServerEvent }
  | {
    readonly kind: 'uncertain';
    readonly hostId: string;
    readonly sessionId: string;
    readonly operation: 'chat.send' | 'chat.abort';
  };

export type RemoteChatChannel = {
  readonly send: (frames: readonly RemoteChatFrame[]) => void;
  readonly close: () => void;
};

export type RemoteChatChannelOptions = {
  readonly hostId: string;
  readonly onEvent: (event: RemoteChatEvent) => void;
  readonly connect?: () => ChatSocketLike;
};

type PendingMutation = { readonly sessionId: string; readonly operation: 'chat.send' | 'chat.abort' };

export function remoteChatUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${REMOTE_CHAT_PATH}`;
}

function browserSocket(): ChatSocketLike {
  return new WebSocket(remoteChatUrl());
}

function pendingOf(frame: RemoteChatFrame): PendingMutation | null {
  return frame.type === 'chat.send' || frame.type === 'chat.abort'
    ? { sessionId: frame.sessionId, operation: frame.type }
    : null;
}

function parseFrame(data: unknown): ServerEvent | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as ServerEvent)
      : null;
  } catch {
    return null;
  }
}

/** Acknowledgements the hub sends for a dispatched host-qualified mutation. */
function resolves(frame: ServerEvent): boolean {
  return frame.kind === 'chat_accepted'
    || frame.kind === 'chat_aborted'
    || frame.kind === 'protocol_error';
}

export function createRemoteChatChannel(options: RemoteChatChannelOptions): RemoteChatChannel {
  const connect = options.connect ?? browserSocket;
  let socket: ChatSocketLike | null = null;
  let open = false;
  let disposed = false;
  let queued: RemoteChatFrame[] = [];
  let pending: PendingMutation[] = [];

  const write = (frame: RemoteChatFrame): void => {
    socket?.send(JSON.stringify(frame));
  };

  const ensureSocket = (): void => {
    if (disposed || socket !== null) return;
    const active = connect();
    socket = active;
    active.addEventListener('open', () => {
      if (disposed || socket !== active) return;
      open = true;
      const backlog = queued;
      queued = [];
      for (const frame of backlog) write(frame);
    });
    active.addEventListener('message', (event) => {
      if (disposed || socket !== active) return;
      const frame = parseFrame(event.data);
      if (frame === null) return;
      if (resolves(frame)) pending = pending.slice(1);
      options.onEvent({ kind: 'frame', hostId: options.hostId, frame });
    });
    active.addEventListener('close', () => {
      if (socket !== active) return;
      socket = null;
      open = false;
      // Frames queued for a connection that never carried them were never
      // dispatched: they are dropped, not replayed on the next socket.
      queued = [];
      const unresolved = pending;
      pending = [];
      if (disposed) return;
      for (const mutation of unresolved) {
        options.onEvent({ kind: 'uncertain', hostId: options.hostId, ...mutation });
      }
      options.onEvent({
        kind: 'frame',
        hostId: options.hostId,
        frame: { kind: 'websocket_reconnected' },
      });
    });
  };

  return {
    send: (frames) => {
      if (disposed) return;
      ensureSocket();
      for (const frame of frames) {
        const mutation = pendingOf(frame);
        if (mutation !== null) pending = [...pending, mutation];
        if (open) write(frame); else queued = [...queued, frame];
      }
    },
    close: () => {
      disposed = true;
      queued = [];
      pending = [];
      const active = socket;
      socket = null;
      open = false;
      active?.close();
    },
  };
}
