import { projectsDb } from '@/modules/database/index.js';

type UpdateProjectDisplayNameDependencies = Pick<typeof projectsDb, 'updateCustomProjectNameById'>;

/**
 * Sets `projects.custom_project_name` for the given `projectId` (or clears it when empty).
 */
export function updateProjectDisplayName(
  projectId: string,
  newDisplayName: unknown,
  dependencies: UpdateProjectDisplayNameDependencies = projectsDb,
): void {
  const trimmed = typeof newDisplayName === 'string' ? newDisplayName.trim() : '';
  dependencies.updateCustomProjectNameById(projectId, trimmed.length > 0 ? trimmed : null);
}
