/**
 * Local counterpart of the peer `session.spawn` operation.
 *
 * `createLocalFleetReadServices` gives host-qualified reads their local branch;
 * this gives the spawn mutation the same one, so a request naming this
 * installation runs the existing local spawn path with the existing home-anchored
 * path check instead of travelling over the fleet transport.
 */

import { projectsDb } from '@/modules/database/index.js';
import { resolveExternalCliCwd, spawnLiveSession } from '@/modules/providers/index.js';

import type { JsonValue } from '../../../../shared/fleet.js';

import { FleetHostRoutingError } from './host-router.js';

export type LocalFleetSpawnService = Readonly<{
  readonly spawn: (
    projectLocalId: string,
    input: Readonly<{ readonly name: string; readonly cwd: string }>,
  ) => Promise<JsonValue>;
}>;

export function createLocalFleetSpawnService(): LocalFleetSpawnService {
  return {
    spawn: async (projectLocalId, input) => {
      if (projectsDb.getProjectById(projectLocalId) === null) {
        throw new FleetHostRoutingError('HOST_NOT_FOUND', 'Local project was not found.');
      }
      const cwd = await resolveExternalCliCwd(input.cwd);
      if (cwd === null) {
        throw new FleetHostRoutingError('FLEET_UNAUTHORIZED', 'Spawn path is outside the host home directory.');
      }
      const result = await spawnLiveSession(input.name, cwd);
      return { ok: result.ok, reachable: result.reachable, conflict: result.conflict };
    },
  };
}
