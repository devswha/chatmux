import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type SessionSummary = {
  id: string;
  provider: string;
  summary: string;
  messageCount: number;
  lastActivity: string;
};

type SessionRepositoryRow = {
  provider: string;
  session_id: string;
  custom_name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};
type InitialProjectSessionRow = SessionRepositoryRow & {
  project_path: string | null;
  total: number;
};

export type ProjectListItem = {
  projectId: string;
  path: string;
  displayName: string;
  fullPath: string;
  isStarred: boolean;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};


type ProgressUpdate = {
  phase: 'loading' | 'complete';
  current: number;
  total: number;
  currentProject?: string;
};

type GetProjectsWithSessionsOptions = {
  skipSynchronization?: boolean;
  projectsLimit?: number;
  sessionsLimit?: number;
  sessionsOffset?: number;
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
};

type ProjectSessionsPageResult = {
  sessions: SessionSummary[];
  total: number;
  hasMore: boolean;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

const DEFAULT_PROJECT_SESSIONS_PAGE_SIZE = 20;
const MAX_PROJECT_SESSIONS_PAGE_SIZE = 200;
// Eager per-project session slice for the project LIST endpoint. Kept small so the
// initial /api/projects payload stays bounded even when a few heavy projects hold
// many sessions (real gjc data: top projects hold 80/60/49… sessions). The frontend
// lazy-loads the rest per project via getProjectSessionsPage + sessionMeta.hasMore.
const INITIAL_PROJECT_SESSIONS_PAGE_SIZE = 5;
export const DEFAULT_PROJECT_LIST_LIMIT = 100;
export const MAX_PROJECT_LIST_LIMIT = 200;

// generateDisplayName falls back to reading package.json from disk. The
// project list calls it once per project row (5k+ rows on a mature index),
// so results are cached briefly: a package.json rename still lands within a
// minute, without re-reading thousands of files on every /api/projects call.
const DISPLAY_NAME_CACHE_TTL_MS = 60_000;
const DISPLAY_NAME_CACHE_MAX_ENTRIES = 2_048;
const displayNameCache = new Map<string, { name: string; expiresAtMs: number }>();

// The project list loop used to broadcast one websocket frame per project,
// which meant thousands of frames per refresh for every connected client.
// Progress is now sampled on a wall-clock interval (completion always sends).
const PROGRESS_BROADCAST_INTERVAL_MS = 100;

/**
 * Generate better display name from path.
 */
export async function generateDisplayName(projectName: string, actualProjectDir: string | null = null): Promise<string> {
  const cacheKey = `${projectName}\u0000${actualProjectDir ?? ''}`;
  const nowMs = Date.now();
  const cached = displayNameCache.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.name;
  }

  const name = await resolveDisplayNameUncached(projectName, actualProjectDir);
  if (displayNameCache.size >= DISPLAY_NAME_CACHE_MAX_ENTRIES) {
    displayNameCache.clear();
  }
  displayNameCache.set(cacheKey, { name, expiresAtMs: nowMs + DISPLAY_NAME_CACHE_TTL_MS });
  return name;
}

async function resolveDisplayNameUncached(projectName: string, actualProjectDir: string | null): Promise<string> {
  // Use actual project directory if provided, otherwise decode from project name.
  const projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Try to read package.json from the project path.
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData) as { name?: string };

    // Return the name from package.json if it exists.
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch {
    // Fall back to path-based naming if package.json doesn't exist or can't be read.
  }

  // If it starts with /, it's an absolute path.
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name.
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}

function normalizeSessionPagination(options: SessionPaginationOptions = {}): { limit: number; offset: number } {
  const rawLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_PROJECT_SESSIONS_PAGE_SIZE;
  const rawOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;

  return {
    limit: Math.min(Math.max(1, rawLimit), MAX_PROJECT_SESSIONS_PAGE_SIZE),
    offset: Math.max(0, rawOffset),
  };
}

function mapSessionRowToSummary(row: SessionRepositoryRow): SessionSummary {
  return {
    id: row.session_id,
    provider: row.provider,
    summary: row.custom_name || '',
    messageCount: 0,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
  };
}


/**
 * Reads one paginated project session slice from the DB and groups rows by provider.
 */
