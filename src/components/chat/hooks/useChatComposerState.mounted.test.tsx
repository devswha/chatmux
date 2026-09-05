import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { clearHostIdentity, setActiveSessionHostId, setLocalHostIdentity } from '../../../fleet/hostIdentity';
import { queuedDraftKey } from '../../../fleet/persistedHostState';
import { draftInputKey, readQueuedMessage } from '../utils/chatStorage';

// Keep composer effects, storage, menu and submit real; omit catalog/file/DOM
// integrations so navigation and individual timer turns can be controlled.
const stubs: Record<string, string> = {
  'react-dropzone': `export const useDropzone = () => ({
    getRootProps: () => ({}), getInputProps: () => ({}), open() {}, isDragActive: false,
  });`,
  './useFileMentions': `export const useFileMentions = () => ({
    filteredFiles: [], setCursorPosition() {}, handleFileMentionsKeyDown: () => false,
  });`,
  './useSlashCommandCatalog': `const commands = [{ name: '/expand', type: 'custom', path: 'commands/expand.md' }];
    export const useSlashCommandCatalog = () => commands;`,
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

async function mountComposer(
  context: TestContext,
  overrides: Partial<Args> = {},
  storageOptions: { initial?: Record<string, string>; quotaFull?: boolean } = {},
) {
  const values = new Map<string, string>(Object.entries(storageOptions.initial ?? {}));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storageOptions.quotaFull) throw new DOMException('full', 'QuotaExceededError');
      values.set(key, value);
    },
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
    confirm: () => true,
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

test('explicit clear survives failed legacy migration and failed tombstone writes', async (context) => {
  context.mock.method(console, 'warn', () => {});
  const unrelated = {
    draft_input_other: 'another project draft',
    [draftInputKey('same-project', HOST_B)]: 'peer draft',
    [queuedDraftKey({ hostId: HOST_B, localId: 'session-a' })]: JSON.stringify({ content: 'peer queue' }),
  };
  const harness = await mountComposer(context, {}, {
    initial: { 'draft_input_same-project': 'legacy draft to clear', ...unrelated }, quotaFull: true,
  });
  assert.equal(harness.composer.input, 'legacy draft to clear');
  assert.equal(harness.values.has(draftInputKey('same-project', HOST_A)), false);
  await act(async () => { harness.composer.handleClearInput(); });
  assert.equal(harness.composer.input, '');
  await harness.remount(HOST_A);
  assert.equal(harness.composer.input, '');
  for (const [key, value] of Object.entries(unrelated)) assert.equal(harness.values.get(key), value);
});

for (const activation of ['click', 'keyboard'] as const) {
  test(`custom command menu ${activation} consumes an unchanged trigger once`, async (context) => {
    const harness = await mountComposer(context);
    let resolveCommand!: (response: Response) => void;
    const request = context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { resolveCommand = resolve; }));
    await harness.input('/expand argument');
    await act(async () => { harness.composer.handleToggleCommandMenu(); });
    await act(async () => {
      if (activation === 'click') {
        harness.composer.handleCommandSelect(harness.composer.filteredCommands[0], 0, false);
      } else {
        harness.composer.handleKeyDown({ key: 'Enter', preventDefault() {}, nativeEvent: {} } as Parameters<Composer['handleKeyDown']>[0]);
      }
    });
    assert.equal(harness.composer.input, '/expand argument', 'menu execution keeps its trigger while awaiting the result');
    await act(async () => { resolveCommand(new Response(JSON.stringify({ type: 'custom', content: 'expanded command' }))); });
    await harness.drainTimers();
    assert.equal(request.mock.callCount(), 1);
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0].content, 'expanded command');
    assert.equal(harness.composer.input, '');
    assert.equal(harness.composer.queuedDraft, null);
    await harness.remount(HOST_A);
    assert.equal(harness.composer.input, '');
  });
}

test('a custom command selected from the menu preserves a newer draft', async (context) => {
  const harness = await mountComposer(context);
  let resolveCommand!: (response: Response) => void;
  const request = context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { resolveCommand = resolve; }));
  await harness.input('/expand argument');
  await act(async () => { harness.composer.handleToggleCommandMenu(); });
  await act(async () => { harness.composer.handleCommandSelect(harness.composer.filteredCommands[0], 0, false); });
  await harness.input('newer unsent draft');
  await act(async () => { resolveCommand(new Response(JSON.stringify({ type: 'custom', content: 'expanded command' }))); });
  await harness.drainTimers();
  assert.equal(request.mock.callCount(), 1);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.composer.input, 'newer unsent draft');
  assert.equal(harness.composer.queuedDraft, null);
});

