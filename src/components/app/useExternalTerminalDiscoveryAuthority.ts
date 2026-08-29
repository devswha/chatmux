/**
 * Discovery-driven authority for the open external terminal: discovery snapshots
 * and deltas re-open or repair the viewed external target when the authoritative
 * roster changes. Split from the former `AppContent.tsx`.
 */

import { useEffect, type Dispatch, type SetStateAction } from 'react';

import type { ServerEvent } from '../../contexts/WebSocketContext';
import type { ExternalTerminalTarget, Project, ProjectSession } from '../../types/app';
import { api } from '../../utils/api';
import {
  findGjcPromotionCandidate,
  hasGjcTerminalTarget,
  readRestSessionContainer,
} from '../../utils/liveSessions';
import type { ExternalCliSession } from '../sidebar/hooks/useExternalCliSessions';

import {
  isSameExternalTerminal,
  refreshExternalTerminalAttachCapability,
} from './externalTerminalRouting';

type DiscoveryAuthorityOptions = {
  externalTerminal: ExternalTerminalTarget | null;
  setExternalTerminal: Dispatch<SetStateAction<ExternalTerminalTarget | null>>;
  setExternalTranscript: Dispatch<SetStateAction<ExternalTerminalTarget | null>>;
  openExternalTerminal: (target: ExternalTerminalTarget) => void;
  setActiveTab: (tab: 'chat') => void;
  sidebarSharedProps: {
    projects: readonly Project[];
    onProjectSelect: (project: Project) => unknown;
    onSessionSelect: (session: ProjectSession) => unknown;
  };
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
};

export function isRemoteExternalTarget(target: ExternalTerminalTarget | null): boolean {
  return target?.hostId !== undefined;
}

