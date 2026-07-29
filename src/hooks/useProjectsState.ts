import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { api } from '../utils/api';
import { isLiveTmuxActionable } from '../utils/liveSessions';
import type { ServerEvent } from '../contexts/WebSocketContext';
import type {
  AppTab,
  LLMProvider,
  Project,
  ProjectSession,
} from '../types/app';
import { tmuxPaneIdentityKey, type TmuxPaneTarget } from '../../shared/tmux';

import { useDiscoveryStream, type DiscoveryRow } from './useDiscoveryStream';
import type { SessionActivityMap } from './useSessionProtection';
import {
  mergeExpandedSessionPages,
  normalizeSessionProvider,
  projectFromRegistration,
  projectsHaveChanges,
  upsertSessionIntoProject,
  type SessionUpsertedEvent,
} from './projectsStateMerge';

type UseProjectsStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
  /** Subscription to the unified websocket event stream. */
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  sendMessage: (message: unknown) => void;
  isConnected: boolean;
  isMobile: boolean;
  activeSessions: SessionActivityMap;
};


type FetchProjectsOptions = {
  showLoadingState?: boolean;
};

type RegisterOptimisticSessionArgs = {
  sessionId: string;
  provider: LLMProvider;
  project: Project;
  summary?: string | null;
};


const DEFAULT_PROVIDER: LLMProvider = 'claude';

const serialize = (value: unknown) => JSON.stringify(value ?? null);

const getProjectSessions = (project: Project): ProjectSession[] => project.sessions ?? [];

const readSelectedProvider = (): LLMProvider => {
  try {
    const storedProvider = localStorage.getItem('selected-provider');
    return storedProvider ? storedProvider as LLMProvider : DEFAULT_PROVIDER;
  } catch {
    return DEFAULT_PROVIDER;
  }
};


const VALID_TABS: Set<string> = new Set(['chat']);

const isValidTab = (tab: string): tab is AppTab => {
  return VALID_TABS.has(tab);
};

export const normalizePersistedTab = (stored: string | null): AppTab =>
  stored && isValidTab(stored) ? stored : 'chat';

const readPersistedTab = (): AppTab => {
  try {
    return normalizePersistedTab(localStorage.getItem('activeTab'));
  } catch {
    // localStorage unavailable
  }
  return 'chat';
};

