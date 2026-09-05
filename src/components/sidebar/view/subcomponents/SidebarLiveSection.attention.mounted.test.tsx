import assert from 'node:assert/strict';
import test from 'node:test';

import i18next from 'i18next';
import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { I18nextProvider } from 'react-i18next';

import enSidebar from '../../../../i18n/locales/en/sidebar.json';
import type { ExternalTerminalTarget } from '../../../../types/app';
import type { ServerEvent } from '../../../../contexts/WebSocketContext';
import { PEER_A_HOST_ID, paneRow, snapshotFrame } from '../../../../fleet/discovery/hostCatalog.testSupport';
import { api } from '../../../../utils/api';
import type { ExternalCliSession } from '../../hooks/useExternalCliSessions';
import { CompletionNotificationsContext } from '../../context/CompletionNotificationsContext';
import { createSessionOrderId } from '../../utils/sessionOrder';

import SidebarLiveSection from './SidebarLiveSection';
import SidebarAttentionControls from './SidebarAttentionControls';
import SortableSessionRow from './SortableSessionRow';
import { handoffProps, makeProjects, target } from './SidebarLiveSection.testSupport';
import { jsonResponse, mountHostGroups, remoteRows, rosterBody } from './fleet/hostGroups.testSupport';

type Props = React.ComponentProps<typeof SidebarLiveSection>;
const external = (name: string, activity: ExternalCliSession['activity'], extras: Partial<ExternalCliSession> = {}): ExternalCliSession => ({
  tmuxName: name,
  ...target(`%${name}`, 200),
  kind: 'codex',
  activity,
  authority: 'stream',
  presence: 'present',
  ...extras,
});
const baseProps = (): Props => ({
  ...handoffProps({ gjcTarget: target('%1', 100), externalTarget: target('%2', 101) }),
  liveSessionInput: new Set(['s-live']),
  externalSessions: [
    external('ready', 'waiting_user'),
    external('input', 'asking_user'),
    external('failure', 'error'),
    external('unknown', 'unknown', { transcriptSessionId: 'unknown-session' }),
    external('stale', 'asking_user', { presence: 'stale' }),
    external('unavailable', 'error', { authority: 'none' }),
    external('connection', 'error', { connectionIssue: 'transcript_ambiguous' }),
    external('ssh', 'asking_user', { kind: 'ssh' }),
  ],
});

async function mount(initial: Props) {
  const instance = i18next.createInstance();
  await instance.init({ lng: 'en', resources: { en: { sidebar: enSidebar } }, defaultNS: 'sidebar', interpolation: { escapeValue: false } });
  const element = (props: Props) => createElement(I18nextProvider, { i18n: instance },
    createElement(CompletionNotificationsContext.Provider, { value: {
      status: null, statuses: new Map(), registerDescriptors: () => () => {},
      setWatch: async () => {}, repairDevice: async () => {}, refresh: async () => {},
    } as never }, createElement(SidebarLiveSection, props)));
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(element(initial)); });
  return {
    renderer,
    update: async (props: Props) => { await act(async () => { renderer.update(element(props)); }); },
    unmount: async () => { await act(async () => { renderer.unmount(); }); },
  };
}
const controls = (renderer: ReactTestRenderer) => renderer.root.findByType(SidebarAttentionControls);
const visibleIds = (renderer: ReactTestRenderer) => renderer.root.findAllByType(SortableSessionRow)
  .filter((row) => !row.props.hidden).map((row) => row.props.id);
const chooseFilter = async (renderer: ReactTestRenderer, filter: string) => {
  const select = renderer.root.findByType('select');
  await act(async () => { select.props.onChange({ target: { value: filter } }); });
};
const next = async (renderer: ReactTestRenderer) => {
  const button = renderer.root.findAllByType('button').find((node) => node.props['data-attention-next'] === true)!;
  assert.notEqual(button.props.disabled, true);
  await act(async () => { button.props.onClick(); });
};