export function useExternalTerminalDiscoveryAuthority({
  externalTerminal,
  setExternalTerminal,
  setExternalTranscript,
  openExternalTerminal,
  setActiveTab,
  sidebarSharedProps,
  subscribe,
}: DiscoveryAuthorityOptions): void {
  useEffect(() => {
    if (
      !externalTerminal
      || isRemoteExternalTarget(externalTerminal)
      || externalTerminal.cliKind === 'gjc'
      || externalTerminal.cliKind === 'ssh'
      || externalTerminal.cliKind === 'shell'
      || externalTerminal.transcriptSessionId
      || externalTerminal.forceAttach
    ) return undefined;
    const target = externalTerminal;
    let cancelled = false;
    let requestGeneration = 0;
    let appliedGeneration = 0;
    let activeController: AbortController | null = null;
    const invalidateTarget = () => {
      setExternalTerminal((current) => (
        isSameExternalTerminal(current, target) ? null : current
      ));
    };
    const poll = async () => {
      const generation = ++requestGeneration;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      try {
        const response = await api.externalSessions(controller.signal);
        if (
          cancelled
          || controller.signal.aborted
          || generation !== requestGeneration
          || generation <= appliedGeneration
        ) return;
        if (!response.ok) {
          appliedGeneration = generation;
          invalidateTarget();
          return;
        }

        const body = await response.json();
        if (
          cancelled
          || controller.signal.aborted
          || generation !== requestGeneration
          || generation <= appliedGeneration
        ) return;
        appliedGeneration = generation;
        const container = readRestSessionContainer(body, 'externalSessions');
        if (!container?.discoveryOk) {
          invalidateTarget();
          return;
        }
        const sessions = container.sessions as ExternalCliSession[];

        const refreshed = refreshExternalTerminalAttachCapability(target, sessions);
        if (!refreshed) {
          invalidateTarget();
          return;
        }
        if ('transcriptSessionId' in refreshed && refreshed.transcriptSessionId) {
          openExternalTerminal(refreshed);
        }
      } catch {
        if (
          !cancelled
          && !controller.signal.aborted
          && generation === requestGeneration
          && generation > appliedGeneration
        ) {
          appliedGeneration = generation;
          invalidateTarget();
        }
      }
    };
    void poll();
    const unsubscribe = subscribe((event) => {
      if (event.kind === 'discovery.snapshot' || event.kind === 'discovery.delta') void poll();
    });
    return () => {
      cancelled = true;
      activeController?.abort();
      unsubscribe();
    };
  }, [externalTerminal, openExternalTerminal, setExternalTerminal, subscribe]);

  useEffect(() => {
    if (externalTerminal?.cliKind !== 'gjc' || isRemoteExternalTarget(externalTerminal)) return undefined;
    const target = externalTerminal;
    let cancelled = false;
    let requestGeneration = 0;
    let appliedGeneration = 0;
    let activeController: AbortController | null = null;
    const invalidateTarget = () => {
      setExternalTerminal((current) => (
        isSameExternalTerminal(current, target) ? null : current
      ));
    };
    const poll = async () => {
      const generation = ++requestGeneration;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      try {
        const response = await api.liveSessions(controller.signal);
        if (
          cancelled
          || controller.signal.aborted
          || generation !== requestGeneration
          || generation <= appliedGeneration
        ) return;
        if (!response.ok) {
          appliedGeneration = generation;
          invalidateTarget();
          return;
        }

        const body = await response.json();
        if (
          cancelled
          || controller.signal.aborted
          || generation !== requestGeneration
          || generation <= appliedGeneration
        ) return;
        appliedGeneration = generation;
        const container = readRestSessionContainer(body, 'liveSessions');
        if (!container?.discoveryOk) {
          invalidateTarget();
          return;
        }
        const sessions = container.sessions as Parameters<typeof hasGjcTerminalTarget>[0];
        if (!hasGjcTerminalTarget(sessions, target)) {
          invalidateTarget();
          return;
        }

        const ready = findGjcPromotionCandidate(sessions, target);
        if (!ready) return;

        const detailsResponse = await api.sessionDetails(ready.id);
        const detailsBody = await detailsResponse.json().catch(() => null);
        const session = detailsBody?.data?.session as {
          sessionId?: unknown;
          provider?: unknown;
          summary?: unknown;
          projectId?: unknown;
          createdAt?: unknown;
          updatedAt?: unknown;
        } | undefined;
        const projectId = typeof session?.projectId === 'string' ? session.projectId : '';
        const project = sidebarSharedProps.projects.find((candidate) => candidate.projectId === projectId);
        if (
          cancelled
          || controller.signal.aborted
          || generation !== requestGeneration
          || generation !== appliedGeneration
          || !detailsResponse.ok
          || session?.sessionId !== ready.id
          || session.provider !== 'gjc'
          || !project
        ) return;

        setExternalTerminal(null);
        setExternalTranscript(null);
        setActiveTab('chat');
        sidebarSharedProps.onProjectSelect(project);
        sidebarSharedProps.onSessionSelect({
          id: ready.id,
          summary: typeof session.summary === 'string' ? session.summary : '',
          createdAt: typeof session.createdAt === 'string' ? session.createdAt : undefined,
          updated_at: typeof session.updatedAt === 'string' ? session.updatedAt : undefined,
          __provider: 'gjc',
          __projectId: project.projectId,
        });
      } catch {
        if (
          !cancelled
          && !controller.signal.aborted
          && generation === requestGeneration
          && generation > appliedGeneration
        ) {
          appliedGeneration = generation;
          invalidateTarget();
        }
      }
    };
    void poll();
    const unsubscribe = subscribe((event) => {
      if (event.kind === 'discovery.snapshot' || event.kind === 'discovery.delta') void poll();
    });
    return () => {
      cancelled = true;
      activeController?.abort();
      unsubscribe();
    };
  }, [externalTerminal, setActiveTab, setExternalTerminal, setExternalTranscript, sidebarSharedProps, subscribe]);
}
