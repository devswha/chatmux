import assert from 'node:assert/strict';
import test from 'node:test';

import type { TmuxPaneTarget } from '../../../../../shared/tmux';

import { completionStatus, handoffProps, makeProjects, noop, onProjectSelect, onSessionSelect, renderSection, target } from './SidebarLiveSection.testSupport';

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
