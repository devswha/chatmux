import type { LLMProvider, Project, ProjectSession } from '../../../types/app';

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
