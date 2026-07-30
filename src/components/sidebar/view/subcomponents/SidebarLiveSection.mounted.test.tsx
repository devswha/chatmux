import assert from 'node:assert/strict';
import test from 'node:test';

import type { DragEndEvent } from '@dnd-kit/core';
import i18next from 'i18next';
import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { I18nextProvider } from 'react-i18next';

import koSidebar from '../../../../i18n/locales/ko/sidebar.json';
import type { Project, ProjectSession } from '../../../../types/app';
import type { TmuxPaneTarget } from '../../../../../shared/tmux';
import type { ExternalCliSession } from '../../hooks/useExternalCliSessions';
import {
  LIVE_SESSION_ORDER_STORAGE_KEY,
  createSessionOrderId,
} from '../../utils/sessionOrder';
import { CompletionNotificationsContext } from '../../context/CompletionNotificationsContext';

import SortableSessionRow from './SortableSessionRow';
import SidebarLiveSection from './SidebarLiveSection';

const noop = () => {};
const onProjectSelect = noop as unknown as (project: Project) => void;
const onSessionSelect = noop as unknown as (session: ProjectSession, projectId: string) => void;

const paneTarget = (paneId: string, pid: number): TmuxPaneTarget => ({
  tmux: {
    socketPath: '/tmp/sidebar-live-mounted.sock',
    sessionId: '$mounted',
    windowId: '@1',
    paneId,
  },
  process: { pid, startedAtMs: 1_700_000_000_000 + pid },
});

const gjcTarget = paneTarget('%1', 101);
const claudeTarget = paneTarget('%2', 102);
const localAgentTarget = paneTarget('%3', 103);
const sshTarget = paneTarget('%4', 104);
const shellTarget = paneTarget('%5', 105);

const expectedIds = [
  createSessionOrderId('gjc-session', gjcTarget.tmux),
  createSessionOrderId('', claudeTarget.tmux),
  createSessionOrderId('', localAgentTarget.tmux),
  createSessionOrderId('', sshTarget.tmux),
  createSessionOrderId('', shellTarget.tmux),
];

const props: React.ComponentProps<typeof SidebarLiveSection> = {
  projects: [{
    projectId: 'project-mounted',
    displayName: 'Mounted project',
    sessions: [{ id: 'gjc-session', summary: 'GJC session', provider: 'gjc' }],
  }] as unknown as Project[],
  liveSessionIds: new Set(['gjc-session']),
  externalSessions: [
    {
      tmuxName: 'claude-pane',
      tmux: claudeTarget.tmux,
      process: claudeTarget.process,
      kind: 'claude',
      authority: 'rest',
      presence: 'present',
    },
    {
      tmuxName: 'local-agent-pane',
      tmux: localAgentTarget.tmux,
      process: localAgentTarget.process,
      kind: 'codex',
      authority: 'rest',
      presence: 'present',
    },
    {
      tmuxName: 'ssh-pane',
      tmux: sshTarget.tmux,
      process: sshTarget.process,
      kind: 'ssh',
      authority: 'rest',
      presence: 'present',
    },
    {
      tmuxName: 'shell-pane',
      tmux: shellTarget.tmux,
      process: shellTarget.process,
      kind: 'shell',
      authority: 'rest',
      presence: 'present',
    },
  ] as ExternalCliSession[],
  liveSessionNames: new Map([['gjc-session', 'gjc-pane']]),
  liveSessionLineage: new Set(['gjc-session']),
  liveSessionPanes: new Map([['gjc-session', gjcTarget.tmux]]),
  liveSessionTargets: new Map([['gjc-session', gjcTarget]]),
  liveSessionKinds: new Map([['gjc-session', 'interactive']]),
  liveSessionRunning: new Set<string>(),
  selectedSession: null,
  onProjectSelect,
  onSessionSelect,
  onExternalTerminalOpen: noop,
};

async function sidebarI18n() {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'ko',
    fallbackLng: false,
    resources: { ko: { sidebar: koSidebar } },
    ns: ['sidebar'],
    defaultNS: 'sidebar',
    interpolation: { escapeValue: false },
  });
  return instance;
}

function mountedSection(i18n: Awaited<ReturnType<typeof sidebarI18n>>) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(
      CompletionNotificationsContext.Provider,
      {
        value: {
          status: null,
          statuses: new Map(),
          registerDescriptors: () => () => {},
          setWatch: async () => {},
          repairDevice: async () => {},
          refresh: async () => {},
        } as never,
      },
      createElement(SidebarLiveSection, props),
    ),
  );
}

