/**
 * Host-qualified client identity for fleet sessions, projects and panes.
 *
 * `shared/fleet.ts` owns the wire contract; this module owns the browser-side
 * vocabulary built on it: reference constructors, a boundary parser for host
 * ids that arrive as untrusted route/storage strings, and the stable key
 * helper every host-qualified client map is keyed by.
 *
 * Key format: one `kind` tag plus length-prefixed fields (`<utf8ByteLength>:<value>`),
 * mirroring `server/modules/fleet/catalog/keys.ts`. Length prefixes are what make
 * the encoding injective; the RFC forbids plain delimiter concatenation because
 * `a:b` + `c` and `a` + `b:c` would otherwise collide. Keys stay synchronous —
 * they are read during render and inside `Map` lookups, so the SHA-256 digest
 * helpers (`fleetReferenceDigest`) cannot serve here.
 */

import type {
  FleetLane,
  FleetPaneReference,
  FleetProjectReference,
  FleetReference,
  FleetSessionReference,
} from '../../shared/fleet';
import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../shared/tmux';

export type {
  FleetHostReference,
  FleetPaneReference,
  FleetProjectReference,
  FleetReference,
  FleetSessionReference,
} from '../../shared/fleet';

/**
 * A stable client map/storage key produced by {@link referenceKey} or
 * {@link sessionSlotKey}. Never build one by string concatenation.
 */
export type HostQualifiedKey = string;

/**
 * A session addressed by its owning host. `hostId: null` means "this browser has
 * no authoritative local host id yet", never "any host".
 */
export type SessionTarget = {
  readonly hostId: string | null;
  readonly localId: string;
};

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_IDENTIFIER_LENGTH = 256;
const encoder = new TextEncoder();

function assertNever(value: never): never {
  throw new Error(`unexpected fleet reference: ${JSON.stringify(value)}`);
}

/** Parses an untrusted host id (route segment, persisted pointer, push payload). */
export function parseHostId(value: unknown): string | null {
  return typeof value === 'string' && HOST_ID.test(value) ? value : null;
}

/** Parses an untrusted local id: a nonempty scalar string of at most 256 characters. */
export function parseLocalId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    return null;
  }
  return value.includes('\0') ? null : value;
}

export function sessionRef(hostId: string, localId: string): FleetSessionReference {
  return { kind: 'session', hostId, localId };
}

export function projectRef(hostId: string, localId: string): FleetProjectReference {
  return { kind: 'project', hostId, localId };
}

export function paneRef(target: {
  readonly hostId: string;
  readonly localId: string;
  readonly lane: FleetLane;
  readonly tmux: TmuxPaneIdentity;
  readonly process: TmuxProcessGeneration;
}): FleetPaneReference {
  return { kind: 'pane', ...target };
}

function field(value: string): string {
  return `${encoder.encode(value).length}:${value}`;
}

/**
 * Injective key for one tagged tuple of host-qualified fields. Every persisted
 * and in-memory client key goes through here so that no two distinct tuples can
 * ever encode to the same string.
 */
export function hostQualifiedKey(kind: string, values: readonly string[]): HostQualifiedKey {
  return `${kind}|${values.map(field).join('')}`;
}

export function referenceKey(reference: FleetReference): HostQualifiedKey {
  switch (reference.kind) {
    case 'host':
      return hostQualifiedKey('host', [reference.hostId]);
    case 'session':
      return hostQualifiedKey('session', [reference.hostId, reference.localId]);
    case 'project':
      return hostQualifiedKey('project', [reference.hostId, reference.localId]);
    case 'pane':
      return hostQualifiedKey('pane', [
        reference.hostId,
        reference.localId,
        reference.lane,
        reference.tmux.socketPath,
        reference.tmux.sessionId,
        reference.tmux.windowId,
        reference.tmux.paneId,
        String(reference.process.pid),
        String(reference.process.startedAtMs),
      ]);
    default:
      return assertNever(reference);
  }
}

export const UNKNOWN_HOST_SESSION_PREFIX = 'unknown-host-session|';

/**
 * Key for a session whose host may not be known yet.
 *
 * Before the server supplies the authoritative local host id, bare ids are
 * keyed in their own `unknown-host` namespace: they must never share a key with
 * a host-qualified session, because that is exactly the collision this
 * migration exists to prevent.
 */
export function sessionSlotKey(hostId: string | null, localId: string): HostQualifiedKey {
  return hostId === null
    ? `${UNKNOWN_HOST_SESSION_PREFIX}${field(localId)}`
    : referenceKey(sessionRef(hostId, localId));
}

/**
 * Local id behind an unknown-host session key, or null for any other key. The
 * local id is the last field, so everything after its length prefix is the value.
 */
export function unknownHostSessionLocalId(key: HostQualifiedKey): string | null {
  if (!key.startsWith(UNKNOWN_HOST_SESSION_PREFIX)) {
    return null;
  }
  const separator = key.indexOf(':', UNKNOWN_HOST_SESSION_PREFIX.length);
  return separator === -1 ? null : key.slice(separator + 1);
}

/** Project counterpart of {@link sessionSlotKey}. */
export function projectSlotKey(hostId: string | null, localId: string): HostQualifiedKey {
  return hostId === null
    ? `unknown-host-project|${field(localId)}`
    : referenceKey(projectRef(hostId, localId));
}

/**
 * Key for a discovery pane row as the browser knows it.
 *
 * A {@link FleetPaneReference} key additionally binds the tmux identity and the
 * process generation, which an action target must carry. A catalog row is
 * display-only, so it is keyed by host, lane and local id — enough to keep two
 * hosts' identical pane ids apart, and deliberately not enough to act on.
 */
export function catalogPaneRowKey(
  hostId: string,
  lane: FleetLane,
  localId: string,
): HostQualifiedKey {
  return hostQualifiedKey('catalog-pane', [hostId, lane, localId]);
}
