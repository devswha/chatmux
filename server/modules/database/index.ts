export { initializeDatabase } from '@/modules/database/init-db.js';
export { FLEET_PERSISTENCE_SCHEMA_SQL } from '@/modules/database/schema-parts/fleet.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
export {
  completionAppAlias,
  completionAppIdentityKey,
  completionExternalGenerationAlias,
  completionExternalGenerationIdentityFromSession,
  completionExternalGenerationIdentityKey,
  completionExternalGenerationPaneEvidenceKey,
  completionTargetIdentity,
  type CompletionAppIdentity,
  type CompletionExternalGenerationIdentity,
  type CompletionPaneEvidenceIdentity,
} from '@/modules/database/services/completion-target-identity.service.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
export {
  assertFleetRoleIntegrity,
  fleetInstallationRole,
  FleetRoleConflictDataError,
  type FleetInstallationRole,
} from '@/modules/database/repositories/fleet-installation-role.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
export {
  completionNotificationOutboxDb,
  CompletionNotificationOutboxRepository,
} from '@/modules/database/repositories/completion-notification-outbox.js';
export {
  fleetCompletionOutboxDb,
  FleetCompletionOutboxRepository,
} from '@/modules/database/repositories/fleet-completion-outbox.js';
export {
  completionNotificationTargetsDb,
  CompletionNotificationTargetsRepository,
} from '@/modules/database/repositories/completion-notification-targets.js';
export {
  fleetHubGrantsDb,
  FleetHubGrantsRepository,
  type FleetHubGrant,
} from '@/modules/database/repositories/fleet-hub-grants.js';
export {
  FleetPairingTokenInputError,
  FleetPairingTokensRepository,
} from '@/modules/database/repositories/fleet-pairing-tokens.js';
export { fleetPeersDb, type FleetPeer } from '@/modules/database/repositories/fleet-peers.js';
export {
  fleetSshTunnelsDb,
  FleetSshTunnelsRepository,
  type FleetSshTunnelRecord,
} from '@/modules/database/repositories/fleet-ssh-tunnels.js';
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
export { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
export { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
export { userDb } from '@/modules/database/repositories/users.js';
export { vapidKeysDb } from '@/modules/database/repositories/vapid-keys.js';
