import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { clearHostIdentity, setActiveSessionHostId, setLocalHostIdentity } from '../../../fleet/hostIdentity';
import { readQueuedMessage } from '../utils/chatStorage';

// Keep composer effects, storage and submit real; omit unrelated menu/file/DOM
// integrations so navigation and individual timer turns can be controlled.
const stubs: Record<string, string> = {
  'react-dropzone': `export const useDropzone = () => ({
    getRootProps: () => ({}), getInputProps: () => ({}), open() {}, isDragActive: false,
  });`,
  './useFileMentions': `export const useFileMentions = () => ({
    filteredFiles: [], setCursorPosition() {}, handleFileMentionsKeyDown: () => false,
  });`,
  './useSlashCommands': `export const useSlashCommands = () => ({
    slashCommands: [{ name: '/expand', type: 'custom', path: 'commands/expand.md' }],
    resetCommandMenuState() {}, handleCommandInputChange() {},
    handleCommandMenuKeyDown: () => false,
  });`,
};
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = stubs[specifier];
    return source
      ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const { useChatComposerState } = await import('./useChatComposerState');
moduleHooks.deregister();

type Composer = ReturnType<typeof useChatComposerState>;
type Args = Parameters<typeof useChatComposerState>[0];
const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';
const submitEvent = { preventDefault() {} } as Parameters<Composer['handleSubmit']>[0];

async function mountComposer(context: TestContext, overrides: Partial<Args> = {}) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  context.mock.method(globalThis, 'setTimeout', ((run: () => void, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { at: now + delay, run });
    return id;
  }) as unknown as typeof setTimeout);
  context.mock.method(globalThis, 'clearTimeout', ((id: number) => {
    timers.delete(id);
  }) as unknown as typeof clearTimeout);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    innerHeight: 720, addEventListener() {}, removeEventListener() {},
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  clearHostIdentity();
  setLocalHostIdentity(HOST_A);
  setActiveSessionHostId(HOST_A);

  const sent: Array<{ sessionId: string; content: string; options: Record<string, unknown> }> = [];
  let args: Args = {
    selectedProject: { projectId: 'same-project', displayName: 'Fixture', fullPath: '/fixture', path: '/fixture' },
    selectedSession: { id: 'session-a' } as Args['selectedSession'],
    currentSessionId: 'session-a', provider: 'claude', permissionMode: 'default',
    cyclePermissionMode() {}, resolvePermissionModeForProvider: () => 'default',
    cursorModel: 'cursor', claudeModel: 'original-model', codexModel: 'codex',
    currentProviderEffort: 'high', opencodeModel: 'opencode', ompModel: 'omp',
    isLoading: false, canAbortSession: false, tokenBudget: null,
    sendMessage: (message) => { sent.push(message as typeof sent[number]); },
    scrollToBottom() {}, addMessage() {}, setIsUserScrolledUp() {}, setPendingPermissionRequests() {},
    ...overrides,
  };
  let composer!: Composer;
  function Probe() {
    composer = useChatComposerState(args);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(createElement(Probe)); });
  context.after(async () => {
    await act(async () => { renderer.unmount(); });
    clearHostIdentity();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  return {
    get composer() { return composer; },
    sent,
    values,
    async input(value: string) { await act(async () => { composer.setInput(value); }); },
    async submit() { await act(async () => { await composer.handleSubmit(submitEvent); }); },
    async update(next: Partial<Args>) {
      args = { ...args, ...next };
      await act(async () => { renderer.update(createElement(Probe)); });
    },
    async remount(hostId: string) {
      setActiveSessionHostId(hostId);
      args = { ...args, selectedProject: { ...args.selectedProject!, hostId } };
      await act(async () => { renderer.update(createElement(Probe, { key: hostId })); });
    },
    async unmount() { await act(async () => { renderer.unmount(); }); },
    async nextTimer() {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) return false;
      timers.delete(next[0]);
      now = next[1].at;
      await act(async () => { next[1].run(); });
      return true;
    },
    async drainTimers() {
      for (let count = 0; timers.size > 0; count++) {
        assert.ok(count < 20, 'composer timers should settle');
        await this.nextTimer();
      }
    },
  };
}

test('queued completion sends its saved text and settings without erasing the next draft', async (context) => {
  const harness = await mountComposer(context, { isLoading: true });
  await harness.input('queued message');
  await harness.submit();
  assert.equal(readQueuedMessage('session-a')?.content, 'queued message');
  await harness.input('still composing the next message');
  await harness.update({ isLoading: false, claudeModel: 'different-model' });
  await harness.drainTimers();
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].content, 'queued message');
  assert.equal(harness.composer.input, 'still composing the next message');
  assert.equal(harness.sent[0].options.model, 'original-model');
  assert.equal(readQueuedMessage('session-a'), null);
});