test('attention filters only local reported rows, preserves order, and distinguishes connection failures', async () => {
  const props = baseProps();
  const view = await mount(props);
  try {
    const initialOrder = visibleIds(view.renderer);
    assert.deepEqual(controls(view.renderer).props.counts, { input: 2, failure: 1, connection: 1 });
    const scope = view.renderer.root.findAllByType('span').find((node) => node.children.includes(enSidebar.attention.scope));
    assert.ok(scope);
    const select = view.renderer.root.findByType('select');
    assert.equal(select.props['aria-label'], enSidebar.attention.filterLabel);
    assert.equal(select.props['aria-describedby'], scope.props.id);
    assert.equal(select.props.value, 'all');
    assert.deepEqual(select.findAllByType('option').map((option) => [option.props.value, option.children.join('')]), [
      ['all', 'All local'], ['input', 'Response needed (2)'], ['failure', 'Failures (1)'], ['connection', 'Connection issues (1)'],
    ]);
    await chooseFilter(view.renderer, 'input');
    const inputIds = [createSessionOrderId('s-live', props.liveSessionTargets.get('s-live')!.tmux), createSessionOrderId('', props.externalSessions![1]!.tmux)];
    assert.deepEqual(visibleIds(view.renderer), inputIds);
    assert.equal(view.renderer.root.findByType('select').props.value, 'input');
    assert.ok(view.renderer.root.findAllByType(SortableSessionRow).every((row) => row.props.disabled), 'filtering cannot overwrite saved ordering');
    await chooseFilter(view.renderer, 'failure');
    assert.deepEqual(visibleIds(view.renderer), [createSessionOrderId('', props.externalSessions![2]!.tmux)]);
    await chooseFilter(view.renderer, 'connection');
    assert.deepEqual(visibleIds(view.renderer), [createSessionOrderId('', props.externalSessions![6]!.tmux)]);
    assert.equal(controls(view.renderer).props.hasNext, false, 'a connection exclusion never becomes selectable through navigation');
    assert.equal(view.renderer.root.findAllByType('button').filter((node) => node.props['data-attention-next']).length, 0);
    assert.ok(view.renderer.root.findAllByType('span').some((node) => node.children.includes('LINK')));
    await chooseFilter(view.renderer, 'all');
    assert.deepEqual(visibleIds(view.renderer), initialOrder);
  } finally { await view.unmount(); }
});

test('an idle list has no attention toolbar and an empty active filter can still be reset', async () => {
  const idle = { ...baseProps(), liveSessionInput: new Set<string>(), externalSessions: [external('ready', 'waiting_user')] };
  const view = await mount(idle);
  try {
    assert.equal(view.renderer.root.findAllByType('select').length, 0);
    assert.equal(view.renderer.root.findAllByType('button').filter((node) => node.props['data-attention-next']).length, 0);
    const idleOrder = visibleIds(view.renderer);
    await view.update(baseProps());
    await chooseFilter(view.renderer, 'failure');
    await view.update(idle);
    assert.equal(view.renderer.root.findByType('select').props.value, 'failure');
    assert.deepEqual(visibleIds(view.renderer), []);
    assert.equal(view.renderer.root.findAllByType('button').filter((node) => node.props['data-attention-next']).length, 0);
    await chooseFilter(view.renderer, 'all');
    assert.equal(view.renderer.root.findAllByType('select').length, 0);
    assert.deepEqual(visibleIds(view.renderer), idleOrder);
  } finally { await view.unmount(); }
});

