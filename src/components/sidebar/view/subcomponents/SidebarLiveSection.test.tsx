import assert from 'node:assert/strict';
import test from 'node:test';

import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import koSidebar from '../../../../i18n/locales/ko/sidebar.json';
import type { Project, ProjectSession } from '../../../../types/app';
import type { TmuxPaneTarget } from '../../../../../shared/tmux';
import type { ExternalCliSession } from '../../hooks/useExternalCliSessions';
import { createSessionOrderId } from '../../utils/sessionOrder';
import {
  CompletionNotificationsContext,
  completionNotificationDescriptorKey,
} from '../../context/CompletionNotificationsContext';

import SidebarLiveSection from './SidebarLiveSection';

const target = (paneId: string, pid: number): TmuxPaneTarget => ({
  tmux: { socketPath: '/tmp/chatmux.sock', sessionId: 'session-1', windowId: '@1', paneId },
  process: { pid, startedAtMs: 1_700_000_000_000 + pid },
});


const noop = () => {};
const onSessionSelect = noop as unknown as (session: ProjectSession, projectName: string) => void;
const onProjectSelect = noop as unknown as (project: Project) => void;

// The section's strings are ko-authored i18n resources; rendering with the ko
// locale keeps these SSR assertions pinned to the shipped translations.
const completionStatus = (sessionId: string, watched = true) => [
  completionNotificationDescriptorKey({ kind: 'app' as const, provider: 'gjc', sessionId }),
  {
    item: { alias: 'owner', mappingState: 'one_active' as const, reason: 'eligible' as const, target: { alias: 'owner', kind: 'app' as const, revision: 1, watched } },
    target: { alias: 'owner', kind: 'app' as const, revision: 1, watched },
    pending: false,
    error: null,
    globalPaused: false,
    device: { supported: true, registered: true, setupRequired: false, reason: null },
  },
] as const;

const renderSection = async (
  props: React.ComponentProps<typeof SidebarLiveSection>,
  statuses: readonly (readonly [string, unknown])[] = [],
) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'ko',
    fallbackLng: false,
    resources: { ko: { sidebar: koSidebar } },
    ns: ['sidebar'],
    defaultNS: 'sidebar',
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: instance },
      createElement(
        CompletionNotificationsContext.Provider,
        {
          value: {
            status: null,
            statuses: new Map(statuses),
            registerDescriptors: () => () => {},
            setWatch: async () => {},
            repairDevice: async () => {},
            refresh: async () => {},
          } as never,
        },
        createElement(SidebarLiveSection, props),
      ),
    ),
  );
};

function makeProjects(): Project[] {
  return [
    {
      projectId: 'p1',
      displayName: 'Proj One',
      sessions: [
        { id: 's-live', summary: 'Live conversation title', provider: 'gjc' },
        { id: 's-idle', summary: 'Idle conversation', provider: 'gjc' },
      ],
    },
  ] as unknown as Project[];
}

const handoffProps = ({
  gjcPresence = 'present',
  gjcTarget,
  externalTarget,
  externalPresence = 'present',
  externalAuthority = 'stream',
}: {
  gjcPresence?: 'present' | 'stale';
  gjcTarget: TmuxPaneTarget;
  externalTarget: TmuxPaneTarget;
  externalPresence?: 'present' | 'stale';
  externalAuthority?: 'stream' | 'rest' | 'none';
}): React.ComponentProps<typeof SidebarLiveSection> => ({
  projects: makeProjects(),
  liveSessionIds: new Set(['s-live']),
  externalSessions: [{
    tmuxName: 'external-row',
    tmux: externalTarget.tmux,
    process: externalTarget.process,
    kind: 'claude',
    presence: externalPresence,
    authority: externalAuthority,
  }],
  liveSessionNames: new Map([['s-live', 'gjc-row']]),
  liveSessionLineage: new Set(['s-live']),
  liveSessionPanes: new Map([['s-live', gjcTarget.tmux]]),
  liveSessionPresence: new Map([['s-live', gjcPresence]]),
  liveSessionTargets: new Map([['s-live', gjcTarget]]),
  liveSessionKinds: new Map([['s-live', 'interactive']]),
  liveSessionRunning: new Set<string>(),
  selectedSession: null,
  onProjectSelect,
  onSessionSelect,
  onExternalTerminalOpen: noop,
});

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
        return key === 'chatmux.liveSessionOrder.v1'
          ? JSON.stringify([
              createSessionOrderId('', externalTarget.tmux),
              createSessionOrderId('s-live', gjcTarget.tmux),
            ])
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
    assert.deepEqual(storageReads, ['chatmux.liveSessionOrder.v1']);
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

