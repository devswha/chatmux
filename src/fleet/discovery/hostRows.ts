/**
 * Catalog rows as the browser receives them, parsed once at the transport
 * boundary.
 *
 * The hub publishes display-only material: projects, sessions and live panes it
 * has aggregated from each peer. Nothing here authorizes an action — a row is a
 * label plus the reference needed to address its owner. Every field arrives
 * untrusted, so a malformed row is dropped rather than repaired: a half-parsed
 * pane would otherwise become a plausible-looking action target.
 */

import type { FleetLane } from '../../../shared/fleet';
import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../shared/tmux';
import { hostQualifiedKey, type HostQualifiedKey } from '../references';

export type FleetHostProjectRow = {
  readonly localId: string;
  readonly displayName: string;
};

export type FleetHostSessionRow = {
  readonly localId: string;
  readonly projectLocalId: string;
  readonly provider: string;
  readonly summary: string;
  readonly lastActivityMs: number;
};

export type FleetHostPaneRow = {
  readonly localId: string;
  readonly lane: FleetLane;
  readonly tmuxName: string;
  readonly tmux: TmuxPaneIdentity;
  readonly process: TmuxProcessGeneration | null;
  readonly kind: string;
  readonly providerSessionId: string | null;
  readonly activity: string;
  readonly presence: 'present' | 'stale';
};

export type FleetHostRowSet = {
  readonly projects: readonly FleetHostProjectRow[];
  readonly sessions: readonly FleetHostSessionRow[];
  readonly panes: readonly FleetHostPaneRow[];
};

export const EMPTY_HOST_ROW_SET: FleetHostRowSet = { projects: [], sessions: [], panes: [] };

const MAX_TEXT_LENGTH = 256;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_TEXT_LENGTH
    && !value.includes('\0')
    ? value
    : null;
}

function label(value: unknown): string {
  return text(value) ?? '';
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function paneIdentity(value: unknown): TmuxPaneIdentity | null {
  const row = record(value);
  if (row === null) return null;
  const socketPath = text(row.socketPath);
  const sessionId = text(row.sessionId);
  const windowId = text(row.windowId);
  const paneId = text(row.paneId);
  return socketPath === null || sessionId === null || windowId === null || paneId === null
    ? null
    : { socketPath, sessionId, windowId, paneId };
}

function processGeneration(value: unknown): TmuxProcessGeneration | null {
  const row = record(value);
  if (row === null) return null;
  const pid = count(row.pid);
  const startedAtMs = count(row.startedAtMs);
  return pid === null || startedAtMs === null || pid === 0 ? null : { pid, startedAtMs };
}

export function parseHostProjectRow(value: unknown): FleetHostProjectRow | null {
  const row = record(value);
  if (row === null) return null;
  const localId = text(row.localId);
  return localId === null ? null : { localId, displayName: label(row.displayName) };
}

export function parseHostSessionRow(value: unknown): FleetHostSessionRow | null {
  const row = record(value);
  if (row === null) return null;
  const localId = text(row.localId);
  if (localId === null) return null;
  return {
    localId,
    projectLocalId: label(row.projectLocalId),
    provider: label(row.provider),
    summary: label(row.summary),
    lastActivityMs: count(row.lastActivityMs) ?? 0,
  };
}

export function parseHostPaneRow(value: unknown): FleetHostPaneRow | null {
  const row = record(value);
  if (row === null) return null;
  const localId = text(row.localId);
  const tmuxName = text(row.tmuxName);
  const tmux = paneIdentity(row.tmux);
  if (localId === null || tmuxName === null || tmux === null) return null;
  if (row.lane !== 'external' && row.lane !== 'live') return null;
  return {
    localId,
    lane: row.lane,
    tmuxName,
    tmux,
    process: processGeneration(row.process),
    kind: label(row.kind),
    providerSessionId: text(row.providerSessionId),
    activity: label(row.activity),
    presence: row.presence === 'stale' ? 'stale' : 'present',
  };
}

/**
 * Stable list key for a pane row. A pane is identified by its exact tmux
 * coordinates, not by its process generation: the generation changes when the
 * agent restarts inside the same pane, and the row must stay the same row.
 */
export function paneRowKey(hostId: string, row: FleetHostPaneRow): HostQualifiedKey {
  return hostQualifiedKey('host-pane', [
    hostId,
    row.lane,
    row.tmux.socketPath,
    row.tmux.sessionId,
    row.tmux.windowId,
    row.tmux.paneId,
  ]);
}