test('next selects through ordinary GJC and external row paths, wraps, and uses replacement identities', async () => {
  let selected: unknown[] = [];
  const opened: Array<[ExternalTerminalTarget, unknown]> = [];
  const props = { ...baseProps(), onSessionSelect: (...args: unknown[]) => { selected = args; }, onExternalTerminalOpen: (value: ExternalTerminalTarget, options?: unknown) => { opened.push([value, options]); } };
  const view = await mount(props);
  try {
    await next(view.renderer);
    assert.deepEqual(selected, [{ ...props.projects[0]!.sessions![0], __provider: 'gjc' }, 'p1']);
    await next(view.renderer);
    assert.equal(opened[0]![0].tmuxName, 'input');
    assert.deepEqual(opened[0]![0].tmux, props.externalSessions![1]!.tmux);
    assert.deepEqual(opened[0]![0].process, props.externalSessions![1]!.process);
    assert.equal(opened[0]![1], undefined, 'navigation does not invoke approval attach or send input');
    await next(view.renderer);
    assert.equal(opened[1]![0].tmuxName, 'failure');
    selected = [];
    await next(view.renderer);
    assert.deepEqual(selected, [{ ...props.projects[0]!.sessions![0], __provider: 'gjc' }, 'p1']);
    const replacement = { ...props.externalSessions![1]!, process: { pid: 999, startedAtMs: 9999 }, transcriptSessionId: 'replacement-session' };
    await chooseFilter(view.renderer, 'input');
    await view.update({ ...props, externalSessions: [replacement] });
    await next(view.renderer);
    assert.deepEqual(opened.at(-1)![0].process, replacement.process);
    const replacementTarget = opened.at(-1)![0];
    assert.ok('transcriptSessionId' in replacementTarget);
    assert.equal(replacementTarget.transcriptSessionId, replacement.transcriptSessionId);
    await view.update({ ...props, liveSessionInput: new Set(), externalSessions: [{ ...replacement, authority: 'none' }] });
    assert.equal(controls(view.renderer).props.hasNext, false);
    assert.deepEqual(controls(view.renderer).props.counts, { input: 0, failure: 0, connection: 0 });
    await chooseFilter(view.renderer, 'input');
    assert.deepEqual(visibleIds(view.renderer), []);
    assert.ok(view.renderer.root.findAllByType('p').some((node) => node.props.role === 'status' && node.children.includes(enSidebar.attention.empty)));
  } finally { await view.unmount(); }
});

test('remote reported activity cannot inflate local attention or override the existing host filter', async () => {
  const props = baseProps();
  const harness = await mountHostGroups({
    roster: () => jsonResponse(rosterBody()),
    children: createElement(CompletionNotificationsContext.Provider, { value: {
      status: null, statuses: new Map(), registerDescriptors: () => () => {},
      setWatch: async () => {}, repairDevice: async () => {}, refresh: async () => {},
    } as never }, createElement(SidebarLiveSection, props)),
  });
  try {
    await harness.emit(snapshotFrame(PEER_A_HOST_ID, 1, {
      panes: [{ ...paneRow('/peer.sock', 'input'), activity: 'asking_user' }],
    }) as ServerEvent);
    assert.deepEqual(controls(harness.renderer).props.counts, { input: 2, failure: 1, connection: 1 });
    await chooseFilter(harness.renderer, 'failure');
    assert.equal(remoteRows(harness, PEER_A_HOST_ID).length, 1, 'local filters leave remote rows alone');
    const peerFilter = harness.renderer.root.findAllByType('button').find((node) => node.props['data-host-filter'] === PEER_A_HOST_ID)!;
    await act(async () => { peerFilter.props.onClick(); });
    assert.equal(harness.renderer.root.findAllByType(SidebarAttentionControls).length, 0, 'a remote-only host filter has no local attention navigation');
    assert.equal(remoteRows(harness, PEER_A_HOST_ID).length, 1);
    assert.equal(harness.openedTerminals.length, 0);
    const allHosts = harness.renderer.root.findAllByType('button').find((node) => node.props['data-host-filter'] === 'all')!;
    await act(async () => { allHosts.props.onClick(); });
    assert.deepEqual(controls(harness.renderer).props.counts, { input: 2, failure: 1, connection: 1 });
  } finally { await harness.dispose(); }
});