test('SidebarLiveSection deduplicates one pane reported by GJC and an external provider', async () => {
  const sharedTarget = target('%7', 7);
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    externalSessions: [{
      tmuxName: 'duplicate-claude',
      tmux: sharedTarget.tmux,
      process: sharedTarget.process,
      kind: 'claude',
    }],
    liveSessionNames: new Map([['s-live', 'gjc-wins']]),
    liveSessionLineage: new Set(['s-live']),
    liveSessionTargets: new Map([['s-live', sharedTarget]]),
    liveSessionKinds: new Map([['s-live', 'interactive']]),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
    onExternalTerminalOpen: noop,
  });

  assert.ok(html.includes('>gjc-wins<'));
  assert.ok(!html.includes('>duplicate-claude<'));
  assert.equal(html.match(/aria-label="[^"]*세션 순서 옮기기"/g)?.length, 1);
});

test('SidebarLiveSection prefers fresh external evidence over stale GJC identity', async () => {
  const html = await renderSection(handoffProps({
    gjcPresence: 'stale',
    gjcTarget: target('%20', 200),
    externalTarget: target('%20', 100),
  }));

  assert.ok(html.includes('>external-row<'));
  assert.ok(!html.includes('>gjc-row<'));
});

test('SidebarLiveSection prefers fresh GJC evidence over stale external identity', async () => {
  const html = await renderSection(handoffProps({
    gjcTarget: target('%21', 100),
    externalTarget: target('%21', 200),
    externalPresence: 'stale',
  }));

  assert.ok(html.includes('>gjc-row<'));
  assert.ok(!html.includes('>external-row<'));
});

test('SidebarLiveSection resolves a present provider handoff by process generation', async () => {
  const externalNewer = await renderSection(handoffProps({
    gjcTarget: target('%22', 100),
    externalTarget: target('%22', 200),
  }));
  const gjcNewer = await renderSection(handoffProps({
    gjcTarget: target('%23', 300),
    externalTarget: target('%23', 200),
  }));

  assert.ok(externalNewer.includes('>external-row<'));
  assert.ok(!externalNewer.includes('>gjc-row<'));
  assert.ok(gjcNewer.includes('>gjc-row<'));
  assert.ok(!gjcNewer.includes('>external-row<'));
});

