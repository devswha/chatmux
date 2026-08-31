import path from 'node:path';
import os from 'node:os';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import type { DiscoveryCollector, DiscoveryRow } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import type { FleetCapability } from '../../../../shared/fleet.js';
import { fleetCatalogPaneKey } from '../catalog/keys.js';
import type { FleetCatalogMaterial, FleetCatalogSession } from '../catalog/types.js';

type CatalogSourceOptions = Readonly<{
  readonly hostId: string;
  readonly displayLabel: string;
  readonly capabilities: readonly FleetCapability[];
  readonly discovery: DiscoveryCollector;
}>;
function activityMs(value: string): number { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; }
type ProjectRow = Readonly<{ readonly project_id: string; readonly project_path: string; readonly custom_project_name?: string | null; readonly isStarred?: number }>;
type SessionRow = Readonly<{
  readonly session_id: string;
  readonly provider: string;
  readonly provider_session_id?: string | null;
  readonly project_path?: string | null;
  readonly custom_name?: string | null;
  readonly updated_at?: string | null;
  readonly created_at?: string | null;
}>;

const FLEET_PROJECT_CATALOG_LIMIT = 100;

function providerSessionKey(provider: string, sessionId: string): string {
  return `${provider}\0${sessionId}`;
}

type TmuxSessionLookup = Readonly<{
  readonly byProviderSessionId: (provider: string, sessionId: string) => SessionRow | null;
  readonly byAppSessionId: (sessionId: string) => SessionRow | null;
}>;

/** Resolve only the transcript rows named by currently discovered tmux panes. */
export function discoveredTmuxSessionRows(
  discoveryRows: readonly Pick<DiscoveryRow, 'kind' | 'providerSessionId'>[],
  lookup: TmuxSessionLookup,
): readonly SessionRow[] {
  const sessions = new Map<string, SessionRow>();
  for (const row of discoveryRows) {
    if (row.providerSessionId === null) continue;
    const session = lookup.byProviderSessionId(row.kind, row.providerSessionId)
      ?? lookup.byAppSessionId(row.providerSessionId);
    if (session === null || session.provider !== row.kind) continue;
    sessions.set(providerSessionKey(session.provider, session.session_id), session);
  }
  return [...sessions.values()];
}

export function createPeerCatalogSource(options: CatalogSourceOptions): Readonly<{
  readonly read: () => Promise<FleetCatalogMaterial>;
  readonly subscribe: (listener: () => void) => () => void;
}> {
  return {
    subscribe: (listener) => {
      const unsubscribeDiscovery = options.discovery.onSnapshot(listener);
      const unsubscribeProcessing = chatRunRegistry.subscribeProcessing(listener);
      // A connected hub is itself an authenticated discovery subscriber. Peer
      // processes have no local browser socket to activate the otherwise inert
      // collector, so the catalog lease must own its cadence explicitly.
      options.discovery.start();
      options.discovery.setActive(true);
      return () => {
        unsubscribeDiscovery();
        unsubscribeProcessing();
        options.discovery.setActive(false);
      };
    },
    read: async () => {
      // Never force a full scan here: the collector's active cadence (1 s)
      // already keeps the snapshot inside this staleness bound, and every
      // completed tick re-notifies subscribers. Forcing a scan makes each
      // publisher refresh schedule another tick, which re-pends the publisher
      // and livelocks the catalog before any snapshot can ship.
      await options.discovery.ensureFresh(2_000);
      const discovery = options.discovery.currentSnapshot();
      const sessionRows = discoveredTmuxSessionRows(discovery.rows, {
        byProviderSessionId: (provider, sessionId) => sessionsDb.getSessionByProviderSessionId(provider, sessionId),
        byAppSessionId: (sessionId) => sessionsDb.getSessionById(sessionId),
      });
      const recentProjects: ProjectRow[] = projectsDb.getProjectPaths({
        limit: FLEET_PROJECT_CATALOG_LIMIT,
        excludePathRoot: os.tmpdir(),
      });
      const projectsByPath = new Map(recentProjects.map((project) => [project.project_path, project]));
      for (const session of sessionRows) {
        if (!session.project_path || projectsByPath.has(session.project_path)) continue;
        const activeProject = projectsDb.getProjectPath(session.project_path);
        if (activeProject) projectsByPath.set(activeProject.project_path, activeProject);
      }
      const projectRows = [...projectsByPath.values()];
      const projectIds = new Map(projectRows.map((project) => [project.project_path, project.project_id]));
      const sessions: FleetCatalogSession[] = sessionRows.flatMap((session) => {
        const projectLocalId = session.project_path === null || session.project_path === undefined
          ? undefined
          : projectIds.get(session.project_path);
        return projectLocalId === undefined
          ? []
          : [{
            localId: session.session_id,
            projectLocalId,
            provider: session.provider,
            summary: session.custom_name ?? '',
            lastActivityMs: activityMs(session.updated_at ?? session.created_at ?? ''),
          }];
      });
      return {
        host: { hostId: options.hostId, displayLabel: options.displayLabel, capabilities: options.capabilities },
        projects: projectRows.map((project) => ({ localId: project.project_id, path: project.project_path, displayName: project.custom_project_name?.trim() || path.basename(project.project_path) || project.project_path, isStarred: Boolean(project.isStarred) })),
        sessions,
        panes: discovery.rows.map((row) => ({ localId: fleetCatalogPaneKey(row.lane, row.tmux), lane: row.lane, tmuxName: row.tmuxName, tmux: row.tmux, process: row.process, kind: row.kind, providerSessionId: row.providerSessionId, activity: row.activity, cwd: row.cwd, presence: row.presence })),
        health: discovery.health,
        processing: chatRunRegistry.listRunningRuns().map((run) => ({ localId: run.sessionId, provider: run.provider, startedAtMs: run.startedAt, lastSeq: run.lastSeq })),
      };
    },
  };
}