function readProjectSessionsPageByPath(
  projectPath: string,
  options: SessionPaginationOptions = {},
): ProjectSessionsPageResult {
  const pagination = normalizeSessionPagination(options);
  const rows = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    pagination.limit,
    pagination.offset,
  ) as SessionRepositoryRow[];
  const total = sessionsDb.countSessionsByProjectPath(projectPath);

  return {
    sessions: rows.map(mapSessionRowToSummary),
    total,
    hasMore: pagination.offset + rows.length < total,
  };
}

// Broadcast progress to all connected WebSocket clients.
// Uses the unified `kind` envelope like every other websocket frame.
function broadcastProgress(progress: ProgressUpdate) {
  const message = JSON.stringify({
    kind: 'loading_progress',
    ...progress,
  });

  connectedClients.forEach((client: RealtimeClientConnection) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
}

/**
 * Reads all projects from DB and returns normalized session summaries.
 */
export async function getProjectsWithSessions(
  options: GetProjectsWithSessionsOptions = {}
): Promise<ProjectListItem[]> {
  if (!options.skipSynchronization) {
    await sessionSynchronizerService.synchronizeSessions();
  }

  const projectsLimit = Math.min(
    Math.max(1, options.projectsLimit ?? DEFAULT_PROJECT_LIST_LIMIT),
    MAX_PROJECT_LIST_LIMIT,
  );
  const projectRows = projectsDb.getProjectPaths({
    limit: projectsLimit,
    excludePathRoot: os.tmpdir(),
  }) as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;
  const totalProjects = projectRows.length;
  const projects: ProjectListItem[] = [];
  const initialSessionsLimit = Math.min(
    Math.max(1, options.sessionsLimit ?? INITIAL_PROJECT_SESSIONS_PAGE_SIZE),
    MAX_PROJECT_SESSIONS_PAGE_SIZE,
  );
  const initialSessionRows = sessionsDb.getInitialSessionPagesByProject(
    initialSessionsLimit,
    projectRows.map((project) => project.project_path),
  ) as InitialProjectSessionRow[];
  const initialSessionsByProject = new Map<string, ProjectSessionsPageResult>();

  for (const sessionRow of initialSessionRows) {
    if (!sessionRow.project_path) {
      continue;
    }

    const page = initialSessionsByProject.get(sessionRow.project_path) ?? {
      sessions: [],
      total: sessionRow.total,
      hasMore: sessionRow.total > initialSessionsLimit,
    };
    page.sessions.push(mapSessionRowToSummary(sessionRow));
    initialSessionsByProject.set(sessionRow.project_path, page);
  }
  let processedProjects = 0;
  let lastProgressBroadcastAtMs = 0;

  for (const row of projectRows) {
    processedProjects += 1;

    const projectId = row.project_id;
    const projectPath = row.project_path;

    const progressNowMs = Date.now();
    if (progressNowMs - lastProgressBroadcastAtMs >= PROGRESS_BROADCAST_INTERVAL_MS) {
      lastProgressBroadcastAtMs = progressNowMs;
      broadcastProgress({
        phase: 'loading',
        current: processedProjects,
        total: totalProjects,
        currentProject: projectPath,
      });
    }

    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : options.skipSynchronization
          ? path.basename(projectPath) || projectPath
          : await generateDisplayName(path.basename(projectPath) || projectPath, projectPath);

    const sessionsPage = options.sessionsOffset && options.sessionsOffset > 0
      ? readProjectSessionsPageByPath(projectPath, {
          limit: initialSessionsLimit,
          offset: options.sessionsOffset,
        })
      : initialSessionsByProject.get(projectPath) ?? {
          sessions: [],
          total: 0,
          hasMore: false,
        };

    projects.push({
      projectId,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred: Boolean(row.isStarred),
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    });
  }

  broadcastProgress({
    phase: 'complete',
    current: totalProjects,
    total: totalProjects,
  });

  return projects;
}


/**
 * Loads one paginated session slice for a specific project id.
 */
export async function getProjectSessionsPage(
  projectId: string,
  options: SessionPaginationOptions = {},
): Promise<ProjectSessionsPageApiView> {
  const projectRow = projectsDb.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const sessionsPage = readProjectSessionsPageByPath(projectRow.project_path, options);
  return {
    projectId: projectRow.project_id,
    sessions: sessionsPage.sessions,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
    },
  };
}
