/**
 * Session-keyed message store — public facade.
 *
 * Holds per-session state in a Map keyed by the host-qualified session key.
 * Session switch = change the active-slot pointer. No clearing; old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 *
 * Implementation lives in cohesive modules under `sessionStore/`; every import
 * site keeps using this path.
 */

export { useSessionStore, type SessionStore } from './sessionStore/store';
export {
  type MessageKind,
  type NormalizedMessage,
  type SessionSlot,
  type SessionStatus,
} from './sessionStore/messages';
