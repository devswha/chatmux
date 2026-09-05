import { FLEET_PROTOCOL_VERSION } from '../../../../shared/fleet';
import type { FleetHostCatalog } from '../../../fleet/discovery/hostCatalog';
import { hostChatAvailability } from '../../../fleet/hostAvailability';
import { parseHostId, sessionRef } from '../../../fleet/references';
import { sessionRoutePath } from '../../../fleet/sessionRoute';
import type { Project, ProjectSession } from '../../../types/app';

import { parsePinnedSession, type PinnedSession } from './pinnedSessions';

export type PinInventory = Readonly<{
  catalog: FleetHostCatalog;
  /** The local project inventory already loaded by the app, never a search hit. */
  projects: readonly Project[];
}>;

export type ResolvedPinnedSession = Readonly<{
  pin: PinnedSession;
  project: Project;
  session: ProjectSession;
  hostLabel: string;
  label: string;
  route: string;
}>;

/**
 * Resolve anew at activation, as well as render. Never substitute another host,
 * project, a stale selected session, or a transcript-search result for inventory.
 * A pin addresses a provider session, not a pane or a process generation.
 */
export function resolvePinnedSession(value: unknown, inventory: PinInventory): ResolvedPinnedSession | null {
  const pin = parsePinnedSession(value);
  const { catalog, projects } = inventory;
  if (pin === null || parseHostId(catalog.localHostId) === null) return null;
  let project: Project;
  let session: ProjectSession;
  let hostLabel = '';
  if (pin.hostId === catalog.localHostId) {
    const matches = projects.filter((candidate) => (
      candidate.projectId === pin.projectId
      && (candidate.hostId === undefined || candidate.hostId === pin.hostId)
    ));
    if (matches.length !== 1) return null;
    project = matches[0];
    const sessions = project.sessions?.filter((candidate) => (
      candidate.id === pin.sessionId
      && (candidate.__projectId === undefined || candidate.__projectId === pin.projectId)
    )) ?? [];
    if (sessions.length !== 1) return null;
    session = sessions[0];
    hostLabel = catalog.hosts.get(pin.hostId)?.descriptor.displayLabel ?? '';
  } else {
    const host = catalog.hosts.get(pin.hostId);
    if (host === undefined || host.descriptor.hostId !== pin.hostId
      || host.descriptor.protocolVersion !== FLEET_PROTOCOL_VERSION
      || host.epoch === null
      || hostChatAvailability(catalog, { hostId: pin.hostId, localHostId: catalog.localHostId }, 'catalog.read') !== 'ready'
      || hostChatAvailability(catalog, { hostId: pin.hostId, localHostId: catalog.localHostId }, 'session.read') !== 'ready') return null;
    const projectRows = host.rows.projects.filter((row) => row.localId === pin.projectId);
    const sessionRows = host.rows.sessions.filter((row) => row.localId === pin.sessionId);
    if (projectRows.length !== 1 || sessionRows.length !== 1 || sessionRows[0].projectLocalId !== pin.projectId) return null;
    const row = sessionRows[0];
    session = {
      id: row.localId,
      summary: row.summary,
      provider: row.provider as ProjectSession['provider'],
      __provider: row.provider as ProjectSession['__provider'],
      __projectId: row.projectLocalId,
    };
    project = { hostId: pin.hostId, projectId: pin.projectId, displayName: projectRows[0].displayName, fullPath: '', sessions: [session] };
    hostLabel = host.descriptor.displayLabel;
  }
  return {
    pin,
    project,
    session,
    hostLabel,
    label: session.title || session.summary || session.name || session.id,
    route: sessionRoutePath(sessionRef(pin.hostId, pin.sessionId), catalog.localHostId),
  };
}

export function projectSessionPin(project: Project | null, sessionId: string | undefined, localHostId: string | null): PinnedSession | null {
  return project === null ? null : parsePinnedSession({
    hostId: project.hostId === undefined ? localHostId : project.hostId,
    projectId: project.projectId,
    sessionId,
  });
}

export function openPinnedSession(
  pin: PinnedSession,
  inventory: PinInventory,
  onOpen: (target: ResolvedPinnedSession) => void,
): boolean {
  const target = resolvePinnedSession(pin, inventory);
  if (target === null) return false;
  onOpen(target);
  return true;
}