for (const outcome of ['declined', 'failed'] as const) {
  test(`a ${outcome} menu command is not queued or automatically retried`, async (context) => {
    const harness = await mountComposer(context);
    context.mock.method(console, 'error', () => {});
    context.mock.method(window, 'confirm', () => false);
    const request = context.mock.method(globalThis, 'fetch', async () => outcome === 'failed'
      ? new Response(JSON.stringify({ error: 'command failed' }), { status: 500 })
      : new Response(JSON.stringify({ type: 'custom', content: 'expanded command', hasBashCommands: true })));
    await harness.input('/expand argument');
    await act(async () => { harness.composer.handleToggleCommandMenu(); });
    await act(async () => { harness.composer.handleCommandSelect(harness.composer.filteredCommands[0], 0, false); });
    await harness.drainTimers();
    assert.equal(request.mock.callCount(), 1);
    assert.deepEqual(harness.sent, []);
    assert.equal(harness.composer.input, '/expand argument');
    assert.equal(harness.composer.queuedDraft, null);
    assert.equal(readQueuedMessage('session-a'), null);
  });
}

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

test('two immediate submits during image preparation dispatch the snapshot only once', async (context) => {
  const harness = await mountComposer(context);
  const uploads: Array<(response: Response) => void> = [];
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { uploads.push(resolve); }));
  await harness.input('one message');
  await act(async () => { harness.composer.setAttachedImages([new File(['image'], 'image.png')]); });
  const submissions: Promise<void>[] = [];
  await act(async () => {
    submissions.push(harness.composer.handleSubmit(submitEvent));
    submissions.push(harness.composer.handleSubmit(submitEvent));
  });
  await act(async () => {
    for (const resolve of uploads) resolve(new Response(JSON.stringify({ images: [{ path: '/fixture/image.png' }] })));
    await Promise.all(submissions);
  });
  assert.equal(harness.sent.length, 1);
  assert.equal(uploads.length, 1);
  assert.equal(harness.sent[0].content, 'one message');
  assert.equal(harness.composer.queuedDraft, null);
});

test('a submit during preparation leaves the next draft unsent until fresh user intent', async (context) => {
  const harness = await mountComposer(context);
  const uploads: Array<(response: Response) => void> = [];
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { uploads.push(resolve); }));
  await harness.input('first message');
  await act(async () => { harness.composer.setAttachedImages([new File(['image'], 'image.png')]); });
  let sending!: Promise<void>;
  await act(async () => { sending = harness.composer.handleSubmit(submitEvent); });
  await harness.input('next draft');
  await harness.submit();
  assert.equal(uploads.length, 1);
  assert.equal(harness.composer.input, 'next draft');
  assert.equal(harness.composer.queuedDraft, null);
  await act(async () => {
    uploads[0](new Response(JSON.stringify({ images: [] })));
    await sending;
  });
  await harness.drainTimers();
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.composer.input, 'next draft');
  await harness.submit();
  assert.deepEqual(harness.sent.map((message) => message.content), ['first message', 'next draft']);
});

test('failed ordinary uploads retain their files and allow an explicit retry', async (context) => {
  const harness = await mountComposer(context);
  context.mock.method(console, 'error', () => {});
  let failed = true;
  const upload = context.mock.method(globalThis, 'fetch', async () => failed
    ? new Response('', { status: 500 })
    : new Response(JSON.stringify({ images: [{ path: '/fixture/image.png' }] })));
  const file = new File(['image'], 'image.png');
  await harness.input('retry explicitly');
  await act(async () => { harness.composer.setAttachedImages([file]); });
  await harness.submit();
  await harness.drainTimers();
  assert.equal(upload.mock.callCount(), 1);
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.composer.input, 'retry explicitly');
  assert.equal(harness.composer.attachedImages[0], file);
  failed = false;
  await harness.submit();
  assert.equal(upload.mock.callCount(), 2);
  assert.equal(harness.sent.length, 1);
  assert.deepEqual(harness.composer.attachedImages, []);
});

