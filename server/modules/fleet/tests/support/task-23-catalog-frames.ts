import type { FleetPeerDescriptor } from '../../../../../shared/fleet.js';
import type {
  FleetCatalogPane,
  FleetCatalogSession,
} from '../../catalog/types.js';

type Frame = Readonly<Record<string, unknown>>;

/** The browser-projected catalog frame: host/health/processing never cross the browser boundary. */
export type FleetBrowserCatalog = Readonly<{
  hostId: string;
  epoch: string;
  revision: number;
  projects: readonly Readonly<{ localId: string; displayName: string }>[];
  sessions: readonly FleetCatalogSession[];
  panes: readonly FleetCatalogPane[];
}>;

function textField(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`catalog frame ${name} is invalid`);
  return value;
}
function rowObjects(value: unknown, name: string): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.some((row) => typeof row !== 'object' || row === null || Array.isArray(row))) {
    throw new TypeError(`catalog frame ${name} is invalid`);
  }
  return value.map((row) => Object.fromEntries(Object.entries(row)));
}

export function browserCatalog(frame: Frame): FleetBrowserCatalog {
  const projects = rowObjects(frame.projects, 'projects').map((row) => ({
    localId: textField(row.localId, 'project.localId'),
    displayName: textField(row.displayName, 'project.displayName'),
  }));
  const sessions = rowObjects(frame.sessions, 'sessions').map((row) => ({
    localId: textField(row.localId, 'session.localId'),
    projectLocalId: textField(row.projectLocalId, 'session.projectLocalId'),
    provider: textField(row.provider, 'session.provider'),
    summary: typeof row.summary === 'string' ? row.summary : '',
    lastActivityMs: typeof row.lastActivityMs === 'number' ? row.lastActivityMs : 0,
  }));
  const panes = rowObjects(frame.panes, 'panes').map((row) => {
    const tmux = row.tmux;
    if (tmux === null || typeof tmux !== 'object' || Array.isArray(tmux)) throw new TypeError('catalog frame pane.tmux is invalid');
    const identity = Object.fromEntries(Object.entries(tmux));
    const process = row.process;
    if (process !== null && (typeof process !== 'object' || Array.isArray(process))) throw new TypeError('catalog frame pane.process is invalid');
    const generation = process === null || process === undefined ? null : Object.fromEntries(Object.entries(process));
    return {
      localId: textField(row.localId, 'pane.localId'),
      lane: row.lane === 'live' ? 'live' as const : 'external' as const,
      tmuxName: textField(row.tmuxName, 'pane.tmuxName'),
      tmux: {
        socketPath: textField(identity.socketPath, 'pane.tmux.socketPath'),
        sessionId: textField(identity.sessionId, 'pane.tmux.sessionId'),
        windowId: textField(identity.windowId, 'pane.tmux.windowId'),
        paneId: textField(identity.paneId, 'pane.tmux.paneId'),
      },
      process: generation === null ? null : {
        pid: typeof generation.pid === 'number' ? generation.pid : 0,
        startedAtMs: typeof generation.startedAtMs === 'number' ? generation.startedAtMs : 0,
      },
      kind: textField(row.kind, 'pane.kind'),
      providerSessionId: typeof row.providerSessionId === 'string' ? row.providerSessionId : null,
      activity: textField(row.activity, 'pane.activity'),
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      presence: row.presence === 'stale' ? 'stale' as const : 'present' as const,
    };
  });
  return {
    hostId: textField(frame.hostId, 'hostId'),
    epoch: textField(frame.epoch, 'epoch'),
    revision: typeof frame.revision === 'number' ? frame.revision : 0,
    projects, sessions, panes,
  };
}

type BrowserChange = Readonly<{
  op: 'upsert' | 'remove';
  entity: 'project' | 'session' | 'pane';
  row: Readonly<Record<string, unknown>>;
}>;

function changes(frame: Frame): readonly BrowserChange[] {
  if (!Array.isArray(frame.changes)) return [];
  return frame.changes.filter((value): value is BrowserChange => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const change = value as Readonly<Record<string, unknown>>;
    return (change.op === 'upsert' || change.op === 'remove')
      && (change.entity === 'project' || change.entity === 'session' || change.entity === 'pane')
      && typeof change.row === 'object' && change.row !== null && !Array.isArray(change.row);
  });
}

function applyRows<T extends Readonly<{ localId: string }>>(
  rows: readonly T[],
  mutations: readonly BrowserChange[],
  entity: BrowserChange['entity'],
  parse: (row: Frame) => T,
): readonly T[] {
  const next = new Map(rows.map((row) => [row.localId, row]));
  for (const change of mutations) {
    if (change.entity !== entity) continue;
    const row = parse(change.row);
    if (change.op === 'remove') next.delete(row.localId);
    else next.set(row.localId, row);
  }
  return [...next.values()];
}

/** Applies the exact browser snapshot/delta protocol without consulting peer internals. */
export function applyBrowserCatalogFrame(
  current: FleetBrowserCatalog | undefined,
  frame: Frame,
): FleetBrowserCatalog | undefined {
  if (frame.kind === 'fleet.catalog.snapshot') return browserCatalog(frame);
  if (frame.kind !== 'fleet.catalog.delta' || current === undefined
    || frame.hostId !== current.hostId || frame.epoch !== current.epoch
    || frame.prevRevision !== current.revision || typeof frame.revision !== 'number') return current;
  const mutations = changes(frame);
  const parseProject = (row: Frame) => browserCatalog({
    hostId: current.hostId, epoch: current.epoch, revision: current.revision,
    projects: [row], sessions: [], panes: [],
  }).projects[0]!;
  const parseSession = (row: Frame) => browserCatalog({
    hostId: current.hostId, epoch: current.epoch, revision: current.revision,
    projects: [], sessions: [row], panes: [],
  }).sessions[0]!;
  const parsePane = (row: Frame) => browserCatalog({
    hostId: current.hostId, epoch: current.epoch, revision: current.revision,
    projects: [], sessions: [], panes: [row],
  }).panes[0]!;
  return {
    ...current,
    revision: frame.revision,
    projects: applyRows(current.projects, mutations, 'project', parseProject),
    sessions: applyRows(current.sessions, mutations, 'session', parseSession),
    panes: applyRows(current.panes, mutations, 'pane', parsePane),
  };
}

export function isStateFrame(frame: Frame): frame is Frame & Readonly<{ host: FleetPeerDescriptor }> {
  return frame.kind === 'fleet.host_state' && typeof frame.host === 'object' && frame.host !== null;
}

