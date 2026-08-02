import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  DiscoveryRow,
  DiscoverySnapshot,
} from '@/modules/providers/services/discovery-collector.service.js';
import { getCachedTmuxInteractiveActivity } from '@/modules/providers/services/tmux-interactive-prompt.service.js';
import {
  createTmuxOutputActivityMonitor,
  tmuxControlOutputPaneId,
  tmuxObserverIsSafe,
  type TmuxControlObserverFactory,
} from '@/modules/providers/services/tmux-output-activity-monitor.service.js';
import { createVerifiedTmuxActionTarget } from '@/modules/providers/services/tmux-fresh-verifier.service.js';

const SCREENS = {
  gjc: `
Which batch size should we test?
╭─────────────────────────╮
│❯ Batch 1               │
│  Batch 4               │
│  Batch 8               │
│  Other (type your own) │
╰─────────────────────────╯
up/down navigate  enter select  esc cancel
`,
  codex: `
Would you like to run the following command?

$ curl -I https://example.com

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with curl
  3. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel
`,
  omp: `
╭─ Ask ───────────────────╮
│ Which target?           │
├─────────────────────────┤
│❯ ○ Jetson Orin         │
│  ○ RK3588               │
│  ○ Other (type your own)│
├─────────────────────────┤
│ Enter select · n note · ↑/↓ move · Esc cancel
╰─────────────────────────╯
`,
  claude: `
Ready to code?

Here is Claude's plan:
Add a heading to the README file.

Claude has written up a plan and is ready to execute. Would you like to proceed?

❯ 1. Yes, auto-accept edits
  2. Yes, manually approve edits
  3. No, refine the plan
  4. Tell Claude what to change
     shift+tab to approve with this feedback
`,
} as const;

type SupportedKind = keyof typeof SCREENS;

const CUSTOM_SCREENS: Record<SupportedKind, { menu: string; input: string }> = {
  gjc: {
    menu: `
Choose an action
╭─────────────────────────╮
│❯ Allow                 │
│  Reject                │
│  Other (type your own) │
╰─────────────────────────╯
up/down navigate  enter select  esc cancel
`,
    input: `
Choose an action
│  Allow │
│  Reject │
│❯ Other (type your own) │
>
enter submit  esc back to options  ctrl+g external editor
`,
  },
  codex: {
    menu: `
Question 1/1 (1 unanswered)
Choose an action
› 1. Allow
  2. Reject
  3. None of the above
tab to add notes | enter to submit answer | esc to interrupt
`,
    input: `
Choose an action
3. None of the above
› Add notes
tab or esc to clear notes | enter to submit answer
`,
  },
  omp: {
    menu: `
╭─ Ask ───────────────────╮
│ Choose an action        │
├─────────────────────────┤
│❯ ○ Allow               │
│  ○ Reject              │
│  ○ Other (type your own)│
├─────────────────────────┤
│ Enter select · n note · ↑/↓ move · Esc cancel
╰─────────────────────────╯
`,
    input: `
Custom answer: Choose an action
>
enter or ctrl+q submit  esc cancel
`,
  },
  claude: {
    menu: `
☐ Action

Choose an action

❯ 1. Allow
  2. Reject
  3. Type something.
────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`,
    input: `
Choose an action
  1. Allow
  2. Reject
❯ 3. Type something.
  4. Chat about this
Enter to select · ↑/↓ to navigate · ctrl+g to edit in VS Code · Esc to cancel
`,
  },
};

function row(kind: SupportedKind, index: number): DiscoveryRow {
  return {
    key: `external-${kind}-${index}`,
    lane: kind === 'gjc' ? 'live' : 'external',
    tmuxName: `${kind}-${index}`,
    tmux: {
      socketPath: '/tmp/chatmux-output-monitor-test.sock',
      sessionId: `$${index}`,
      windowId: `@${index}`,
      paneId: `%${index}`,
    },
    process: { pid: 1_000 + index, startedAtMs: 10_000 + index },
    kind,
    providerSessionId: `${kind}-session-${index}`,
    activity: 'running',
    cwd: '/tmp',
    lastSeenRevision: 1,
    presence: 'present',
    staleSinceRevision: null,
  };
}

