import type { LLMProvider, Project, ProjectSession } from '../../../types/app';
import type { SettingsProject } from '../types/types';

const getCreatedTimestamp = (session: ProjectSession): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: ProjectSession): string => {
  return String(session.lastActivity || '');
};

const getSessionDate = (session: ProjectSession): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : 'claude';
};

export const getSessionTime = (session: ProjectSession): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

export const getAllSessions = (project: Project): ProjectSession[] => {
  return (project.sessions || []).map((session) => ({
    ...session,
    __provider: getSessionProvider(session),
  })).sort(
    (a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime(),
  );
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};
