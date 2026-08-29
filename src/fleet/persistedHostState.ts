/**
 * Versioned, host-qualified browser state: queued composer drafts and the
 * sidebar's live-session order.
 *
 * Legacy layouts (`queued_message_<sessionId>`, `chatmux.liveSessionOrder.v1`)
 * hold bare session ids that only mean something relative to one installation.
 * They are rewritten to host-qualified keys exactly once, and only after the
 * server supplies the authoritative local host id.
 *
 * This module is the persisted browser-state contract consumed by the client.
 * Storage boundaries, payloads, ordering, and migration live in cohesive
 * modules behind this facade.
 */

export {
  browserPersistedStateStorage,
  IDENTITY_MARKER_KEY,
  LEGACY_LIVE_SESSION_ORDER_KEY,
  LEGACY_QUEUED_MESSAGE_PREFIX,
  LIVE_SESSION_ORDER_KEY,
  PERSISTED_HOST_STATE_VERSION,
  QUEUED_DRAFT_PREFIX,
} from './persistedHostStateContracts';
export type {
  PersistedStateMigration,
  PersistedStateStorage,
  QueuedDraftRecord,
} from './persistedHostStateContracts';
export { migrateLegacyPersistedState } from './persistedHostMigration';
export {
  clearQueuedDraft,
  parseQueuedDraft,
  queuedDraftKey,
  readQueuedDraft,
  writeQueuedDraft,
} from './persistedQueuedDraft';
export {
  paneIdentityOrderKey,
  readPersistedSessionOrder,
  writePersistedSessionOrder,
} from './persistedSessionOrder';
