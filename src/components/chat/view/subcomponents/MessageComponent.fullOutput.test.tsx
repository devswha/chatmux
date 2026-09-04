import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import TestRenderer, { act } from 'react-test-renderer';

import '../../../../i18n/config';
import FleetSessionRoute from '../../../../fleet/FleetSessionRoute';
import { installBrowserGlobals } from '../../../../fleet/mountedBrowserEnvironment';
import { REMOTE_SESSION_ROUTE } from '../../../../fleet/sessionRoute';
import type { ChatMessage } from '../../types/types';
import { useFullToolResult } from '../../hooks/useFullToolResult';

import MessageComponent from './MessageComponent';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const message: ChatMessage = {
  sessionId: 'same-session', toolId: 'same-tool', type: 'assistant', content: '',
  timestamp: '2026-09-04T00:00:00Z', isToolUse: true, toolName: 'exec',
  toolInput: '{}', toolResult: { content: 'preview' }, toolResultTruncated: true,
};

test('full tool output uses the owning peer even when the hub has matching IDs', async () => {
  const environment = installBrowserGlobals();
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/fleet/identity') return Response.json({ installationId: LOCAL });
    requests.push(url);
    return Response.json({ data: { toolId: 'same-tool', revision: 'a'.repeat(64), content: 'peer-output', isError: false, offset: 0, nextOffset: null, totalBytes: 11 } });
  }) as typeof fetch;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(MemoryRouter, {
        initialEntries: [REMOTE_SESSION_ROUTE.replace(':hostId', PEER).replace(':sessionId', 'same-session')],
      }, createElement(Routes, null, createElement(Route, {
        path: REMOTE_SESSION_ROUTE,
        element: createElement(FleetSessionRoute, null, createElement(MessageComponent, {
          message, prevMessage: null, createDiff: () => [], provider: 'codex',
        })),
      }))));
    });
    const load = renderer?.root.findAllByType('button').find((button) => button.children.includes('Load full output'));
    assert.ok(load);
    await act(async () => { await load.props.onClick(); });
    assert.equal(requests.length, 1);
    assert.ok(requests[0]?.startsWith(`/api/hosts/${PEER}/providers/sessions/same-session/tool-result?`), requests[0]);
    assert.equal(renderer?.root.findByType('textarea').props.value, 'peer-output');
  } finally {
    await act(async () => { renderer?.unmount(); });
    environment.restore();
  }
});

test('a late full-output response cannot replace the same IDs on another host', async () => {
  const environment = installBrowserGlobals();
  const other = '33333333-3333-4333-8333-333333333333';
  let resolveDelayed!: (response: Response) => void;
  const delayed = new Promise<Response>((resolve) => { resolveDelayed = resolve; });
  let oldSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/fleet/identity') return Response.json({ installationId: LOCAL });
    if (url.includes(`/hosts/${PEER}/`)) { oldSignal = init?.signal; return delayed; }
    return Response.json({ data: { toolId: 'same-tool', revision: 'b'.repeat(64), content: 'peer-b', isError: false, offset: 0, nextOffset: null, totalBytes: 6 } });
  }) as typeof fetch;
  let current!: ReturnType<typeof useFullToolResult>;
  let navigate!: ReturnType<typeof useNavigate>;
  function Probe() { current = useFullToolResult('same-session', 'same-tool'); navigate = useNavigate(); return null; }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let firstRead: Promise<void> | undefined;
  const route = (host: string) => REMOTE_SESSION_ROUTE.replace(':hostId', host).replace(':sessionId', 'same-session');
  try {
    await act(async () => { renderer = TestRenderer.create(createElement(MemoryRouter, { initialEntries: [route(PEER)] },
      createElement(Routes, null, createElement(Route, { path: REMOTE_SESSION_ROUTE, element: createElement(FleetSessionRoute, null, createElement(Probe)) })))); });
    await act(async () => { firstRead = current.loadFullToolResult(); });
    await act(async () => { await navigate(route(other)); });
    assert.equal(oldSignal?.aborted, true);
    await act(async () => { await current.loadFullToolResult(); });
    assert.equal(current.fullToolResult?.content, 'peer-b');
    await act(async () => {
      resolveDelayed(Response.json({ data: { toolId: 'same-tool', revision: 'a'.repeat(64), content: 'peer-a', isError: false, offset: 0, nextOffset: null, totalBytes: 6 } }));
      await firstRead;
    });
    assert.equal(current.fullToolResult?.content, 'peer-b');
    assert.equal(current.fullToolResultError, false);
  } finally {
    await act(async () => { renderer?.unmount(); });
    environment.restore();
  }
});
