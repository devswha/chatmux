import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement, useEffect, useState } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { ExternalTerminalTarget, Project } from '../../types/app';
import { api } from '../../utils/api';
import type { ServerEvent } from '../../contexts/WebSocketContext';

import { useExternalTerminalDiscoveryAuthority } from './AppContent';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

type PendingRequest = {
  signal?: AbortSignal;
  resolve: (response: Response) => void;
};

function requestQueue() {
  const requests: PendingRequest[] = [];
  return {
    requests,
    request(signal?: AbortSignal): Promise<Response> {
      return new Promise((resolve) => requests.push({ signal, resolve }));
    },
  };
}

const project: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/workspace/project-1',
};

const tmux = {
  socketPath: '/tmp/discovery-authority.sock',
  sessionId: '$1',
  windowId: '@1',
  paneId: '%1',
};

const externalTarget: ExternalTerminalTarget = {
  tmuxName: 'external-pane',
  tmux,
  process: { pid: 41, startedAtMs: 1_700_000_000_041 },
  kind: 'claude',
  cliKind: 'claude',
  project,
};

const gjcTarget: ExternalTerminalTarget = {
  tmuxName: 'gjc-pane',
  tmux,
  process: { pid: 51, startedAtMs: 1_700_000_000_051 },
  kind: 'GJC',
  cliKind: 'gjc',
  project,
};

const staleExternalPayload = {
  success: true,
  data: {
    discovery: { ok: true },
    externalSessions: [{
      tmuxName: externalTarget.tmuxName,
      tmux,
      process: externalTarget.process,
      kind: 'claude',
      presence: 'present',
      authority: 'exact',
      transcriptSessionId: 'stale-transcript',
    }],
  },
};

const staleGjcPayload = {
  success: true,
  data: {
    discovery: { ok: true },
    liveSessions: [{
      id: 'stale-gjc-session',
      tmuxName: gjcTarget.tmuxName,
      tmux,
      process: gjcTarget.process,
      kind: 'interactive',
      presence: 'present',
      claim: 'lineage',
      running: true,
    }],
  },
};

function falseDiscoveryPayload(collection: 'externalSessions' | 'liveSessions', stale: unknown) {
  return {
    success: true,
    data: {
      discovery: { ok: false },
      [collection]: stale,
    },
  };
}

test('mounted production authority clears external target on newest failed discovery and fences older promotion', async () => {
  const queue = requestQueue();
  const originalExternalSessions = api.externalSessions;
  (api as typeof api & { externalSessions: (signal?: AbortSignal) => Promise<Response> }).externalSessions =
    (signal?: AbortSignal) => queue.request(signal);

  let renderer: ReactTestRenderer | null = null;
  let terminal: ExternalTerminalTarget | null = externalTarget;
  const opens: ExternalTerminalTarget[] = [];
  const projectSelections: Project[] = [];
  const sessionSelections: unknown[] = [];
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  function Probe() {
    const [current, setCurrent] = useState<ExternalTerminalTarget | null>(externalTarget);
    useExternalTerminalDiscoveryAuthority({
      externalTerminal: current,
      setExternalTerminal: setCurrent,
      setExternalTranscript: () => undefined,
      openExternalTerminal: (target) => opens.push(target),
      setActiveTab: () => undefined,
      sidebarSharedProps: {
        projects: [project],
        onProjectSelect: (selected) => projectSelections.push(selected),
        onSessionSelect: (selected) => sessionSelections.push(selected),
      },
      subscribe,
    });
    useEffect(() => { terminal = current; }, [current]);
    return null;
  }

  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
      await tick();
    });
    assert.equal(queue.requests.length, 1);

    await act(async () => {
      for (const listener of listeners) listener({ kind: 'discovery.delta' });
      await tick();
    });
    assert.equal(queue.requests.length, 2);
    assert.equal(queue.requests[0]!.signal?.aborted, true);

    await act(async () => {
      queue.requests[1]!.resolve(jsonResponse(falseDiscoveryPayload('externalSessions', staleExternalPayload.data.externalSessions)));
      await tick();
    });
    assert.equal(terminal, null, 'newest failed authority clears the exact external target');
    assert.equal(opens.length, 0, 'failed authority cannot select a transcript');
    assert.equal(projectSelections.length, 0);
    assert.equal(sessionSelections.length, 0);

    await act(async () => {
      queue.requests[0]!.resolve(jsonResponse(staleExternalPayload));
      await tick();
    });
    assert.equal(terminal, null, 'older successful discovery cannot restore a cleared target');
    assert.equal(opens.length, 0, 'older success cannot promote a transcript');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    (api as typeof api & { externalSessions: typeof originalExternalSessions }).externalSessions = originalExternalSessions;
  }
});

