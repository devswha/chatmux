import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import type { CreateProjectPathResult, ProjectRepositoryRow } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';
import { revokeCompletionNotificationsForProject } from '@/modules/database/services/completion-notification-lifecycle.service.js';

type ProjectListOptions = {
    /** Hard result bound for UI/catalog consumers. Omit only for maintenance code. */
    limit?: number;
    /** Hide disposable projects under this root unless the user starred them. */
    excludePathRoot?: string;
};

function projectPathForId(projectId: string): string | null {
    const row = getConnection().prepare('SELECT project_path FROM projects WHERE project_id = ?')
        .get(projectId) as { project_path: string } | undefined;
    return row?.project_path ?? null;
}

function normalizeProjectDisplayName(projectPath: string, customProjectName: string | null): string {
    const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
    if (trimmedCustomName.length > 0) {
        return trimmedCustomName;
    }

    const directoryName = path.basename(projectPath);
    return directoryName || projectPath;
}

export const projectsDb = {
    createProjectPath(projectPath: string, customProjectName: string | null = null): CreateProjectPathResult {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
        const attemptedId = randomUUID();
        const row = db.prepare(`
        INSERT INTO projects (project_id, project_path, custom_project_name)
            VALUES (?, ?, ?)
            ON CONFLICT(project_path) DO NOTHING
            RETURNING project_id, project_path, custom_project_name, isStarred
        `).get(attemptedId, normalizedProjectPath, normalizedProjectName) as ProjectRepositoryRow | undefined;

        if (row) {
            return {
                outcome: 'created',
                project: row,
            };
        }

        const existingProject = projectsDb.getProjectPath(normalizedProjectPath);
        return {
            outcome: 'active_conflict',
            project: existingProject,
        };
    },

    getProjectPath(projectPath: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    getProjectById(projectId: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /**
     * Resolve the absolute project directory from a database project_id.
     *
     * This is the canonical lookup used after the projectName → projectId migration:
     * API routes receive the DB-assigned `projectId` and must resolve the real folder
     * path through this helper before touching the filesystem. Returns `null` when the
     * project row does not exist so callers can respond with a 404.
     */
    getProjectPathById(projectId: string): string | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_path
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as Pick<ProjectRepositoryRow, 'project_path'> | undefined;

        return row?.project_path ?? null;
    },

    getProjectPaths(options: ProjectListOptions = {}): ProjectRepositoryRow[] {
        const db = getConnection();
        const limit = options.limit === undefined
            ? null
            : Math.min(Math.max(1, Math.floor(options.limit)), 500);
        const excludedRoot = options.excludePathRoot
            ? normalizeProjectPath(options.excludePathRoot).replace(/[\\/]+$/, '')
            : null;
        const where = excludedRoot === null
            ? ''
            : `WHERE p.isStarred = 1
                 OR (p.project_path <> ? AND p.project_path NOT LIKE ? ESCAPE '\\')`;
        const excludedSeparator = excludedRoot?.includes('\\') ? '\\' : '/';
        const escapeLike = (value: string): string => value
            .replaceAll('\\', '\\\\')
            .replaceAll('%', '\\%')
            .replaceAll('_', '\\_');
        const parameters: Array<string | number> = excludedRoot === null
            ? []
            : [excludedRoot, `${escapeLike(`${excludedRoot}${excludedSeparator}`)}%`];
        const bounded = limit === null ? '' : 'LIMIT ?';
        if (limit !== null) parameters.push(limit);
        return db.prepare(`
            SELECT p.project_id, p.project_path, p.custom_project_name, p.isStarred
            FROM projects p
            LEFT JOIN (
                SELECT project_path, MAX(COALESCE(updated_at, created_at, '')) AS last_activity
                FROM sessions
                GROUP BY project_path
            ) activity ON activity.project_path = p.project_path
            ${where}
            ORDER BY p.isStarred DESC,
                     datetime(activity.last_activity) DESC,
                     p.project_path ASC
            ${bounded}
        `).all(...parameters) as ProjectRepositoryRow[];
    },

    getCustomProjectName(projectPath: string): string | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT custom_project_name
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as Pick<ProjectRepositoryRow, 'custom_project_name'> | undefined;

        return row?.custom_project_name ?? null;
    },

    updateCustomProjectName(projectPath: string, customProjectName: string | null): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            INSERT INTO projects (project_id, project_path, custom_project_name)
            VALUES (?, ?, ?)
            ON CONFLICT(project_path) DO UPDATE SET custom_project_name = excluded.custom_project_name
        `).run(randomUUID(), normalizedProjectPath, customProjectName);
    },

    updateCustomProjectNameById(projectId: string, customProjectName: string | null): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET custom_project_name = ?
            WHERE project_id = ?
        `).run(customProjectName, projectId);
    },

    updateProjectIsStarred(projectPath: string, isStarred: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_path = ?
        `).run(isStarred ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsStarredById(projectId: string, isStarred: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_id = ?
        `).run(isStarred ? 1 : 0, projectId);
    },


    deleteProjectPath(projectPath: string): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.transaction(() => {
            revokeCompletionNotificationsForProject(db, normalizedProjectPath);
            db.prepare(`
                DELETE FROM projects
                WHERE project_path = ?
            `).run(normalizedProjectPath);
        })();
    },

    deleteProjectById(projectId: string): void {
        const db = getConnection();
        db.transaction(() => {
            const projectPath = projectPathForId(projectId);
            if (projectPath) revokeCompletionNotificationsForProject(db, projectPath);
            db.prepare(`
                DELETE FROM projects
                WHERE project_id = ?
            `).run(projectId);
        })();
    },
};