export function useProjectsState({
  sessionId,
  navigate,
  subscribe,
  isConnected,
  sendMessage,
  isMobile,
  activeSessions,
}: UseProjectsStateArgs) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null);
  const [liveSessionIds, setLiveSessionIds] = useState<Set<string>>(new Set());
  const [liveSessionNames, setLiveSessionNames] = useState<Map<string, string>>(new Map());
  const [liveSessionModels, setLiveSessionModels] = useState<Map<string, string>>(new Map());
  const [liveSessionEfforts, setLiveSessionEfforts] = useState<Map<string, string>>(new Map());
  // Session ids whose tmux name is a LINEAGE claim (gjc runs inside that tmux
  // session). Only these may carry tmux actions (kill/relay) — cwd-fallback
  // labels killed an unrelated claude tmux session (patina 실사고).
  const [liveSessionLineage, setLiveSessionLineage] = useState<Set<string>>(new Set());
  // Foreground-command classification per live id ('interactive' | 'batch'):
  // a batch gjc descendant under a shell is badged apart from an interactive
  // gjc TUI. Presentational only — never gates tmux actions.
  const [liveSessionKinds, setLiveSessionKinds] = useState<Map<string, string>>(new Map());
  // Session ids whose transcript tail shows a turn in progress (assistant
  // answering / tool loop). Presentational only — drives the RUN badge.
  const [liveSessionRunning, setLiveSessionRunning] = useState<Set<string>>(new Set());
  // Exact pane and process generation per actionable live row.
  const [liveSessionTargets, setLiveSessionTargets] = useState<Map<string, TmuxPaneTarget>>(new Map());
  // False until the first live poll settles, so the sidebar shows a loading
  // state instead of a false "no sessions" during the initial fetch.
  const [liveSessionsLoaded, setLiveSessionsLoaded] = useState(false);
  const liveRestMetadataRef = useRef(new Map<string, {
    id: string;
    model?: string;
    effort?: string;
    claim?: string;
    kind?: string;
    running?: boolean;
  }>());
  const liveRowsRef = useRef<DiscoveryRow[] | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>(readPersistedTab);

  useEffect(() => {
    try {
      localStorage.setItem('activeTab', activeTab);
    } catch {
      // Silently ignore storage errors
    }
  }, [activeTab]);

  const applyLiveRows = useCallback((rows: DiscoveryRow[]) => {
    liveRowsRef.current = rows;
    const names = new Map<string, string>();
    const targets = new Map<string, TmuxPaneTarget>();
    const models = new Map<string, string>();
    const efforts = new Map<string, string>();
    const lineage = new Set<string>();
    const kinds = new Map<string, string>();
    const runningIds = new Set<string>();
    for (const row of rows) {
      if (row.lane !== 'live') continue;
      const metadata = liveRestMetadataRef.current.get(tmuxPaneIdentityKey(row.tmux));
      const sessionId = metadata?.id ?? row.providerSessionId;
      if (!sessionId) continue;
      names.set(sessionId, row.tmuxName);
      if (row.process) targets.set(sessionId, { tmux: row.tmux, process: row.process });
      if (typeof metadata?.model === 'string') models.set(sessionId, metadata.model);
      if (typeof metadata?.effort === 'string') efforts.set(sessionId, metadata.effort);
      if (isLiveTmuxActionable(row, metadata?.claim)) lineage.add(sessionId);
      if (typeof metadata?.kind === 'string') kinds.set(sessionId, metadata.kind);
      if (row.activity === 'running' || metadata?.running === true) runningIds.add(sessionId);
    }
    setLiveSessionIds(new Set(names.keys()));
    setLiveSessionNames(names);
    setLiveSessionTargets(targets);
    setLiveSessionModels(models);
    setLiveSessionEfforts(efforts);
    setLiveSessionLineage(lineage);
    setLiveSessionKinds(kinds);
    setLiveSessionRunning(runningIds);
    setLiveSessionsLoaded(true);
  }, []);
  const streamHealthy = useDiscoveryStream({
    lanes: ['external', 'live'],
    isConnected,
    sendMessage,
    subscribe,
    onRows: applyLiveRows,
  });
  const applyLiveRestSessions = useCallback((sessions: Array<{
    id?: unknown; tmuxName?: unknown; tmux?: unknown; process?: unknown; model?: unknown;
    effort?: unknown; claim?: unknown; kind?: unknown; running?: unknown;
  }>) => {
    const names = new Map<string, string>();
    const targets = new Map<string, TmuxPaneTarget>();
    const models = new Map<string, string>();
    const efforts = new Map<string, string>();
    const lineage = new Set<string>();
    const kinds = new Map<string, string>();
    const running = new Set<string>();
    const metadata = new Map<string, {
      id: string; model?: string; effort?: string; claim?: string; kind?: string; running?: boolean;
    }>();
    for (const session of sessions) {
      if (typeof session.id !== 'string') continue;
      if (session.tmux && typeof session.tmux === 'object') {
        metadata.set(tmuxPaneIdentityKey(session.tmux as TmuxPaneTarget['tmux']), {
          id: session.id,
          model: typeof session.model === 'string' ? session.model : undefined,
          effort: typeof session.effort === 'string' ? session.effort : undefined,
          claim: typeof session.claim === 'string' ? session.claim : undefined,
          kind: typeof session.kind === 'string' ? session.kind : undefined,
          running: session.running === true,
        });
      }
      if (typeof session.tmuxName === 'string') names.set(session.id, session.tmuxName);
      if (session.tmux && session.process) targets.set(session.id, { tmux: session.tmux as TmuxPaneTarget['tmux'], process: session.process as TmuxPaneTarget['process'] });
      if (typeof session.model === 'string') models.set(session.id, session.model);
      if (typeof session.effort === 'string') efforts.set(session.id, session.effort);
      if (session.claim === 'lineage') lineage.add(session.id);
      if (typeof session.kind === 'string') kinds.set(session.id, session.kind);
      if (session.running === true) running.add(session.id);
    }
    liveRestMetadataRef.current = metadata;
    if (liveRowsRef.current !== null) {
      applyLiveRows(liveRowsRef.current);
      return;
    }
    setLiveSessionIds(new Set(sessions.flatMap((session) => typeof session.id === 'string' ? [session.id] : [])));
    setLiveSessionNames(names);
    setLiveSessionTargets(targets);
    setLiveSessionModels(models);
    setLiveSessionEfforts(efforts);
    setLiveSessionLineage(lineage);
    setLiveSessionKinds(kinds);
    setLiveSessionRunning(running);
  }, [applyLiveRows]);
  const loadLiveSessions = useCallback(async () => {
    const response = await api.liveSessions();
    if (!response.ok) return;
    const body = await response.json();
    applyLiveRestSessions((body?.data?.liveSessions ?? body?.liveSessions ?? []) as Array<{
      id?: unknown; tmuxName?: unknown; tmux?: unknown; process?: unknown; model?: unknown;
      effort?: unknown; claim?: unknown; kind?: unknown; running?: unknown;
    }>);
  }, [applyLiveRestSessions]);
  useEffect(() => {
    let cancelled = false;
    void loadLiveSessions()
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLiveSessionsLoaded(true); });
    return () => { cancelled = true; };
  }, [loadLiveSessions]);

  useEffect(() => {
    if (streamHealthy) return undefined;
    let cancelled = false;
    const poll = () => {
      void loadLiveSessions()
        .catch(() => undefined)
        .finally(() => { if (!cancelled) setLiveSessionsLoaded(true); });
    };
    const timer = window.setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadLiveSessions, streamHealthy]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);
  /**
   * `newSessionTrigger` is an explicit, monotonic intent signal for user-driven
   * New Session actions.
   *
   * It exists because `handleNewSession` can be invoked while the app is already in
   * the same visible state (`selectedSession === null`, `activeTab === 'chat'`,
   * route already `/`). In that case, React/router updates are idempotent and no
   * downstream reset logic runs.
   *
   * Usage across the codebase:
   * 1) Produced here in `handleNewSession` via increment (always changes).
   * 2) Returned from this hook and threaded through:
   *    useProjectsState -> AppContent -> MainContent -> ChatInterface.
   * 3) Consumed in `useChatSessionState` as an effect dependency to forcibly clear
   *    chat-local state (`currentSessionId`, pending draft message, streaming flags,
   *    pending session storage keys, pagination/scroll artifacts).
   *
   * Keeping this signal dedicated avoids coupling resets to unrelated counters/events
   * (for example websocket/project refresh updates) that could cause accidental resets.
   */
  const [newSessionTrigger, setNewSessionTrigger] = useState(0);

  /**
   * Ref mirrors for state the websocket subscription handler needs.
   *
   * The subscription is registered once (per `subscribe` identity) and events
   * are dispatched synchronously outside React's render cycle, so the handler
   * must read the latest values through refs instead of stale closures —
   * re-subscribing on every state change would risk missing events.
   */
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const selectedProjectRef = useRef(selectedProject);
  selectedProjectRef.current = selectedProject;
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const activeSessionsRef = useRef(activeSessions);
  activeSessionsRef.current = activeSessions;
  const sidebarRefreshGenerationRef = useRef(0);


  const fetchProjects = useCallback(async ({ showLoadingState = true }: FetchProjectsOptions = {}) => {
    try {
      if (showLoadingState) {
        setIsLoadingProjects(true);
      }
      const response = await api.projects();
      const projectData = (await response.json()) as Project[];

      setProjects((prevProjects) => {
        const mergedProjects = mergeExpandedSessionPages(prevProjects, projectData);

        if (prevProjects.length === 0) {
          return mergedProjects;
        }

        return projectsHaveChanges(prevProjects, mergedProjects)
          ? mergedProjects
          : prevProjects;
      });
    } catch (error) {
      console.error('Error fetching projects:', error);
    } finally {
      if (showLoadingState) {
        setIsLoadingProjects(false);
      }
    }
  }, []);

  const refreshProjectsSilently = useCallback(async () => {
    // Keep chat view stable while still syncing sidebar/session metadata in background.
    await fetchProjects({ showLoadingState: false });
  }, [fetchProjects]);

  const registerOptimisticSession = useCallback(({
    sessionId: newSessionId,
    provider,
    project,
    summary,
  }: RegisterOptimisticSessionArgs) => {
    if (!newSessionId || !project?.projectId) {
      return;
    }

    const now = new Date().toISOString();
    const optimisticSession: ProjectSession = {
      id: newSessionId,
      summary: summary ?? '',
      messageCount: 0,
      createdAt: now,
      created_at: now,
      updated_at: now,
      lastActivity: now,
      __provider: provider,
      __projectId: project.projectId,
    };
    const upsert: SessionUpsertedEvent = {
      kind: 'session_upserted',
      sessionId: newSessionId,
      provider,
      session: optimisticSession,
      project: {
        projectId: project.projectId,
        path: project.path || project.fullPath,
        fullPath: project.fullPath || project.path || '',
        displayName: project.displayName,
        isStarred: Boolean(project.isStarred),
      },
      timestamp: now,
    };

    setProjects((previousProjects) => {
      const existingProject = previousProjects.find((candidate) => candidate.projectId === project.projectId);
      if (!existingProject) {
        return [upsertSessionIntoProject(projectFromRegistration(project), upsert), ...previousProjects];
      }

      const updatedProject = upsertSessionIntoProject(existingProject, upsert);
      if (updatedProject === existingProject) {
        return previousProjects;
      }

      return previousProjects.map((candidate) =>
        candidate.projectId === existingProject.projectId ? updatedProject : candidate,
      );
    });

    setSelectedProject((previousProject) => {
      if (!previousProject || previousProject.projectId !== project.projectId) {
        return previousProject;
      }

      const updatedProject = upsertSessionIntoProject(previousProject, upsert);
      return updatedProject === previousProject ? previousProject : updatedProject;
    });

    setSelectedSession((previousSession) => (
      previousSession?.id === newSessionId
        ? { ...previousSession, ...optimisticSession }
        : optimisticSession
    ));
  }, []);


  const openSettings = useCallback((tab = 'tools') => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);


  // Auto-select the project when there is only one, so the user lands on the new session page
  useEffect(() => {
    if (!isLoadingProjects && projects.length === 1 && !selectedProject && !sessionId) {
      setSelectedProject(projects[0]);
    }
  }, [isLoadingProjects, projects, selectedProject, sessionId]);

  // Realtime sidebar updates. The backend pushes per-session deltas
  // (`session_upserted`) instead of full project snapshots, so each event is
  // a keyed upsert that can never clobber unrelated client state — no
  // "suppress updates while a run is active" protection is needed anymore.
  useEffect(() => {
    const handleEvent = (event: ServerEvent) => {


      if (event.kind !== 'session_upserted') {
        return;
      }

      const upsert = event as SessionUpsertedEvent;
      if (!upsert.sessionId || !upsert.session) {
        return;
      }

      // The transcript of the currently viewed session changed on disk while
      // no run is active here (e.g. edited from another client or the CLI):
      // signal the chat view to reload its messages.
      const currentSelectedSession = selectedSessionRef.current;
      if (
        currentSelectedSession
        && upsert.sessionId === currentSelectedSession.id
        && !activeSessionsRef.current.has(upsert.sessionId)
      ) {
        setExternalMessageUpdate((prev) => prev + 1);
      }

      setProjects((previousProjects) => {
        const targetProjectId = upsert.project?.projectId;
        const existingProject = previousProjects.find((project) =>
          targetProjectId ? project.projectId === targetProjectId : getProjectSessions(project).some((session) => session.id === upsert.sessionId),
        );

        if (!existingProject) {
          // First session of a project this client has never seen: create the
          // project entry from the event payload.
          if (!upsert.project) {
            return previousProjects;
          }

          const newProject: Project = {
            projectId: upsert.project.projectId,
            path: upsert.project.path,
            fullPath: upsert.project.fullPath,
            displayName: upsert.project.displayName,
            isStarred: upsert.project.isStarred,
            sessions: [],
            sessionMeta: { hasMore: false, total: 0 },
          } as Project;

          return [...previousProjects, upsertSessionIntoProject(newProject, upsert)];
        }

        const updatedProject = upsertSessionIntoProject(existingProject, upsert);
        if (updatedProject === existingProject) {
          return previousProjects;
        }

        return previousProjects.map((project) =>
          project.projectId === existingProject.projectId ? updatedProject : project,
        );
      });

      // Keep the selected project reference in sync with the upsert.
      setSelectedProject((previousProject) => {
        if (!previousProject) {
          return previousProject;
        }
        const matches = upsert.project
          ? previousProject.projectId === upsert.project.projectId
          : getProjectSessions(previousProject).some((session) => session.id === upsert.sessionId);
        if (!matches) {
          return previousProject;
        }
        const updated = upsertSessionIntoProject(previousProject, upsert);
        return updated === previousProject ? previousProject : updated;
      });

      const aliasedSelectedSessionId =
        typeof upsert.providerSessionId === 'string' && upsert.providerSessionId !== upsert.sessionId
          ? upsert.providerSessionId
          : null;
      if (!aliasedSelectedSessionId) {
        return;
      }

      const normalizedSelectedSession: ProjectSession = {
        ...upsert.session,
        id: upsert.sessionId,
        __provider: upsert.provider,
        __projectId: upsert.project?.projectId ?? currentSelectedSession?.__projectId,
      };

      setSelectedSession((previousSession) => {
        if (previousSession?.id !== aliasedSelectedSessionId) {
          return previousSession;
        }

        return {
          ...previousSession,
          ...normalizedSelectedSession,
        };
      });

      if (sessionId === aliasedSelectedSessionId) {
        navigate(`/session/${upsert.sessionId}`);
      }
    };

    return subscribe(handleEvent);
  }, [navigate, sessionId, subscribe]);



  useEffect(() => {
    if (!sessionId || projects.length === 0) {
      return;
    }

    // Project membership is resolved through `projectId` after the migration.
    for (const project of projects) {
      const match = project.sessions?.find((session) => session.id === sessionId);
      if (match) {
        const normalizedSession = normalizeSessionProvider(match);
        const shouldUpdateProject = selectedProject?.projectId !== project.projectId;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== normalizedSession.__provider;

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession(normalizedSession);
        }
        return;
      }
    }

    // Session id is in the URL but not yet present on any project payload
    // (normal for a brand-new conversation: the composer allocates the id and
    // navigates before the sidebar learns about the session via
    // `session_upserted`). Without a `selectedSession`, chat state clears
    // `currentSessionId` and the UI stops reading the session store even
    // though messages stream under this id — so synthesize a placeholder.
    if (selectedSession?.id === sessionId) {
      return;
    }

    // Synthetic idle fleet rows (`idle-gjc:<tmux>`) are not sessions: no
    // transcript, no provider — a placeholder here would become a writable
    // fake session once the idle row disappears (리뷰 반영). Never route them.
    if (sessionId.startsWith('idle-gjc:')) {
      return;
    }

    // Only the currently selected project may host the placeholder. Guessing
    // another project (e.g. "first one with sessions") could bind the URL
    // session to the wrong project — better to wait until the owning project
    // arrives in a later `projects` payload and is matched by the loop above.
    if (!selectedProject) {
      return;
    }

    setSelectedSession({
      id: sessionId,
      __provider: readSelectedProvider(),
      __projectId: selectedProject.projectId,
      summary: '',
    });
  }, [sessionId, projects, selectedProject, selectedSession?.id, selectedSession?.__provider]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession, projectId?: string) => {
      // Live sessions open read-only (composer hidden in the chat view), so opening
      // one can't cause driver duplication — no confirmation needed.
      const selected = projectId && session.__projectId !== projectId
        ? { ...session, __projectId: projectId }
        : session;
      setSelectedSession(selected);

      if (isMobile) {
        // Collapse after navigation when the selected session belongs to a
        // different project.
        const currentProjectId = selectedProject?.projectId;

        if (selected.__projectId !== currentProjectId) {
          setSidebarOpen(false);
        }
      }

      navigate(`/session/${selected.id}`);
    },
    [isMobile, navigate, selectedProject?.projectId],
  );

  const handleNewSession = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      setActiveTab('chat');
      setNewSessionTrigger((previous) => previous + 1);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );


  const handleSidebarRefresh = useCallback(async () => {
    const refreshGeneration = ++sidebarRefreshGenerationRef.current;

    try {
      const response = await api.projects();
      const freshProjects = (await response.json()) as Project[];
      if (refreshGeneration !== sidebarRefreshGenerationRef.current) {
        return;
      }

      const mergedProjects = mergeExpandedSessionPages(projectsRef.current, freshProjects);
      setProjects((previousProjects) => {
        const nextProjects = mergeExpandedSessionPages(previousProjects, freshProjects);
        return projectsHaveChanges(previousProjects, nextProjects) ? nextProjects : previousProjects;
      });

      const selectedProjectSnapshot = selectedProjectRef.current;
      const selectedSessionSnapshot = selectedSessionRef.current;
      if (!selectedProjectSnapshot) {
        return;
      }

      const refreshedProject = mergedProjects.find(
        (project) => project.projectId === selectedProjectSnapshot.projectId,
      );
      if (!refreshedProject) {
        setSelectedProject((current) =>
          current?.projectId === selectedProjectSnapshot.projectId ? null : current,
        );
        if (selectedSessionSnapshot) {
          setSelectedSession((current) =>
            current?.id === selectedSessionSnapshot.id ? null : current,
          );
          if (sessionIdRef.current === selectedSessionSnapshot.id) {
            navigate('/');
          }
        }
        return;
      }

      setSelectedProject((current) => {
        if (current?.projectId !== selectedProjectSnapshot.projectId) {
          return current;
        }
        return serialize(refreshedProject) !== serialize(current) ? refreshedProject : current;
      });

      if (!selectedSessionSnapshot) {
        return;
      }

      const sessionResponse = await api.sessionDetails(selectedSessionSnapshot.id);
      if (
        refreshGeneration !== sidebarRefreshGenerationRef.current
        || selectedProjectRef.current?.projectId !== selectedProjectSnapshot.projectId
        || selectedSessionRef.current?.id !== selectedSessionSnapshot.id
      ) {
        return;
      }

      if (sessionResponse.status === 404) {
        setSelectedSession((current) =>
          current?.id === selectedSessionSnapshot.id ? null : current,
        );
        if (sessionIdRef.current === selectedSessionSnapshot.id) {
          navigate('/');
        }
        return;
      }

      const refreshedSession = getProjectSessions(refreshedProject).find(
        (session) => session.id === selectedSessionSnapshot.id,
      );
      if (!refreshedSession) {
        return;
      }

      setSelectedSession((current) => {
        if (current?.id !== selectedSessionSnapshot.id) {
          return current;
        }

        const normalizedRefreshedSession = {
          ...refreshedSession,
          __provider: refreshedSession.__provider ?? current.__provider,
          __projectId: refreshedSession.__projectId ?? current.__projectId,
        };
        return serialize(normalizedRefreshedSession) !== serialize(current)
          ? normalizedRefreshedSession
          : current;
      });
    } catch (error) {
      console.error('Error refreshing sidebar:', error);
    }
  }, [navigate]);


  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedSession,
      liveSessionIds,
      liveSessionNames,
      liveSessionEfforts,
      liveSessionModels,
      liveSessionLineage,
      liveSessionTargets,
      liveSessionKinds,
      liveSessionRunning,
      liveSessionsLoaded,
      onProjectSelect: handleProjectSelect,
      onSessionSelect: handleSessionSelect,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => setShowSettings(true),
      showSettings,
      settingsInitialTab,
      onCloseSettings: () => setShowSettings(false),
      isMobile,
    }),
    [
      liveSessionIds,
      liveSessionNames,
      liveSessionEfforts,
      liveSessionModels,
      liveSessionLineage,
      liveSessionTargets,
      liveSessionKinds,
      liveSessionRunning,
      liveSessionsLoaded,
      handleProjectSelect,
      handleSessionSelect,
      handleSidebarRefresh,
      isMobile,
      projects,
      settingsInitialTab,
      selectedSession,
      showSettings,
    ],
  );

  return {
    projects,
    selectedProject,
    selectedSession,
    liveSessionModels,
    liveSessionEfforts,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    isInputFocused,
    showSettings,
    settingsInitialTab,
    externalMessageUpdate,
    newSessionTrigger,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    fetchProjects,
    refreshProjectsSilently,
    registerOptimisticSession,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSidebarRefresh,
  };
}
