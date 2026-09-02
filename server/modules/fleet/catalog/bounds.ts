import { canonicalFleetJson, FLEET_MAX_FRAME_BYTES } from '../protocol/codec.js';

import type {
  FleetCatalogMaterial,
  FleetCatalogOmitted,
  FleetCatalogPane,
  FleetCatalogProject,
  FleetCatalogSession,
  FleetCatalogSourceMaterial,
} from './types.js';

/**
 * Bytes kept free for the event envelope (kind, protocol version, generation,
 * event id, event name, host id) plus epoch and revision around a catalog body.
 */
export const CATALOG_FRAME_HEADROOM_BYTES = 1024;
/** Largest catalog body the publisher will put on the wire. */
export const CATALOG_BODY_BUDGET_BYTES = FLEET_MAX_FRAME_BYTES - CATALOG_FRAME_HEADROOM_BYTES;

export type BoundedCatalog = Readonly<{
  readonly material: FleetCatalogMaterial;
  readonly omitted?: FleetCatalogOmitted;
}>;

type BoundOptions = Readonly<{
  readonly budgetBytes?: number;
  readonly measure?: (value: unknown) => number;
}>;

/** Exact wire size: the codec canonicalizes the same way before the frame check. */
export function measureCatalogBody(value: unknown): number {
  return Buffer.byteLength(canonicalFleetJson(value));
}

function byRecency(left: FleetCatalogSession, right: FleetCatalogSession): number {
  if (left.lastActivityMs !== right.lastActivityMs) return right.lastActivityMs - left.lastActivityMs;
  return left.localId < right.localId ? -1 : left.localId > right.localId ? 1 : 0;
}

function presentFirst(panes: readonly FleetCatalogPane[]): FleetCatalogPane[] {
  return [...panes.filter((pane) => pane.presence === 'present'), ...panes.filter((pane) => pane.presence !== 'present')];
}

function referencedProjectIds(sessions: readonly FleetCatalogSession[]): Set<string> {
  return new Set(sessions.map((session) => session.projectLocalId));
}

/**
 * Trims peer material until its snapshot body fits one frame (RFC rev.2).
 *
 * Priority, highest first: present panes; the most recently active sessions
 * with the projects they belong to; starred projects. Rows leave in this
 * order until the body fits: projects no session references and nobody
 * starred, stale panes, the least recently active sessions (a project whose
 * last kept session left goes with it unless starred), starred projects
 * without sessions, and only as a last resort present panes. Whatever left is
 * counted in `omitted`, merged with counts the source already reported.
 */
export function boundCatalogMaterial(source: FleetCatalogSourceMaterial, options: BoundOptions = {}): BoundedCatalog {
  const budget = options.budgetBytes ?? CATALOG_BODY_BUDGET_BYTES;
  const measure = options.measure ?? measureCatalogBody;
  const { omitted: seed, ...material } = source;

  let sessions: FleetCatalogSession[] = [...material.sessions].sort(byRecency);
  let projects: FleetCatalogProject[] = [...material.projects];
  let panes: FleetCatalogPane[] = presentFirst(material.panes);

  const omittedCounts = (): FleetCatalogOmitted | undefined => {
    const counts = {
      projects: (seed?.projects ?? 0) + material.projects.length - projects.length,
      sessions: (seed?.sessions ?? 0) + material.sessions.length - sessions.length,
      panes: (seed?.panes ?? 0) + material.panes.length - panes.length,
    };
    return counts.projects === 0 && counts.sessions === 0 && counts.panes === 0 ? undefined : counts;
  };
  const compose = (): FleetCatalogMaterial & { omitted?: FleetCatalogOmitted } => {
    const omitted = omittedCounts();
    return { ...material, projects, sessions, panes, ...(omitted === undefined ? {} : { omitted }) };
  };

  let size = measure(compose());
  while (size > budget) {
    const referenced = referencedProjectIds(sessions);
    const unreferencedUnstarred = projects.filter((project) => !referenced.has(project.localId) && !project.isStarred);
    if (unreferencedUnstarred.length > 0) {
      projects = projects.filter((project) => referenced.has(project.localId) || project.isStarred);
    } else if (panes.some((pane) => pane.presence !== 'present')) {
      panes = panes.filter((pane) => pane.presence === 'present');
    } else if (sessions.length > 0) {
      // Shrink proportionally so a multi-megabyte table converges in a few
      // passes, but always drop at least one session per pass.
      const keep = Math.min(sessions.length - 1, Math.floor(sessions.length * (budget / size) * 0.9));
      sessions = sessions.slice(0, Math.max(0, keep));
      const stillReferenced = referencedProjectIds(sessions);
      projects = projects.filter((project) => stillReferenced.has(project.localId) || project.isStarred);
    } else if (projects.length > 0) {
      projects = projects.slice(0, Math.max(0, projects.length - Math.max(1, Math.floor(projects.length / 2))));
    } else if (panes.length > 0) {
      panes = panes.slice(0, panes.length - 1);
    } else {
      break;
    }
    size = measure(compose());
  }

  const composed = compose();
  const { omitted, ...bounded } = composed;
  return omitted === undefined ? { material: bounded } : { material: bounded, omitted };
}
