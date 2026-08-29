import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useRelayImageAssets, type RelayAssetStatus } from './useRelayImageAssets';

const WORKSPACE = '/workspace/project';
const ALLOWED = '/home/user/.chatmux/assets/1-a.png';

type Harness = {
  readonly assets: () => ReturnType<typeof useRelayImageAssets>;
  readonly inserted: readonly string[];
  readonly status: () => RelayAssetStatus;
  readonly dispose: () => void;
};

function mount(): Harness {
  const inserted: string[] = [];
  let latest: ReturnType<typeof useRelayImageAssets> | undefined;
  function Surface() {
    latest = useRelayImageAssets({
      workspacePath: WORKSPACE,
      insertPath: (path) => { inserted.push(path); },
      uploadFailedText: 'upload-failed',
      pathRejectedText: 'path-rejected',
    });
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => { renderer = TestRenderer.create(createElement(Surface)); });
  const active = renderer;
  assert.ok(active);
  const assets = () => {
    assert.ok(latest);
    return latest;
  };
  return {
    assets,
    inserted,
    status: () => assets().status,
    dispose: () => act(() => { active.unmount(); }),
  };
}

function stubUpload(images: readonly { readonly name: string; readonly path: string }[]): {
  readonly calls: readonly { readonly url: string; readonly formData: boolean }[];
  readonly restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: { url: string; formData: boolean }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), formData: options?.body instanceof FormData });
    return {
      headers: { get: () => null },
      ok: true,
      json: async () => ({ images }),
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const image = () => new File(['fake'], 'a.png', { type: 'image/png' });
const textFile = () => new File(['plain'], 'a.txt', { type: 'text/plain' });

const pasteEvent = (files: readonly File[]) => {
  let prevented = 0;
  return {
    event: {
      clipboardData: { items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })) },
      preventDefault: () => { prevented += 1; },
    },
    prevented: () => prevented,
  };
};

const dropEvent = (files: readonly File[]) => {
  let prevented = 0;
  return {
    event: {
      dataTransfer: { files, items: files.map((file) => ({ kind: 'file', type: file.type })) },
      preventDefault: () => { prevented += 1; },
    },
    prevented: () => prevented,
  };
};

test('Given an allowed image, when it is uploaded, then exactly one request reaches the shared asset store', async (t) => {
  // Given
  const upload = stubUpload([{ name: 'a.png', path: ALLOWED }]);
  t.after(upload.restore);
  const harness = mount();
  t.after(harness.dispose);

  // When
  await act(async () => { await harness.assets().upload([image()]); });

  // Then
  assert.deepEqual(upload.calls, [{ url: '/api/assets/images', formData: true }]);
  assert.deepEqual(harness.inserted, [ALLOWED]);
  assert.deepEqual(harness.status(), { kind: 'idle' });
});

test('Given a returned path outside the project and the asset store, when it is uploaded, then nothing is inserted', async (t) => {
  // Given
  const upload = stubUpload([{ name: 'a.png', path: '/etc/passwd' }]);
  t.after(upload.restore);
  const harness = mount();
  t.after(harness.dispose);

  // When
  await act(async () => { await harness.assets().upload([image()]); });

  // Then
  assert.deepEqual(harness.inserted, []);
  assert.deepEqual(harness.status(), { kind: 'error', text: 'path-rejected' });
});

test('Given a paste and a drop of the same image, when each is handled, then each uploads once through the one handler', async (t) => {
  // Given
  const upload = stubUpload([{ name: 'a.png', path: ALLOWED }]);
  t.after(upload.restore);
  const harness = mount();
  t.after(harness.dispose);
  const paste = pasteEvent([image()]);
  const drop = dropEvent([image()]);

  // When
  await act(async () => {
    harness.assets().handlePaste(paste.event as never);
    harness.assets().handleDrop(drop.event as never);
  });

  // Then
  assert.equal(upload.calls.length, 2);
  assert.deepEqual([...new Set(upload.calls.map((call) => call.url))], ['/api/assets/images']);
  assert.equal(paste.prevented(), 1);
  assert.equal(drop.prevented(), 1);
});

test('Given a paste or drop with no image, when each is handled, then no request is made and the event is not swallowed', async (t) => {
  // Given
  const upload = stubUpload([]);
  t.after(upload.restore);
  const harness = mount();
  t.after(harness.dispose);
  const paste = pasteEvent([textFile()]);
  const drop = dropEvent([textFile()]);

  // When
  await act(async () => {
    harness.assets().handlePaste(paste.event as never);
    harness.assets().handleDrop(drop.event as never);
  });

  // Then
  assert.equal(upload.calls.length, 0);
  assert.equal(paste.prevented(), 0);
  assert.equal(drop.prevented(), 0);
});
