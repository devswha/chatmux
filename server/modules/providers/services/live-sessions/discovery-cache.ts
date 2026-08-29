import type { HostDiscoverySnapshot } from '../host-discovery-snapshot.service.js';
import { hostDiscoverySnapshotSource } from '../host-discovery-snapshot.service.js';
import { recordHostCommand } from '../host-command-metrics.service.js';

import type { LiveGjcSession } from './process-parsing.js';
import type { LiveGjcSessionCommandRunner } from './session-correlation.js';
import type { LiveGjcSessionsDetailedResult } from './transcript-enrichment.js';
import { runCommand } from './session-correlation.js';
import { scanLiveGjcSessions } from './discovery-scan.js';

export type LiveGjcSessionDiscovery = {
  getLiveGjcSessions(): Promise<LiveGjcSession[]>;
  getLiveGjcSessionsDetailed(): Promise<LiveGjcSessionsDetailedResult>;
};

export type LiveGjcSessionDiscoveryOptions = {
  commandRunner?: LiveGjcSessionCommandRunner;
  hostSnapshot?: () => Promise<HostDiscoverySnapshot>;
};

export async function runDiscoveryCommand(
  commandRunner: LiveGjcSessionCommandRunner,
  command: string,
  cmdArgs: string[],
): Promise<string> {
  if (commandRunner !== runCommand) recordHostCommand(command, cmdArgs);
  return commandRunner(command, cmdArgs);
}

export function createLiveGjcSessionDiscovery(
  options: LiveGjcSessionDiscoveryOptions = {},
): LiveGjcSessionDiscovery {
  const commandRunner = options.commandRunner ?? runCommand;
  let inFlight: Promise<LiveGjcSessionsDetailedResult> | null = null;
  const scanShared = (): Promise<LiveGjcSessionsDetailedResult> => {
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(async () => scanLiveGjcSessions(
          commandRunner,
          options.hostSnapshot ? await options.hostSnapshot() : undefined,
        ))
        .finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
  return {
    async getLiveGjcSessions() {
      return (await scanShared()).sessions;
    },
    getLiveGjcSessionsDetailed: scanShared,
  };
}

export const defaultLiveGjcSessionDiscovery = createLiveGjcSessionDiscovery({
  hostSnapshot: hostDiscoverySnapshotSource.get,
});

/** Compatible session-only wrapper for existing callers. */
export async function getLiveGjcSessions(): Promise<LiveGjcSession[]> {
  return defaultLiveGjcSessionDiscovery.getLiveGjcSessions();
}

/** Distinguishes a confirmed empty roster from unavailable tmux evidence. */
export async function getLiveGjcSessionsDetailed(): Promise<LiveGjcSessionsDetailedResult> {
  return defaultLiveGjcSessionDiscovery.getLiveGjcSessionsDetailed();
}
