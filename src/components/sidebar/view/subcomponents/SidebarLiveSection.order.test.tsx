import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionOrderId } from '../../utils/sessionOrder';
import type { TmuxPaneTarget } from '../../../../../shared/tmux';
import type { ExternalCliSession } from '../../hooks/useExternalCliSessions';
import koSidebar from '../../../../i18n/locales/ko/sidebar.json';

import {
  completionStatus,
  makeProjects,
  noop,
  onProjectSelect,
  onSessionSelect,
  renderSection,
  target,
} from './SidebarLiveSection.testSupport';

test('SidebarLiveSection labels rows by tmux session name, title in tooltip', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map([['s-live', 'omg']]),
    liveSessionModels: new Map([['s-live', 'openai-codex/gpt-5.6-sol']]),
    liveSessionEfforts: new Map([['s-live', 'xhigh']]),
    liveSessionLineage: new Set(['s-live']),
    liveSessionTargets: new Map([['s-live', target('%1', 1)]]),
    liveSessionKinds: new Map([['s-live', 'interactive']]),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  }, [completionStatus('s-live')]);
  assert.ok(html.includes('>omg<'), 'primary label is the tmux session name');
  assert.ok(html.includes('Proj One'), 'shows the project name');
  assert.ok(html.includes('gpt-5.6-sol · xhigh effort · Proj One'), 'shows model and reasoning effort');
  assert.ok(html.includes('title="Live conversation title"'), 'conversation title is demoted to the tooltip');
  assert.ok(!html.includes('Idle conversation'), 'omits non-live sessions');
  assert.ok(!html.includes('>BATCH<'), 'an interactive GJC TUI carries no batch badge');
  assert.ok(html.includes('>READY<'), 'an idle live transcript uses the unified READY state');
  assert.ok(html.includes('이 세션의 어시스턴트 응답 준비 완료 알림 끄기'), 'matched lineage rows render their completion bell');
  assert.ok(
    html.indexOf('이 세션의 어시스턴트 응답 준비 완료 알림 끄기') < html.indexOf(`title="${koSidebar.liveSessions.closeSessionTitle.replace('{{name}}', 'omg').replace(/'/g, '&#x27;')}"`),
    'the completion bell stays left of the matched row stop control',
  );
});


test('SidebarLiveSection gives every row an accessible drag handle when reordering is available', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live', 's-idle']),
    liveSessionNames: new Map([
      ['s-live', 'omg'],
      ['s-idle', 'stock'],
    ]),
    liveSessionLineage: new Set<string>(),
    liveSessionTargets: new Map<string, TmuxPaneTarget>(),
    liveSessionKinds: new Map([
      ['s-live', 'interactive'],
      ['s-idle', 'interactive'],
    ]),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });

  assert.ok(html.includes('aria-label="&#x27;omg&#x27; 세션 순서 옮기기"'));
  assert.ok(html.includes('aria-label="&#x27;stock&#x27; 세션 순서 옮기기"'));
  assert.ok(html.includes('tabindex="0"'), 'drag handles are keyboard focusable');
});


test('SidebarLiveSection restores one cross-provider order for GJC and external sessions', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const gjcTarget = target('%1', 1);
  const externalTarget = target('%2', 2);
  const externalSession: ExternalCliSession = {
    tmuxName: 'claude',
    tmux: externalTarget.tmux,
    process: externalTarget.process,
    kind: 'claude',
    transcriptSessionId: 'claude-session',
    sessionName: 'Claude conversation',
  };
  const storageReads: string[] = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => {
        storageReads.push(key);
        return key === 'chatmux.liveSessionOrder.v2'
          ? JSON.stringify({
              version: 2,
              entries: [
                createSessionOrderId('', externalTarget.tmux),
                createSessionOrderId('s-live', gjcTarget.tmux),
              ],
            })
          : null;
      },
      setItem: () => {},
    },
  });

  try {
    const html = await renderSection({
      projects: makeProjects(),
      liveSessionIds: new Set(['s-live']),
      externalSessions: [externalSession],
      liveSessionNames: new Map([['s-live', 'omg']]),
      liveSessionLineage: new Set(['s-live']),
      liveSessionTargets: new Map([['s-live', gjcTarget]]),
      liveSessionKinds: new Map([['s-live', 'interactive']]),
      liveSessionRunning: new Set<string>(),
      selectedSession: null,
      onProjectSelect,
      onSessionSelect,
      onExternalTerminalOpen: noop,
    });

    assert.ok(
      html.indexOf('>claude<') < html.indexOf('>omg<'),
      'the persisted external row can be ordered before a GJC row',
    );
    assert.ok(html.includes('aria-label="&#x27;claude&#x27; 세션 순서 옮기기"'));
    assert.ok(html.includes('aria-label="&#x27;omg&#x27; 세션 순서 옮기기"'));
    assert.deepEqual(storageReads, ['chatmux.liveSessionOrder.v2']);
  } finally {
    if (originalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalStorage);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }
});


test('SidebarLiveSection keeps pane ordering while a GJC process disappears and returns', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const gjcPane = target('%30', 300).tmux;
  const externalTarget = target('%31', 310);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => key === 'chatmux.liveSessionOrder.v1'
        ? JSON.stringify([
            createSessionOrderId('s-live', gjcPane),
            createSessionOrderId('', externalTarget.tmux),
          ])
        : null,
      setItem: () => {},
    },
  });

  const renderSnapshot = (gjcTarget: TmuxPaneTarget | null, presence: 'present' | 'stale') => (
    renderSection({
      projects: makeProjects(),
      liveSessionIds: new Set(['s-live']),
      externalSessions: [{
        tmuxName: 'external-after',
        tmux: externalTarget.tmux,
        process: externalTarget.process,
        kind: 'codex',
      }],
      liveSessionNames: new Map([['s-live', 'stable-gjc']]),
      liveSessionLineage: new Set(['s-live']),
      liveSessionPanes: new Map([['s-live', gjcPane]]),
      liveSessionPresence: new Map([['s-live', presence]]),
      liveSessionTargets: gjcTarget
        ? new Map([['s-live', gjcTarget]])
        : new Map<string, TmuxPaneTarget>(),
      liveSessionKinds: new Map([['s-live', 'interactive']]),
      liveSessionRunning: new Set<string>(),
      selectedSession: null,
      onProjectSelect,
      onSessionSelect,
      onExternalTerminalOpen: noop,
    })
  );

  try {
    const present = await renderSnapshot({ tmux: gjcPane, process: target('%30', 300).process }, 'present');
    const missing = await renderSnapshot(null, 'stale');
    const restored = await renderSnapshot({ tmux: gjcPane, process: target('%30', 999).process }, 'present');

    for (const html of [present, missing, restored]) {
      assert.ok(
        html.indexOf('>stable-gjc<') < html.indexOf('>external-after<'),
        'the stored pane order survives process loss and a new generation',
      );
      assert.ok(html.includes('aria-label="&#x27;stable-gjc&#x27; 세션 순서 옮기기"'));
    }
  } finally {
    if (originalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalStorage);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }
});