test('SidebarLiveSection keeps two stale handoff reports as one inert GJC identity row', async () => {
  const html = await renderSection(handoffProps({
    gjcPresence: 'stale',
    gjcTarget: target('%24', 100),
    externalTarget: target('%24', 200),
    externalPresence: 'stale',
  }), [completionStatus('s-live')]);

  assert.ok(html.includes('>gjc-row<'));
  assert.ok(!html.includes('>external-row<'));
  assert.equal(html.match(/aria-label="[^"]*세션 순서 옮기기"/g)?.length, 1);
  assert.match(html, /aria-disabled="true"/);
  assert.doesNotMatch(html, />READY</);
  assert.doesNotMatch(html, />RUN</);
  assert.doesNotMatch(html, />ERROR</);
  assert.doesNotMatch(html, /이 세션의 어시스턴트 응답 준비 완료 알림/);
  assert.doesNotMatch(html, /tmux 세션 &#x27;gjc-row&#x27; 닫기/);
});

test('SidebarLiveSection renders an external-only roster in the unified sortable list', async () => {
  const externalTarget = target('%8', 8);
  const html = await renderSection({
    projects: [],
    liveSessionIds: new Set<string>(),
    externalSessions: [{
      tmuxName: 'external-only',
      tmux: externalTarget.tmux,
      process: externalTarget.process,
      kind: 'codex',
    }],
    liveSessionNames: new Map(),
    liveSessionLineage: new Set<string>(),
    liveSessionTargets: new Map<string, TmuxPaneTarget>(),
    liveSessionKinds: new Map<string, string>(),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
    onExternalTerminalOpen: noop,
  });

  assert.ok(html.includes('>external-only<'));
  assert.ok(html.includes('aria-label="&#x27;external-only&#x27; 세션 순서 옮기기"'));
});

test('SidebarLiveSection hides a live transcript that has no tmux pane', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map(),
    liveSessionLineage: new Set<string>(),
    liveSessionTargets: new Map<string, TmuxPaneTarget>(),
    liveSessionKinds: new Map<string, string>(),
    liveSessionRunning: new Set(['s-live']),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });
  assert.equal(html, '', 'non-tmux processes stay in transcript history, not the tmux roster');
});
test('SidebarLiveSection renders a completion bell for a matched GJC row without kill lineage', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map([['s-live', 'unclaimed']]),
    liveSessionLineage: new Set<string>(),
    liveSessionTargets: new Map<string, TmuxPaneTarget>(),
    liveSessionKinds: new Map([['s-live', 'interactive']]),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  }, [completionStatus('s-live')]);
  assert.ok(html.includes('이 세션의 어시스턴트 응답 준비 완료 알림 끄기'));
  assert.ok(!html.includes(koSidebar.liveSessions.closeSessionTitle.replace('{{name}}', 'unclaimed').replace(/'/g, '&#x27;')), 'no-lineage rows remain non-killable');
});


test('SidebarLiveSection renders nothing when no session is live', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set<string>(),
    liveSessionNames: new Map(),
    liveSessionLineage: new Set<string>(),
    liveSessionTargets: new Map<string, TmuxPaneTarget>(),
    liveSessionKinds: new Map<string, string>(),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });
  assert.equal(html, '');
});

test('SidebarLiveSection renders first-message GJC panes as READY', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['idle-gjc:flask']),
    liveSessionNames: new Map([['idle-gjc:flask', 'flask']]),
    liveSessionLineage: new Set(['idle-gjc:flask']),
    liveSessionTargets: new Map([['idle-gjc:flask', target('%9', 9)]]),
    liveSessionKinds: new Map([['idle-gjc:flask', 'interactive']]),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  }, [completionStatus('idle-gjc:flask')]);
  assert.ok(html.includes(koSidebar.liveSessions.closeSessionTitle.replace('{{name}}', 'flask').replace(/'/g, '&#x27;')), 'lineage-grade idle rows keep the close control');
  assert.ok(html.includes('>READY<'), 'first-message rows use the unified READY state');
  assert.ok(!html.includes('>LIVE<'), 'the obsolete LIVE state is not rendered');
  assert.ok(html.includes('눌러서 첫 대화 시작'), 'opens a full pending transcript view');
  assert.ok(html.includes("tmux 세션 &#x27;flask&#x27;에서 첫 대화 시작"), 'the idle row itself is clickable');
  assert.ok(!html.includes('첫 메시지 보내기'), 'idle rows no longer render an inline first-message composer');
  assert.ok(html.includes(koSidebar.liveSessions.closeSessionTitle.replace('{{name}}', 'flask').replace(/'/g, '&#x27;')), 'lineage-grade idle rows keep the close control');
  assert.ok(!html.includes('이 세션의 어시스턴트 응답 준비 완료 알림'), 'synthetic idle rows omit completion bells');
});

test('SidebarLiveSection explains why an unsafe GJC binding was excluded', async () => {
  const id = 'idle-gjc:foreign:%91';
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set([id]),
    liveSessionNames: new Map([[id, 'foreign']]),
    liveSessionLineage: new Set<string>(),
    liveSessionTargets: new Map<string, TmuxPaneTarget>(),
    liveSessionKinds: new Map([[id, 'interactive']]),
    liveSessionRunning: new Set<string>(),
    liveSessionConnectionIssues: new Map([[id, 'agent_home_mismatch']]),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });
  assert.ok(html.includes('GJC 연결 제외: ChatMux와 HOME 경로가 다릅니다.'));
});

test('SidebarLiveSection badges a batch gjc row (foreground command is not gjc)', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map([['s-live', 'stock']]),
    liveSessionLineage: new Set(['s-live']),
    liveSessionTargets: new Map([['s-live', target('%2', 2)]]),
    liveSessionKinds: new Map([['s-live', 'batch']]),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });
  // A batch GJC descendant remains ready and kill-eligible, while its execution
  // shape is visually distinguished from the activity state.
  assert.ok(html.includes('>READY<'), 'an idle batch row is READY');
  assert.ok(html.includes('>BATCH<'), 'a batch GJC descendant carries the English BATCH tag');
});