test('mounted production authority clears GJC target on newest failed discovery and fences older typed promotion', async () => {
  const queue = requestQueue();
  const originalLiveSessions = api.liveSessions;
  const originalSessionDetails = api.sessionDetails;
  let sessionDetailRequests = 0;
  (api as typeof api & { sessionDetails: typeof originalSessionDetails }).sessionDetails =
    async () => {
      sessionDetailRequests += 1;
      return jsonResponse({
        success: true,
        data: {
          session: {
            sessionId: 'stale-gjc-session',
            provider: 'gjc',
            projectId: project.projectId,
          },
        },
      });
    };
  (api as typeof api & { liveSessions: (signal?: AbortSignal) => Promise<Response> }).liveSessions =
    (signal?: AbortSignal) => queue.request(signal);

  let renderer: ReactTestRenderer | null = null;
  let terminal: ExternalTerminalTarget | null = gjcTarget;
  const opens: ExternalTerminalTarget[] = [];
  const projectSelections: Project[] = [];
  const sessionSelections: unknown[] = [];
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  function Probe() {
    const [current, setCurrent] = useState<ExternalTerminalTarget | null>(gjcTarget);
    useExternalTerminalDiscoveryAuthority({
      externalTerminal: current,
      setExternalTerminal: setCurrent,
      setExternalTranscript: () => undefined,
      openExternalTerminal: (target) => opens.push(target),
      setActiveTab: () => undefined,
      sidebarSharedProps: {
        projects: [project],
        onProjectSelect: (selected) => projectSelections.push(selected),
        onSessionSelect: (selected) => sessionSelections.push(selected),
      },
      subscribe,
    });
    useEffect(() => { terminal = current; }, [current]);
    return null;
  }

  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
      await tick();
    });
    assert.equal(queue.requests.length, 1);

    await act(async () => {
      for (const listener of listeners) listener({ kind: 'discovery.snapshot' });
      await tick();
    });
    assert.equal(queue.requests.length, 2);
    assert.equal(queue.requests[0]!.signal?.aborted, true);

    await act(async () => {
      queue.requests[1]!.resolve(jsonResponse(falseDiscoveryPayload('liveSessions', staleGjcPayload.data.liveSessions)));
      await tick();
    });
    assert.equal(terminal, null, 'newest failed authority clears the exact GJC target');
    assert.equal(opens.length, 0, 'GJC discovery never uses the external transcript opener');
    assert.equal(projectSelections.length, 0, 'failed authority cannot select a project');
    assert.equal(sessionSelections.length, 0, 'failed authority cannot select session details');
    assert.equal(sessionDetailRequests, 0, 'failed authority cannot request promotable session details');

    await act(async () => {
      queue.requests[0]!.resolve(jsonResponse(staleGjcPayload));
      await tick();
    });
    assert.equal(terminal, null, 'older successful discovery cannot restore a cleared GJC target');
    assert.equal(projectSelections.length, 0, 'older success cannot select a project');
    assert.equal(sessionSelections.length, 0, 'older success cannot initialize a typed session');
    assert.equal(sessionDetailRequests, 0, 'older success cannot request session details');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    (api as typeof api & { liveSessions: typeof originalLiveSessions }).liveSessions = originalLiveSessions;
    (api as typeof api & { sessionDetails: typeof originalSessionDetails }).sessionDetails = originalSessionDetails;
  }
});
test('mounted production authority promotes only the newest exact external transcript', async () => {
  const queue = requestQueue();
  const originalExternalSessions = api.externalSessions;
  (api as typeof api & { externalSessions: (signal?: AbortSignal) => Promise<Response> }).externalSessions =
    (signal?: AbortSignal) => queue.request(signal);

  let renderer: ReactTestRenderer | null = null;
  let terminal: ExternalTerminalTarget | null = externalTarget;
  const opens: ExternalTerminalTarget[] = [];
  const projectSelections: Project[] = [];
  const sessionSelections: unknown[] = [];
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const currentPayload = {
    success: true,
    data: {
      discovery: { ok: true },
      externalSessions: [{
        tmuxName: externalTarget.tmuxName,
        tmux,
        process: externalTarget.process,
        kind: 'claude',
        presence: 'present',
        authority: 'exact',
        projectPath: project.fullPath,
        transcriptSessionId: 'current-transcript',
      }],
    },
  };

  function Probe() {
    const [current, setCurrent] = useState<ExternalTerminalTarget | null>(externalTarget);
    useExternalTerminalDiscoveryAuthority({
      externalTerminal: current,
      setExternalTerminal: setCurrent,
      setExternalTranscript: () => undefined,
      openExternalTerminal: (target) => opens.push(target),
      setActiveTab: () => undefined,
      sidebarSharedProps: {
        projects: [project],
        onProjectSelect: (selected) => projectSelections.push(selected),
        onSessionSelect: (selected) => sessionSelections.push(selected),
      },
      subscribe,
    });
    useEffect(() => { terminal = current; }, [current]);
    return null;
  }

  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
      await tick();
    });
    assert.equal(queue.requests.length, 1);

    await act(async () => {
      for (const listener of listeners) listener({ kind: 'discovery.delta' });
      await tick();
    });
    assert.equal(queue.requests.length, 2);
    assert.equal(queue.requests[0]!.signal?.aborted, true);

    await act(async () => {
      queue.requests[1]!.resolve(jsonResponse(currentPayload));
      await tick();
    });
    assert.equal(opens.length, 1, 'newest exact authority opens one transcript');
    const opened = opens[0];
    assert.ok(opened && opened.cliKind !== 'gjc');
    assert.deepEqual(opened.tmux, tmux);
    assert.deepEqual(opened.process, externalTarget.process);
    assert.equal(opened.transcriptSessionId, 'current-transcript');
    assert.equal(opened.projectPath, project.fullPath);
    assert.equal(terminal, externalTarget, 'external promotion uses the opener without selecting a GJC session');
    assert.equal(projectSelections.length, 0);
    assert.equal(sessionSelections.length, 0);

    await act(async () => {
      queue.requests[0]!.resolve(jsonResponse({
        ...currentPayload,
        data: {
          ...currentPayload.data,
          externalSessions: [{
            ...currentPayload.data.externalSessions[0],
            transcriptSessionId: 'older-transcript',
          }],
        },
      }));
      await tick();
    });
    assert.equal(queue.requests.length, 2);
    assert.equal(opens.length, 1, 'older authority cannot override or duplicate the transcript open');
    assert.equal(projectSelections.length, 0);
    assert.equal(sessionSelections.length, 0);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    (api as typeof api & { externalSessions: typeof originalExternalSessions }).externalSessions = originalExternalSessions;
  }
});

