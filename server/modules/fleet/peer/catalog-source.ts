import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import type { DiscoveryCollector } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import type { FleetCapability } from '../../../../shared/fleet.js';
import { fleetCatalogPaneKey } from '../catalog/keys.js';
import type { FleetCatalogSession, FleetCatalogSourceMaterial } from '../catalog/types.js';

/**
 * Sessions read per refresh. Far more than one frame carries (rows measure a
 * few hundred bytes), so the frame bound decides what ships, while the read
 * itself stays one query instead of one per project on every collector tick.
 */
export const CATALOG_SOURCE_SESSION_LIMIT = 512;

type CatalogSourceOptions = Readonly<{
  readonly hostId: string;
  readonly displayLabel: string;
  readonly capabilities: readonly FleetCapability[];
  readonly discovery: DiscoveryCollector;
}>;
function activityMs(value: string): number { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; }
type ProjectRow = Readonly<{ readonly project_id: string; readonly project_path: string; readonly custom_project_name?: string | null; readonly isStarred?: number }>;
type SessionRow = Readonly<{ readonly session_id: string; readonly provider: string; readonly project_path: string | null; readonly custom_name?: string | null; readonly updated_at?: string | null; readonly created_at?: string | null }>;

export function createPeerCatalogSource(options: CatalogSourceOptions): Readonly<{
  readonly read: () => Promise<FleetCatalogSourceMaterial>;
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
      const projectRows: ProjectRow[] = projectsDb.getProjectPaths();
      const projectIdByPath = new Map(projectRows.map((project) => [project.project_path, project.project_id]));
      const totalSessions = sessionsDb.countSessions();
      const recent: SessionRow[] = sessionsDb.getRecentSessions(CATALOG_SOURCE_SESSION_LIMIT);
      const sessions: FleetCatalogSession[] = [];
      for (const session of recent) {
        const projectLocalId = session.project_path === null ? undefined : projectIdByPath.get(session.project_path);
        if (projectLocalId === undefined) continue;
        sessions.push({ localId: session.session_id, projectLocalId, provider: session.provider, summary: session.custom_name ?? '', lastActivityMs: activityMs(session.updated_at ?? session.created_at ?? '') });
      }
      const omittedSessions = Math.max(0, totalSessions - sessions.length);
      return {
        ...(omittedSessions === 0 ? {} : { omitted: { projects: 0, sessions: omittedSessions, panes: 0 } }),
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
