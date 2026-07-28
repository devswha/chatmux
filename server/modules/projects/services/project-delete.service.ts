import { promises as fs } from 'node:fs';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

function normalizeJsonlPath(filePath: string): string {
  return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(filePath);
}

function uniqueJsonlPathsFromSessions(
  sessions: Array<{ jsonl_path: string | null }>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const row of sessions) {
    const raw = row.jsonl_path?.trim();
    if (!raw) {
      continue;
    }
    const absolute = normalizeJsonlPath(raw);
    if (seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    result.push(absolute);
  }

  return result;
}

async function unlinkJsonlIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

/**
 * Loads all session rows for the project path and removes each distinct `jsonl_path` file on disk.
 */
export async function deleteSessionJsonlFilesForProjectPath(projectPath: string): Promise<void> {
  const sessions = sessionsDb.getSessionsByProjectPath(projectPath);
  const paths = uniqueJsonlPathsFromSessions(sessions);
  const deletingSessionIds = new Set(sessions.map((session) => session.session_id));
  const deletingPaths = new Set(paths);
  const sharedOwner = sessionsDb.getAllSessions().find((session) => {
    const rawPath = session.jsonl_path?.trim();
    if (deletingSessionIds.has(session.session_id) || !rawPath) {
      return false;
    }
    return deletingPaths.has(normalizeJsonlPath(rawPath));
  });

  if (sharedOwner) {
    throw new AppError('A project transcript is shared with a session outside this project.', {
      code: 'PROJECT_TRANSCRIPT_SHARED',
      statusCode: 409,
    });
  }

  for (const filePath of paths) {
    await unlinkJsonlIfExists(filePath);
  }
}

/**
 * Permanently deletes a project, its session rows, and their transcript files.
 */
export async function deleteProject(projectId: string): Promise<void> {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  await deleteSessionJsonlFilesForProjectPath(row.project_path);
  sessionsDb.deleteSessionsByProjectPath(row.project_path);
  projectsDb.deleteProjectById(projectId);
}