test('navigation between queue timer turns cannot dispatch from an unmounted composer', async (context) => {
  const harness = await mountComposer(context, { isLoading: true });
  await harness.input('queued message');
  await harness.submit();
  await harness.update({ isLoading: false });
  await harness.nextTimer();
  const sentBeforeNavigation = harness.sent.length;
  await harness.unmount();
  await harness.drainTimers();
  assert.equal(harness.sent.length, sentBeforeNavigation);
});

test('navigation before queued completion preserves the original session queue', async (context) => {
  const harness = await mountComposer(context, { isLoading: true });
  await harness.input('queued message');
  await harness.submit();
  await harness.update({ isLoading: false });
  await harness.unmount();
  await harness.drainTimers();
  assert.deepEqual(harness.sent, []);
  assert.equal(readQueuedMessage('session-a')?.content, 'queued message');
});

test('host-keyed remounts keep equal project IDs and unsent drafts separate', async (context) => {
  const harness = await mountComposer(context);
  await harness.input('host A draft');
  await harness.remount(HOST_B);
  assert.equal(harness.composer.input, '');
  await harness.input('host B draft');
  await harness.remount(HOST_A);
  assert.equal(harness.composer.input, 'host A draft');
  await harness.remount(HOST_B);
  assert.equal(harness.composer.input, 'host B draft');
  assert.deepEqual(harness.sent, []);
});

test('clearing a qualified draft cannot resurrect an older retained legacy draft', async (context) => {
  const harness = await mountComposer(context);
  await harness.input('current local draft');
  harness.values.set('draft_input_same-project', 'older legacy draft');
  await act(async () => { harness.composer.handleClearInput(); });
  await harness.remount(HOST_A);
  assert.equal(harness.composer.input, '');
  assert.equal(harness.values.get('draft_input_same-project'), 'older legacy draft');
});

test('an image upload resolving after navigation cannot send or erase the retained draft', async (context) => {
  const harness = await mountComposer(context);
  let resolveUpload!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { resolveUpload = resolve; }));
  await harness.input('draft with an image');
  await act(async () => { harness.composer.setAttachedImages([new File(['image'], 'image.png')]); });
  let sending!: Promise<void>;
  await act(async () => { sending = harness.composer.handleSubmit(submitEvent); });
  await harness.unmount();
  await act(async () => {
    resolveUpload(new Response(JSON.stringify({ images: [{ path: '/fixture/image.png' }] })));
    await sending;
  });
  assert.deepEqual(harness.sent, []);
  assert.ok([...harness.values.values()].includes('draft with an image'));
});

test('typing during an image upload preserves the newer draft after the original send', async (context) => {
  const harness = await mountComposer(context);
  let resolveUpload!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { resolveUpload = resolve; }));
  await harness.input('original message');
  await act(async () => { harness.composer.setAttachedImages([new File(['image'], 'image.png')]); });
  let sending!: Promise<void>;
  await act(async () => { sending = harness.composer.handleSubmit(submitEvent); });
  await harness.input('newer unsent draft');
  await act(async () => {
    resolveUpload(new Response(JSON.stringify({ images: [] })));
    await sending;
  });
  assert.equal(harness.sent[0].content, 'original message');
  assert.equal(harness.composer.input, 'newer unsent draft');
});

test('a queued upload interrupted by navigation retains its queue and the next draft', async (context) => {
  const harness = await mountComposer(context, { isLoading: true });
  let resolveUpload!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { resolveUpload = resolve; }));
  await harness.input('queued image message');
  await act(async () => { harness.composer.setAttachedImages([new File(['image'], 'image.png')]); });
  await harness.submit();
  await harness.input('next draft');
  await harness.update({ isLoading: false });
  while (!resolveUpload && await harness.nextTimer()) { /* advance to the pending upload */ }
  assert.ok(resolveUpload, 'queue preparation starts');
  await harness.unmount();
  await act(async () => { resolveUpload(new Response(JSON.stringify({ images: [] }))); });
  assert.deepEqual(harness.sent, []);
  assert.equal(readQueuedMessage('session-a')?.content, 'queued image message');
  assert.ok([...harness.values.values()].includes('next draft'));
});

