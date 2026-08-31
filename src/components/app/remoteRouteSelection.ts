import type { FleetHostCatalog } from '../../fleet/discovery/hostCatalog';
import type { SessionTarget } from '../../fleet/references';
import type { Project, ProjectSession } from '../../types/app';

export type RemoteRouteSelection = Readonly<{
  project: Project;
  session: ProjectSession;
  catalogued: boolean;
}>;

/** Display-safe selection for a host-qualified route; paths remain on the peer. */
export function remoteRouteSelection(
  catalog: FleetHostCatalog,
  activeSession: SessionTarget | null,
): RemoteRouteSelection | null {
  if (activeSession === null || activeSession.hostId === null || activeSession.hostId === catalog.localHostId) return null;
  const host = catalog.hosts.get(activeSession.hostId);
  const row = host?.rows.sessions.find((session) => session.localId === activeSession.localId);
  if (host === undefined) return null;
  if (row === undefined) {
    const session: ProjectSession = {
      id: activeSession.localId,
      summary: activeSession.localId,
      __projectId: activeSession.localId,
    };
    return {
      project: {
        hostId: activeSession.hostId,
        projectId: activeSession.localId,
        displayName: host.descriptor.displayLabel || activeSession.hostId,
        fullPath: '',
        sessions: [session],
      },
      session,
      catalogued: false,
    };
  }
  const projectRow = host.rows.projects.find((project) => project.localId === row.projectLocalId);
  const session: ProjectSession = {
    id: row.localId,
    summary: row.summary,
    provider: row.provider as ProjectSession['provider'],
    __provider: row.provider as ProjectSession['__provider'],
    __projectId: row.projectLocalId,
    updated_at: new Date(row.lastActivityMs).toISOString(),
  };
  return {
    project: {
      hostId: activeSession.hostId,
      projectId: row.projectLocalId,
      displayName: projectRow?.displayName || row.projectLocalId,
      // Peer paths are deliberately not catalog material. Host-qualified API
      // requests carry the project ID and resolve the path on its owner.
      fullPath: '',
      sessions: [session],
    },
    session,
    catalogued: true,
  };
}