test('counts use the same process-generation handoff winner as the list and exclude stale live rows', async () => {
  const pane = target('%same', 100);
  const props = handoffProps({ gjcTarget: pane, externalTarget: { ...pane, process: { pid: 200, startedAtMs: pane.process.startedAtMs + 1 } } });
  props.liveSessionInput = new Set(['s-live']);
  props.externalSessions![0]!.activity = 'error';
  const view = await mount(props);
  try {
    assert.equal(visibleIds(view.renderer).length, 1);
    assert.deepEqual(controls(view.renderer).props.counts, { input: 0, failure: 1, connection: 0 });
    await view.update({ ...props, externalSessions: [], liveSessionPresence: new Map([['s-live', 'stale']]), liveSessionErrors: new Set(['s-live']) });
    assert.deepEqual(controls(view.renderer).props.counts, { input: 0, failure: 0, connection: 0 });
    assert.equal(controls(view.renderer).props.hasNext, false);
  } finally { await view.unmount(); }
});

test('changing a filter preserves pending external transcript promotion and its exact generation fence', async () => {
  const projects = makeProjects();
  projects[0]!.fullPath = '/project';
  const pending = external('pending', 'asking_user', { projectPath: '/project' });
  const opened: ExternalTerminalTarget[] = [];
  const props = { ...baseProps(), projects, liveSessionInput: new Set<string>(), externalSessions: [pending], onExternalTerminalOpen: (value: ExternalTerminalTarget) => { opened.push(value); } };
  const view = await mount(props);
  try {
    await next(view.renderer);
    assert.equal(opened.length, 1);
    await chooseFilter(view.renderer, 'failure');
    await view.update({ ...props, externalSessions: [{ ...pending, transcriptSessionId: 'indexed-pending' }] });
    assert.equal(opened.length, 2, 'the selected pane can still promote while its row is filtered out');
    assert.ok('transcriptSessionId' in opened[1]!);
    assert.equal(opened[1]!.transcriptSessionId, 'indexed-pending');
    assert.deepEqual(opened[1]!.process, pending.process);
    await view.update({ ...props, externalSessions: [{ ...pending, process: { pid: 900, startedAtMs: 99999 }, transcriptSessionId: 'replacement' }] });
    assert.equal(opened.length, 2, 'replacement cannot reuse a consumed pending selection');
  } finally { await view.unmount(); }
});

test('next orphan selection rejects a mismatched session-details response', async () => {
  const original = api.sessionDetails;
  const calls: unknown[] = [];
  api.sessionDetails = async () => new Response(JSON.stringify({ data: { session: { sessionId: 'different', provider: 'gjc', projectId: 'p1' } } }), { status: 200 });
  const props = { ...baseProps(), projects: [{ ...makeProjects()[0]!, sessions: [] }], externalSessions: [], onSessionSelect: (...args: unknown[]) => { calls.push(args); } };
  const view = await mount(props);
  try {
    await next(view.renderer);
    assert.deepEqual(calls, []);
    assert.ok(view.renderer.root.findAllByType('p').some((node) => node.children.includes(enSidebar.liveSessions.openPreviousFailed)));
  } finally {
    api.sessionDetails = original;
    await view.unmount();
  }
});

test('leaving a pending external transcript prevents its late promotion from reopening the old session', async () => {
  const projects = makeProjects();
  projects[0]!.fullPath = '/project';
  const pending = external('pending', 'asking_user', { projectPath: '/project' });
  const opened: ExternalTerminalTarget[] = [];
  const selected: unknown[][] = [];
  const props = {
    ...baseProps(), projects, externalSessions: [pending],
    onSessionSelect: (...args: unknown[]) => { selected.push(args); },
    onExternalTerminalOpen: (value: ExternalTerminalTarget) => { opened.push(value); },
  };
  const view = await mount(props);
  try {
    await next(view.renderer); // GJC
    await next(view.renderer); // external pane without transcript
    assert.equal(opened.length, 1);
    await next(view.renderer); // return to GJC
    assert.equal(selected.length, 2);
    await view.update({
      ...props,
      selectedSession: projects[0]!.sessions![0]!,
      externalSessions: [{ ...pending, transcriptSessionId: 'late-transcript' }],
    });
    assert.equal(opened.length, 1, 'late metadata must not override the newer explicit selection');
  } finally { await view.unmount(); }
});
