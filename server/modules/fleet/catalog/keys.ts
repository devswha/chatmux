import type { FleetLane } from '../../../../shared/fleet.js';
import type { TmuxPaneIdentity } from '../../../../shared/tmux.js';

export function hostQualifiedCatalogKey(hostId: string, localId: string): string {
  return `${Buffer.byteLength(hostId)}:${hostId}${Buffer.byteLength(localId)}:${localId}`;
}

/**
 * The wire-safe pane key published in fleet catalogs and echoed back as the
 * pane target localId. Discovery rows carry an internal NUL-joined key, which
 * the catalog schema and every URL/JSON boundary forbid, so the producer and
 * the peer-side matchers share this length-prefixed encoding instead.
 */
export function fleetCatalogPaneKey(lane: FleetLane, tmux: TmuxPaneIdentity): string {
  return [lane, tmux.socketPath, tmux.sessionId, tmux.windowId, tmux.paneId]
    .map((part) => `${Buffer.byteLength(part)}:${part}`)
    .join('');
}