test('mounted production authority promotes only the newest exact GJC session', async () => {
  const queue = requestQueue();
  const detailsQueue = requestQueue();
  const originalLiveSessions = api.liveSessions;
  const originalSessionDetails = api.sessionDetails;
  let sessionDetailRequests = 0;
  (api as typeof api & { sessionDetails: typeof originalSessionDetails }).sessionDetails =
    async () => {
      sessionDetailRequests += 1;
      return detailsQueue.request();
    };
  (api as typeof api & { liveSessions: (signal?: AbortSignal) => Promise<Response> }).liveSessions =
    (signal?: AbortSignal) => queue.request(signal);

  let renderer: ReactTestRenderer | null = null;
  let terminal: ExternalTerminalTarget | null = gjcTarget;
  let transcriptClears = 0;
  const activeTabs: string[] = [];
  const opens: ExternalTerminalTarget[] = [];
  const projectSelections: Project[] = [];
  const sessionSelections: unknown[] = [];
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const currentSessionId = 'current-gjc-session';
  const currentPayload = {
    success: true,
    data: {
      discovery: { ok: true },
      liveSessions: [{
        id: currentSessionId,
        tmuxName: gjcTarget.tmuxName,
        tmux,
        process: gjcTarget.process,
        kind: 'interactive',
        presence: 'present',
        claim: 'lineage',
        running: true,
      }],
    },
  };
  const currentDetails = {
    success: true,
    data: {
      session: {
        sessionId: currentSessionId,
        provider: 'gjc',
        projectId: project.projectId,
        summary: 'Current GJC session',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:01:00.000Z',
      },
    },
  };

  function Probe() {
    const [current, setCurrent] = useState<ExternalTerminalTarget | null>(gjcTarget);
    useExternalTerminalDiscoveryAuthority({
      externalTerminal: current,
      setExternalTerminal: setCurrent,
      setExternalTranscript: () => { transcriptClears += 1; },
      openExternalTerminal: (target) => opens.push(target),
      setActiveTab: (tab) => activeTabs.push(tab),
      sidebarSharedProps: {
        projects: [project],
        onProjectSelect: (selected) => projectSelections.push(selected),
        onSessionSelect: (selected) => sessionSelections.push(selected),
      },
      subscribe,
    });
    useEffect(() => { terminal = current; }, [current]);
    return null;
  }

  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe));
      await tick();
    });
    assert.equal(queue.requests.length, 1);

    await act(async () => {
      queue.requests[0]!.resolve(jsonResponse(currentPayload));
      await tick();
    });
    assert.equal(sessionDetailRequests, 1);

    await act(async () => {
      for (const listener of listeners) listener({ kind: 'discovery.snapshot' });
      await tick();
    });
    assert.equal(queue.requests.length, 2);
    assert.equal(queue.requests[0]!.signal?.aborted, true);

    await act(async () => {
      queue.requests[1]!.resolve(jsonResponse(currentPayload));
      await tick();
    });
    assert.equal(sessionDetailRequests, 2);

    await act(async () => {
      detailsQueue.requests[1]!.resolve(jsonResponse(currentDetails));
      await tick();
    });
    assert.equal(terminal, null, 'newest exact GJC authority clears the terminal handoff state');
    assert.equal(transcriptClears, 1);
    assert.deepEqual(activeTabs, ['chat']);
    assert.deepEqual(projectSelections, [project]);
    assert.deepEqual(sessionSelections, [{
      id: currentSessionId,
      summary: 'Current GJC session',
      createdAt: '2026-07-30T00:00:00.000Z',
      updated_at: '2026-07-30T00:01:00.000Z',
      __provider: 'gjc',
      __projectId: project.projectId,
    }]);
    assert.equal(opens.length, 0, 'GJC promotion never opens an external transcript');

    await act(async () => {
      detailsQueue.requests[0]!.resolve(jsonResponse({
        ...currentDetails,
        data: {
          session: {
            ...currentDetails.data.session,
            summary: 'Older GJC session',
          },
        },
      }));
      await tick();
    });
    assert.equal(queue.requests.length, 2);
    assert.equal(sessionDetailRequests, 2);
    assert.equal(terminal, null, 'older deferred details cannot restore the terminal state');
    assert.equal(transcriptClears, 1, 'older deferred details cannot clear state twice');
    assert.deepEqual(activeTabs, ['chat']);
    assert.deepEqual(projectSelections, [project]);
    assert.equal(sessionSelections.length, 1, 'older deferred details cannot select another session');
    assert.equal(opens.length, 0);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    (api as typeof api & { liveSessions: typeof originalLiveSessions }).liveSessions = originalLiveSessions;
    (api as typeof api & { sessionDetails: typeof originalSessionDetails }).sessionDetails = originalSessionDetails;
  }
});