function rowIds(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType(SortableSessionRow).map((row) => row.props.id as string);
}
function dragLabels(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType('button')
    .map((button) => button.props['aria-label'])
    .filter((label): label is string => (
      typeof label === 'string' && label.includes('세션 순서 옮기기')
    ));
}

function drag(renderer: ReactTestRenderer, activeId: string, overId: string): void {
  const contexts = renderer.root.findAll((node) => (
    typeof node.props.onDragEnd === 'function'
    && Array.isArray(node.props.sensors)
    && node.props.collisionDetection
  ));
  assert.equal(contexts.length, 1, 'mounted production DnD context is present');
  contexts[0]!.props.onDragEnd({
    active: { id: activeId },
    over: { id: overId },
  } as DragEndEvent);
}

function installStorage(storage: Storage) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  return () => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  };
}

test('mounted unified list reorders mixed providers through DndContext and restores stable pane ids', async () => {
  const values = new Map<string, string>();
  const writes: string[] = [];
  const restoreStorage = installStorage({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(key);
      values.set(key, value);
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    get length() { return values.size; },
  });
  const i18n = await sidebarI18n();
  let renderer: ReactTestRenderer | null = null;
  let remounted: ReactTestRenderer | null = null;

  try {
    await act(async () => {
      renderer = TestRenderer.create(mountedSection(i18n));
    });
    assert.deepEqual(rowIds(renderer!), expectedIds, 'production render starts with every provider row');
    assert.equal(new Set(rowIds(renderer!)).size, expectedIds.length, 'rendered sortable ids are unique');
    const initialLabels = dragLabels(renderer!);
    assert.equal(new Set(initialLabels).size, expectedIds.length, 'rendered drag handles have no duplicates');

    await act(async () => {
      drag(renderer!, expectedIds[4]!, expectedIds[0]!);
    });
    const reorderedIds = [expectedIds[4]!, ...expectedIds.slice(0, 4)];
    assert.deepEqual(rowIds(renderer!), reorderedIds, 'DndContext onDragEnd moves shell ahead of GJC and local agents');
    assert.deepEqual(JSON.parse(values.get(LIVE_SESSION_ORDER_STORAGE_KEY) ?? '[]'), reorderedIds);
    assert.ok(writes.includes(LIVE_SESSION_ORDER_STORAGE_KEY), 'the mounted drag path persists the unified order');
    assert.deepEqual(dragLabels(renderer!), [initialLabels[4]!, ...initialLabels.slice(0, 4)]);

    await act(async () => { renderer!.unmount(); });
    renderer = null;
    await act(async () => {
      remounted = TestRenderer.create(mountedSection(i18n));
    });
    assert.deepEqual(rowIds(remounted!), reorderedIds, 'reload restores the cross-provider order');
    assert.deepEqual(new Set(rowIds(remounted!)), new Set(expectedIds), 'pane-backed ids remain stable after remount');
    assert.deepEqual(dragLabels(remounted!), [initialLabels[4]!, ...initialLabels.slice(0, 4)]);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    if (remounted) await act(async () => { remounted!.unmount(); });
    restoreStorage();
  }
});

test('mounted unified list keeps page-local order when storage reads and writes throw', async () => {
  const restoreStorage = installStorage({
    getItem: () => { throw new Error('storage read blocked'); },
    setItem: () => { throw new Error('storage write blocked'); },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    get length() { return 0; },
  });
  const i18n = await sidebarI18n();
  let renderer: ReactTestRenderer | null = null;

  try {
    await act(async () => {
      renderer = TestRenderer.create(mountedSection(i18n));
    });
    assert.deepEqual(rowIds(renderer!), expectedIds);

    await act(async () => {
      drag(renderer!, expectedIds[3]!, expectedIds[1]!);
    });
    assert.deepEqual(
      rowIds(renderer!),
      [expectedIds[0]!, expectedIds[3]!, expectedIds[1]!, expectedIds[2]!, expectedIds[4]!],
      'a failed persistence attempt does not discard page-local DnD state',
    );
    assert.equal(new Set(rowIds(renderer!)).size, expectedIds.length, 'storage failures cannot duplicate sortable rows');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    restoreStorage();
  }
});