test('failed queued uploads remain editable and do not retry automatically', async (context) => {
  const harness = await mountComposer(context, { isLoading: true });
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }));
  context.mock.method(console, 'error', () => {});
  await harness.input('queued image message');
  await act(async () => { harness.composer.setAttachedImages([new File(['image'], 'image.png')]); });
  await harness.submit();
  await harness.update({ isLoading: false });
  await harness.drainTimers();
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(harness.composer.queuedDraft?.content, 'queued image message');
  assert.equal(readQueuedMessage('session-a')?.content, 'queued image message');
  assert.deepEqual(harness.sent, []);
  await act(async () => { harness.composer.editQueuedDraft(); });
  assert.equal(harness.composer.input, 'queued image message');
});

test('replacing a queue while its upload is pending revokes the old payload', async (context) => {
  const harness = await mountComposer(context, { isLoading: true });
  let resolveUpload!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { resolveUpload = resolve; }));
  await harness.input('old queued image');
  await act(async () => { harness.composer.setAttachedImages([new File(['image'], 'image.png')]); });
  await harness.submit();
  await harness.update({ isLoading: false });
  while (!resolveUpload && await harness.nextTimer()) { /* advance to the pending upload */ }
  await act(async () => { harness.composer.deleteQueuedDraft(); });
  await harness.update({ isLoading: true });
  await harness.input('replacement queue');
  await harness.submit();
  await act(async () => { resolveUpload(new Response(JSON.stringify({ images: [] }))); });
  assert.deepEqual(harness.sent, []);
  assert.equal(readQueuedMessage('session-a')?.content, 'replacement queue');
});

test('read-only ownership revokes an upload that started in an editable session', async (context) => {
  const harness = await mountComposer(context);
  let resolveUpload!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { resolveUpload = resolve; }));
  await harness.input('pending message');
  await act(async () => { harness.composer.setAttachedImages([new File(['image'], 'image.png')]); });
  let sending!: Promise<void>;
  await act(async () => { sending = harness.composer.handleSubmit(submitEvent); });
  await harness.update({ isSessionReadOnly: true });
  await act(async () => {
    resolveUpload(new Response(JSON.stringify({ images: [] })));
    await sending;
  });
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.composer.input, 'pending message');
});

test('late session allocation cannot navigate or send after leaving a new conversation', async (context) => {
  const established: string[] = [];
  const harness = await mountComposer(context, {
    selectedSession: null, currentSessionId: null,
    onSessionEstablished: (id) => { established.push(id); },
  });
  let resolveAllocation!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { resolveAllocation = resolve; }));
  await harness.input('new conversation draft');
  let sending!: Promise<void>;
  await act(async () => { sending = harness.composer.handleSubmit(submitEvent); });
  await harness.unmount();
  await act(async () => {
    resolveAllocation(new Response(JSON.stringify({ data: { sessionId: 'allocated' } })));
    await sending;
  });
  assert.deepEqual(established, []);
  assert.deepEqual(harness.sent, []);
  assert.ok([...harness.values.values()].includes('new conversation draft'));
});

test('a late custom command response cannot submit after navigation', async (context) => {
  const harness = await mountComposer(context);
  let resolveCommand!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { resolveCommand = resolve; }));
  await harness.input('/expand');
  await harness.submit();
  await harness.unmount();
  await act(async () => { resolveCommand(new Response(JSON.stringify({ type: 'custom', content: 'expanded command' }))); });
  await harness.drainTimers();
  assert.deepEqual(harness.sent, []);
});

test('queued slash commands preserve the next draft and dispatch their expansion once', async (context) => {
  const harness = await mountComposer(context, { isLoading: true });
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ type: 'custom', content: 'expanded command' })));
  await harness.input('/expand');
  await harness.submit();
  await harness.input('next draft');
  await harness.update({ isLoading: false, claudeModel: 'different-model' });
  await harness.drainTimers();
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].content, 'expanded command');
  assert.equal(harness.sent[0].options.model, 'original-model');
  assert.equal(harness.composer.input, 'next draft');
});

test('session and ownership transitions leave queues with their original targets', async (context) => {
  const harness = await mountComposer(context, { isLoading: true });
  await harness.input('session A queue');
  await harness.submit();
  await harness.update({ selectedSession: { id: 'session-b' } as Args['selectedSession'], currentSessionId: 'session-b', isLoading: false });
  await harness.drainTimers();
  assert.deepEqual(harness.sent, []);
  assert.equal(readQueuedMessage('session-a')?.content, 'session A queue');
  assert.equal(readQueuedMessage('session-b'), null);
  await harness.update({ selectedSession: { id: 'session-a' } as Args['selectedSession'], currentSessionId: 'session-a', isSessionReadOnly: true });
  await harness.drainTimers();
  assert.deepEqual(harness.sent, []);
  assert.equal(readQueuedMessage('session-a')?.content, 'session A queue');
});