// Regression: a session whose transcript tail shows a turn in progress must be
// visually distinct (green RUN) from one ready for input (blue READY).
test('SidebarLiveSection badges an in-progress turn as RUN, not READY', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map([['s-live', 'omg']]),
    liveSessionLineage: new Set(['s-live']),
    liveSessionTargets: new Map([['s-live', target('%1', 1)]]),
    liveSessionKinds: new Map([['s-live', 'interactive']]),
    liveSessionRunning: new Set(['s-live']),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });
  assert.ok(html.includes('>RUN<'), 'an in-progress turn carries the RUN badge');
  assert.ok(!html.includes('>READY<'), 'the same row does not also show READY');
  assert.ok(html.includes('emerald'), 'RUN is styled green, not blue');
});

test('SidebarLiveSection gives an active GJC choice prompt INPUT precedence over RUN', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map([['s-live', 'omg']]),
    liveSessionLineage: new Set(['s-live']),
    liveSessionTargets: new Map([['s-live', target('%1', 1)]]),
    liveSessionKinds: new Map([['s-live', 'interactive']]),
    liveSessionRunning: new Set(['s-live']),
    liveSessionInput: new Set(['s-live']),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });
  assert.ok(html.includes('>INPUT<'));
  assert.ok(!html.includes('>RUN<'));
  assert.ok(!html.includes('>READY<'));
});

test('SidebarLiveSection gives GJC provider failures ERROR precedence over RUN and READY', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-live']),
    liveSessionNames: new Map([['s-live', 'overloaded']]),
    liveSessionLineage: new Set(['s-live']),
    liveSessionTargets: new Map([['s-live', target('%1', 1)]]),
    liveSessionKinds: new Map([['s-live', 'interactive']]),
    liveSessionRunning: new Set(['s-live']),
    liveSessionErrors: new Set(['s-live']),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  });

  assert.ok(html.includes('>ERROR<'));
  assert.ok(!html.includes('>RUN<'));
  assert.ok(!html.includes('>READY<'));
  assert.ok(html.includes('text-red-'));
});

test('SidebarLiveSection makes transcript-backed orphan rows directly openable', async () => {
  const html = await renderSection({
    projects: makeProjects(),
    liveSessionIds: new Set(['s-resumed']),
    liveSessionNames: new Map([['s-resumed', 'resume-pane']]),
    liveSessionLineage: new Set<string>(),
    liveSessionTargets: new Map<string, TmuxPaneTarget>(),
    liveSessionKinds: new Map([['s-resumed', 'interactive']]),
    liveSessionRunning: new Set<string>(),
    selectedSession: null,
    onProjectSelect,
    onSessionSelect,
  }, [completionStatus('s-resumed')]);
  assert.ok(html.includes('<button'), 'a transcript-backed orphan is interactive');
  assert.ok(html.includes('눌러서 이전 대화 열기'), 'explains that the previous transcript opens directly');
  assert.ok(!html.includes('대화 미로딩'), 'does not present pagination as a transcript loading failure');
  assert.ok(html.includes('이 세션의 어시스턴트 응답 준비 완료 알림 끄기'), 'real orphan rows render their completion bell');
});