test('preparation remains guarded through session allocation and releases after allocation failure', async (context) => {
  const harness = await mountComposer(context, { selectedSession: null, currentSessionId: null });
  context.mock.method(console, 'error', () => {});
  const allocations: Array<(response: Response) => void> = [];
  let uploads = 0;
  context.mock.method(globalThis, 'fetch', (url: Parameters<typeof fetch>[0]) => {
    if (url === '/api/assets/images') {
      uploads += 1;
      return Promise.resolve(new Response(JSON.stringify({ images: [{ path: '/fixture/image.png' }] })));
    }
    assert.equal(url, '/api/providers/sessions');
    return new Promise<Response>((resolve) => { allocations.push(resolve); });
  });
  const file = new File(['image'], 'image.png');
  await harness.input('new session message');
  await act(async () => { harness.composer.setAttachedImages([file]); });
  let sending!: Promise<void>;
  await act(async () => { sending = harness.composer.handleSubmit(submitEvent); });
  await harness.submit();
  assert.equal(uploads, 1);
  assert.equal(allocations.length, 1);
  await act(async () => { allocations[0](new Response('', { status: 500 })); await sending; });
  await harness.drainTimers();
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.composer.input, 'new session message');
  assert.equal(harness.composer.attachedImages[0], file);
  await act(async () => { sending = harness.composer.handleSubmit(submitEvent); });
  assert.equal(uploads, 2);
  assert.equal(allocations.length, 2);
  await act(async () => {
    allocations[1](new Response(JSON.stringify({ data: { sessionId: 'created' } })));
    await sending;
  });
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].sessionId, 'created');
  assert.deepEqual(harness.composer.attachedImages, []);
});

test('an old scope finishing cannot release a new scope preparation or consume its draft', async (context) => {
  const harness = await mountComposer(context);
  const uploads: Array<(response: Response) => void> = [];
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { uploads.push(resolve); }));
  const oldFile = new File(['old'], 'image.png');
  const nextFile = new File(['new'], 'image.png');
  await harness.input('old scope');
  await act(async () => { harness.composer.setAttachedImages([oldFile]); });
  let oldSend!: Promise<void>;
  await act(async () => { oldSend = harness.composer.handleSubmit(submitEvent); });
  await harness.update({ selectedSession: { id: 'session-b' } as Args['selectedSession'], currentSessionId: 'session-b' });
  await harness.input('new scope');
  await act(async () => { harness.composer.setAttachedImages([nextFile]); });
  let nextSend!: Promise<void>;
  await act(async () => { nextSend = harness.composer.handleSubmit(submitEvent); });
  await act(async () => { uploads[0](new Response(JSON.stringify({ images: [] }))); await oldSend; });
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.composer.input, 'new scope');
  assert.equal(harness.composer.attachedImages[0], nextFile);
  await harness.submit();
  assert.equal(uploads.length, 2, 'the new preparation stays guarded');
  await act(async () => { uploads[1](new Response(JSON.stringify({ images: [] }))); await nextSend; });
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].sessionId, 'session-b');
});

test('an accepted menu expansion can dispatch while an ordinary upload is pending', async (context) => {
  const harness = await mountComposer(context);
  let resolveUpload!: (response: Response) => void;
  const request = context.mock.method(globalThis, 'fetch', (url: Parameters<typeof fetch>[0]) => {
    if (url === '/api/commands/execute') return Promise.resolve(new Response(JSON.stringify({ type: 'custom', content: 'expanded command' })));
    assert.equal(url, '/api/assets/images');
    return new Promise<Response>((resolve) => { resolveUpload = resolve; });
  });
  await harness.input('ordinary message');
  await act(async () => { harness.composer.setAttachedImages([new File(['image'], 'image.png')]); });
  let sending!: Promise<void>;
  await act(async () => { sending = harness.composer.handleSubmit(submitEvent); });
  await harness.input('/expand argument');
  await act(async () => { harness.composer.handleToggleCommandMenu(); });
  await act(async () => { harness.composer.handleCommandSelect(harness.composer.filteredCommands[0], 0, false); });
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].content, 'expanded command');
  assert.equal(harness.composer.input, '');
  await harness.input('newer unsent draft');
  await act(async () => { resolveUpload(new Response(JSON.stringify({ images: [] }))); await sending; });
  await harness.drainTimers();
  assert.deepEqual(harness.sent.map((message) => message.content), ['expanded command', 'ordinary message']);
  assert.equal(harness.composer.input, 'newer unsent draft');
  assert.equal(harness.composer.queuedDraft, null);
  assert.equal(request.mock.callCount(), 2);
});

test('an uncertain send is never retried by preparation cleanup', async (context) => {
  let attempts = 0;
  const harness = await mountComposer(context, { sendMessage: () => { attempts += 1; throw new Error('outcome unknown'); } });
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ images: [] })));
  const file = new File(['image'], 'image.png');
  await harness.input('uncertain message');
  await act(async () => { harness.composer.setAttachedImages([file]); });
  await act(async () => { await assert.rejects(harness.composer.handleSubmit(submitEvent), /outcome unknown/); });
  await harness.drainTimers();
  assert.equal(attempts, 1);
  assert.equal(harness.composer.queuedDraft, null);
  assert.equal(harness.composer.input, 'uncertain message');
  assert.equal(harness.composer.attachedImages[0], file);
});