function snapshot(rows: readonly DiscoveryRow[], revision = 1): DiscoverySnapshot {
  return {
    epoch: 'test',
    revision,
    takenAtMs: revision,
    rows,
    health: {
      external: { ok: true, lastOkRevision: revision, consecutiveFailures: 0 },
      live: { ok: true, lastOkRevision: revision, consecutiveFailures: 0 },
    },
  };
}

function fakeCollector(initial: DiscoverySnapshot) {
  let current = initial;
  let refreshes = 0;
  const listeners = new Set<(value: DiscoverySnapshot) => void>();
  return {
    source: {
      currentSnapshot: () => current,
      forceRefresh: () => { refreshes += 1; },
      onSnapshot: (listener: (value: DiscoverySnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(value: DiscoverySnapshot) {
      current = value;
      for (const listener of listeners) listener(value);
    },
    refreshes: () => refreshes,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function targetFor(session: DiscoveryRow) {
  assert.ok(session.process);
  assert.ok(
    session.kind === 'gjc'
    || session.kind === 'codex'
    || session.kind === 'omp'
    || session.kind === 'claude',
  );
  return createVerifiedTmuxActionTarget(
    session.tmux,
    session.process,
    session.kind,
    session.tmuxName,
    session.providerSessionId,
  );
}

test('parses normal and extended tmux control-mode output bells', () => {
  assert.equal(tmuxControlOutputPaneId('%output %27 hello'), '%27');
  assert.equal(tmuxControlOutputPaneId('%extended-output %31 25 : hello'), '%31');
  assert.equal(tmuxControlOutputPaneId('%session-changed $1 demo'), null);
  assert.equal(tmuxControlOutputPaneId('ordinary terminal output'), null);
});

test('keeps GJC, Codex, OMP, and Claude INPUT states without an open chat', async () => {
  const rows = (Object.keys(SCREENS) as SupportedKind[]).map((kind, index) => row(kind, index + 1));
  const collector = fakeCollector(snapshot(rows));
  const screens = new Map<string, string>(rows.map((session) => [
    session.tmux.paneId,
    SCREENS[session.kind as SupportedKind],
  ]));
  const outputs = new Map<string, (paneId: string) => void>();
  const transcriptRef: { current: ((change: {
    provider: SupportedKind;
    providerSessionId: string | null;
    changedAtMs: number;
  }) => void) | null } = { current: null };
  let captures = 0;
  const observerFactory: TmuxControlObserverFactory = (session, onOutput) => {
    outputs.set(session.sessionId, onOutput);
    return { close: () => outputs.delete(session.sessionId) };
  };
  const monitor = createTmuxOutputActivityMonitor(collector.source, {
    quietMs: 5,
    maxWaitMs: 20,
    clearConfirmMs: 10,
    fallbackMs: 60_000,
    canObserveSession: async () => true,
    observerFactory,
    capture: async (target) => {
      captures += 1;
      return screens.get(target.tmux.paneId) ?? '';
    },
    subscribeTranscript: (listener) => {
      transcriptRef.current = listener;
      return () => { transcriptRef.current = null; };
    },
  });

  monitor.start();
  await waitFor(() => rows.every((session) => (
    getCachedTmuxInteractiveActivity(targetFor(session)) === 'asking_user'
  )));
  assert.equal(monitor.observerCount(), 0);
  assert.equal(captures, 4);
  assert.equal(collector.refreshes(), 4);

  // A stable screen retains INPUT indefinitely; no 2.5-second request cache
  // is involved in the observer-owned state.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(rows.every((session) => (
    getCachedTmuxInteractiveActivity(targetFor(session)) === 'asking_user'
  )));

  for (const session of rows) {
    screens.set(session.tmux.paneId, 'Task complete.\n› Ask another question');
    transcriptRef.current?.({
      provider: session.kind as SupportedKind,
      providerSessionId: session.providerSessionId,
      changedAtMs: Date.now(),
    });
  }
  await waitFor(() => rows.every((session) => (
    getCachedTmuxInteractiveActivity(targetFor(session)) === null
  )));
  assert.ok(collector.refreshes() >= 8);
  monitor.dispose();
});

test('coalesces an output burst and captures only the changed pane once', async () => {
  const session = {
    ...row('codex', 20),
    providerSessionId: null,
    activity: 'unknown' as const,
  };
  const collector = fakeCollector(snapshot([session]));
  let screen = 'Working';
  let captures = 0;
  const outputRef: { current: ((paneId: string) => void) | null } = { current: null };
  const monitor = createTmuxOutputActivityMonitor(collector.source, {
    quietMs: 15,
    maxWaitMs: 100,
    clearConfirmMs: 10,
    fallbackMs: 60_000,
    canObserveSession: async () => true,
    observerFactory: (_identity, onOutput) => {
      outputRef.current = onOutput;
      return { close: () => undefined };
    },
    capture: async () => {
      captures += 1;
      return screen;
    },
    subscribeTranscript: () => () => undefined,
  });
  monitor.start();
  await waitFor(() => captures === 1 && outputRef.current !== null);

  screen = SCREENS.codex;
  const emitOutput = outputRef.current;
  assert.ok(emitOutput);
  for (let index = 0; index < 20; index += 1) emitOutput(session.tmux.paneId);
  await waitFor(() => (
    getCachedTmuxInteractiveActivity(targetFor(session)) === 'asking_user'
  ));
  assert.equal(captures, 2);
  monitor.dispose();
});

test('uses the transcript bell for a mapped RUN pane without keeping a control client', async () => {
  const session = row('claude', 25);
  const collector = fakeCollector(snapshot([session]));
  const transcriptRef: { current: ((change: {
    provider: SupportedKind;
    providerSessionId: string | null;
    changedAtMs: number;
  }) => void) | null } = { current: null };
  let screen = 'Working';
  let captures = 0;
  let observers = 0;
  const monitor = createTmuxOutputActivityMonitor(collector.source, {
    quietMs: 5,
    fallbackMs: 60_000,
    canObserveSession: async () => true,
    observerFactory: () => {
      observers += 1;
      return { close: () => undefined };
    },
    capture: async () => {
      captures += 1;
      return screen;
    },
    subscribeTranscript: (listener) => {
      transcriptRef.current = listener;
      return () => { transcriptRef.current = null; };
    },
  });
  monitor.start();
  await waitFor(() => captures === 1);
  assert.equal(observers, 0);

  screen = SCREENS.claude;
  transcriptRef.current?.({
    provider: 'claude',
    providerSessionId: session.providerSessionId,
    changedAtMs: Date.now(),
  });
  await waitFor(() => (
    getCachedTmuxInteractiveActivity(targetFor(session)) === 'asking_user'
  ));
  assert.equal(observers, 0);
  assert.equal(captures, 2);
  monitor.dispose();
});

test('emits one action edge when a RUN pane becomes INPUT', async () => {
  const session = row('codex', 26);
  const collector = fakeCollector(snapshot([session]));
  const transcriptRef: { current: ((change: {
    provider: SupportedKind;
    providerSessionId: string | null;
    changedAtMs: number;
  }) => void) | null } = { current: null };
  let screen = 'Working';
  const actions: string[] = [];
  const monitor = createTmuxOutputActivityMonitor(collector.source, {
    quietMs: 5,
    clearConfirmMs: 5,
    fallbackMs: 60_000,
    canObserveSession: async () => true,
    observerFactory: () => ({ close: () => undefined }),
    capture: async () => screen,
    subscribeTranscript: (listener) => {
      transcriptRef.current = listener;
      return () => { transcriptRef.current = null; };
    },
    onInputRequired: (target) => { actions.push(target.tmux.paneId); },
  });
  const emitTranscript = () => transcriptRef.current?.({
    provider: 'codex',
    providerSessionId: session.providerSessionId,
    changedAtMs: Date.now(),
  });

  monitor.start();
  await waitFor(() => transcriptRef.current !== null);
  screen = SCREENS.codex;
  emitTranscript();
  await waitFor(() => actions.length === 1);
  emitTranscript();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(actions, [session.tmux.paneId], 'the same visible prompt is not repeated');

  screen = 'Working';
  emitTranscript();
  await waitFor(() => getCachedTmuxInteractiveActivity(targetFor(session)) === null);
  screen = SCREENS.codex;
  emitTranscript();
  await waitFor(() => actions.length === 2);
  monitor.dispose();
});

test('baselines startup and rebound INPUT panes until their RUN state is observed', async () => {
  const session = row('codex', 27);
  const collector = fakeCollector(snapshot([session]));
  const transcriptRef: { current: ((change: {
    provider: SupportedKind;
    providerSessionId: string | null;
    changedAtMs: number;
  }) => void) | null } = { current: null };
  let screen: string = SCREENS.codex;
  const occurrences: string[] = [];
  const monitor = createTmuxOutputActivityMonitor(collector.source, {
    quietMs: 5,
    clearConfirmMs: 5,
    fallbackMs: 60_000,
    canObserveSession: async () => true,
    observerFactory: () => ({ close: () => undefined }),
    capture: async () => screen,
    subscribeTranscript: (listener) => {
      transcriptRef.current = listener;
      return () => { transcriptRef.current = null; };
    },
    onInputRequired: (_target, occurrenceKey) => { occurrences.push(occurrenceKey); },
  });
  const emitTranscript = (providerSessionId = session.providerSessionId) => transcriptRef.current?.({
    provider: 'codex',
    providerSessionId,
    changedAtMs: Date.now(),
  });

  monitor.start();
  await waitFor(() => (
    getCachedTmuxInteractiveActivity(targetFor(session)) === 'asking_user'
  ));
  assert.deepEqual(occurrences, [], 'startup INPUT is a baseline');

  screen = 'Working';
  emitTranscript();
  await waitFor(() => getCachedTmuxInteractiveActivity(targetFor(session)) === null);
  screen = SCREENS.codex;
  emitTranscript();
  await waitFor(() => occurrences.length === 1);

  const rebound = { ...session, providerSessionId: 'codex-session-27-rebound' };
  collector.emit(snapshot([rebound], 2));
  await waitFor(() => (
    getCachedTmuxInteractiveActivity(targetFor(rebound)) === 'asking_user'
  ));
  assert.equal(occurrences.length, 1, 'rebound INPUT is a baseline');

  screen = 'Working';
  emitTranscript(rebound.providerSessionId);
  await waitFor(() => getCachedTmuxInteractiveActivity(targetFor(rebound)) === null);
  screen = SCREENS.codex;
  emitTranscript(rebound.providerSessionId);
  await waitFor(() => occurrences.length === 2);
  assert.notEqual(occurrences[0], occurrences[1]);
  monitor.dispose();
});

test('keeps INPUT while every provider switches from Other to direct input', async () => {
  const rows = (Object.keys(CUSTOM_SCREENS) as SupportedKind[])
    .map((kind, index) => row(kind, index + 40));
  const collector = fakeCollector(snapshot(rows));
  const screens = new Map<string, string>(rows.map((session) => [
    session.tmux.paneId,
    CUSTOM_SCREENS[session.kind as SupportedKind].menu,
  ]));
  const outputs = new Map<string, (paneId: string) => void>();
  const transcriptRef: { current: ((change: {
    provider: SupportedKind;
    providerSessionId: string | null;
    changedAtMs: number;
  }) => void) | null } = { current: null };
  let captures = 0;
  const monitor = createTmuxOutputActivityMonitor(collector.source, {
    quietMs: 5,
    maxWaitMs: 20,
    clearConfirmMs: 10,
    fallbackMs: 60_000,
    canObserveSession: async () => true,
    observerFactory: (session, onOutput) => {
      outputs.set(session.sessionId, onOutput);
      return { close: () => undefined };
    },
    capture: async (target) => {
      captures += 1;
      return screens.get(target.tmux.paneId) ?? '';
    },
    subscribeTranscript: (listener) => {
      transcriptRef.current = listener;
      return () => { transcriptRef.current = null; };
    },
  });
  monitor.start();
  await waitFor(() => rows.every((session) => (
    getCachedTmuxInteractiveActivity(targetFor(session)) === 'asking_user'
  )));

  for (const session of rows) {
    screens.set(
      session.tmux.paneId,
      CUSTOM_SCREENS[session.kind as SupportedKind].input,
    );
    transcriptRef.current?.({
      provider: session.kind as SupportedKind,
      providerSessionId: session.providerSessionId,
      changedAtMs: Date.now(),
    });
  }
  await waitFor(() => captures >= rows.length * 2);
  assert.ok(rows.every((session) => (
    getCachedTmuxInteractiveActivity(targetFor(session)) === 'asking_user'
  )));

  for (const session of rows) {
    screens.set(session.tmux.paneId, 'Task complete.');
    transcriptRef.current?.({
      provider: session.kind as SupportedKind,
      providerSessionId: session.providerSessionId,
      changedAtMs: Date.now(),
    });
  }
  await waitFor(() => rows.every((session) => (
    getCachedTmuxInteractiveActivity(targetFor(session)) === null
  )));
  monitor.dispose();
});

test('falls back to screen inspection when control-mode observation is unsafe', async () => {
  const session = {
    ...row('claude', 30),
    providerSessionId: null,
    activity: 'unknown' as const,
  };
  const collector = fakeCollector(snapshot([session]));
  let captures = 0;
  let observers = 0;
  const monitor = createTmuxOutputActivityMonitor(collector.source, {
    fallbackMs: 15,
    canObserveSession: async () => false,
    observerFactory: () => {
      observers += 1;
      return { close: () => undefined };
    },
    capture: async () => {
      captures += 1;
      return SCREENS.claude;
    },
    subscribeTranscript: () => () => undefined,
    warn: () => undefined,
  });
  monitor.start();
  await waitFor(() => (
    getCachedTmuxInteractiveActivity(targetFor(session)) === 'asking_user'
  ));
  assert.equal(observers, 0);
  assert.ok(captures >= 1);
  monitor.dispose();
});

test('control-mode observation is unsafe when destroy-unattached is set at any scope', async () => {
  const identity = { socketPath: '/tmp/tmux-x/default', sessionId: '$7' };
  const runner = (values: { global: string; session: string; exit: string }, failSession = false) =>
    async (args: string[]) => {
      if (args.includes('exit-unattached')) return { code: 0, output: `${values.exit}\n` };
      if (args.includes('-t')) {
        return failSession
          ? { code: 1, output: '' }
          : { code: 0, output: `${values.session}\n` };
      }
      return { code: 0, output: `${values.global}\n` };
    };

  assert.equal(await tmuxObserverIsSafe(identity, runner({ global: 'off', session: '', exit: 'off' })), true);
  // Session-local override must be honored even when the global value is off.
  assert.equal(await tmuxObserverIsSafe(identity, runner({ global: 'off', session: 'on', exit: 'off' })), false);
  // keep-last / keep-group can still destroy the observed session.
  assert.equal(await tmuxObserverIsSafe(identity, runner({ global: 'off', session: 'keep-last', exit: 'off' })), false);
  assert.equal(await tmuxObserverIsSafe(identity, runner({ global: 'keep-group', session: '', exit: 'off' })), false);
  assert.equal(await tmuxObserverIsSafe(identity, runner({ global: 'on', session: '', exit: 'off' })), false);
  assert.equal(await tmuxObserverIsSafe(identity, runner({ global: 'off', session: '', exit: 'on' })), false);
  // Unknown settings are unsafe, never a green light to attach.
  assert.equal(await tmuxObserverIsSafe(identity, runner({ global: 'off', session: '', exit: 'off' }, true)), false);
});