test('typing a next draft during upload does not repeat the original image on the next send', async (context) => {
  const harness = await mountComposer(context);
  let resolveUpload!: (response: Response) => void;
  const upload = context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { resolveUpload = resolve; }));
  await harness.input('first message');
  await act(async () => { harness.composer.setAttachedImages([new File(['original'], 'image.png')]); });
  let sending!: Promise<void>;
  await act(async () => { sending = harness.composer.handleSubmit(submitEvent); });
  await harness.input('next message');
  await act(async () => {
    resolveUpload(new Response(JSON.stringify({ images: [{ path: '/fixture/image.png' }] })));
    await sending;
  });
  assert.equal(harness.composer.input, 'next message');
  assert.deepEqual(harness.composer.attachedImages, []);
  await harness.submit();
  assert.equal(upload.mock.callCount(), 1);
  assert.equal(harness.sent[1].content, 'next message');
  assert.deepEqual(harness.sent[1].options.images, []);
});

for (const changesInput of [false, true]) {
  test(`successful upload removes only its image objects when the next input is ${changesInput ? 'changed' : 'unchanged'}`, async (context) => {
    const harness = await mountComposer(context);
    let resolveUpload!: (response: Response) => void;
    const requests: FormData[] = [];
    context.mock.method(globalThis, 'fetch', (_url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
      requests.push(options?.body as FormData);
      if (requests.length > 1) return Promise.resolve(new Response(JSON.stringify({ images: [{ path: '/fixture/next.png' }] })));
      return new Promise<Response>((resolve) => { resolveUpload = resolve; });
    });
    // Equal metadata does not make these the same attachment.
    const original = new File(['original'], 'image.png', { type: 'image/png', lastModified: 1 });
    const added = new File(['new-file'], 'image.png', { type: 'image/png', lastModified: 1 });
    await harness.input('original message');
    await act(async () => { harness.composer.setAttachedImages([original]); });
    let sending!: Promise<void>;
    await act(async () => { sending = harness.composer.handleSubmit(submitEvent); });
    if (changesInput) await harness.input('next message');
    await act(async () => { harness.composer.setAttachedImages((previous) => [...previous, added]); });
    await act(async () => {
      resolveUpload(new Response(JSON.stringify({ images: [{ path: '/fixture/original.png' }] })));
      await sending;
    });
    assert.equal(harness.composer.input, changesInput ? 'next message' : '');
    assert.equal(harness.composer.attachedImages.length, 1);
    assert.equal(harness.composer.attachedImages[0], added);
    if (!changesInput) await harness.input('next message');
    await harness.submit();
    const nextImages = requests[1].getAll('images') as File[];
    assert.equal(nextImages.length, 1);
    assert.equal(await nextImages[0].text(), 'new-file');
    assert.deepEqual(harness.composer.attachedImages, []);
  });
}

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

test('a replacement queue can finish before the revoked upload and preserves next-draft images', async (context) => {
  const harness = await mountComposer(context, { isLoading: true });
  const uploads: Array<(response: Response) => void> = [];
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { uploads.push(resolve); }));
  await harness.input('old queue');
  await act(async () => { harness.composer.setAttachedImages([new File(['old'], 'image.png')]); });
  await harness.submit();
  await harness.update({ isLoading: false });
  await harness.nextTimer();
  await act(async () => { harness.composer.deleteQueuedDraft(); });
  await harness.update({ isLoading: true });
  await harness.input('replacement queue');
  await act(async () => { harness.composer.setAttachedImages([new File(['replacement'], 'image.png')]); });
  await harness.submit();
  await harness.update({ isLoading: false });
  await harness.nextTimer();
  assert.equal(uploads.length, 2);
  const nextFile = new File(['next'], 'image.png');
  await harness.input('next draft');
  await act(async () => { harness.composer.setAttachedImages([nextFile]); });
  await act(async () => { uploads[1](new Response(JSON.stringify({ images: [] }))); });
  await act(async () => { uploads[0](new Response(JSON.stringify({ images: [] }))); });
  await harness.drainTimers();
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].content, 'replacement queue');
  assert.equal(readQueuedMessage('session-a'), null);
  assert.equal(harness.composer.input, 'next draft');
  assert.equal(harness.composer.attachedImages[0], nextFile);
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
