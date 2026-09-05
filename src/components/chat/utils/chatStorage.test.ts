import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { clearHostIdentity, setLocalHostIdentity } from '../../../fleet/hostIdentity';
import { queuedDraftKey } from '../../../fleet/persistedHostState';

import { draftInputKey, readDraftInput, safeLocalStorage } from './chatStorage';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';

function fixture(context: TestContext, initial: Record<string, string>) {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = { ...initial } as Record<string, unknown> & Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  Object.defineProperties(storage, {
    getItem: { value: (key: string) => storage[key] as string | undefined ?? null },
    setItem: { configurable: true, value: (key: string, value: string) => { storage[key] = value; } },
    removeItem: { value: (key: string) => { delete storage[key]; } },
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  clearHostIdentity();
  setLocalHostIdentity(LOCAL);
  context.after(() => {
    clearHostIdentity();
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  return storage as Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

test('legacy project drafts are claimed only by the authoritative local host', (context) => {
  const storage = fixture(context, { draft_input_project: 'legacy draft' });
  assert.equal(readDraftInput('project', PEER), '');
  assert.equal(storage.getItem('draft_input_project'), 'legacy draft');
  assert.equal(readDraftInput('project', LOCAL), 'legacy draft');
  assert.equal(storage.getItem(draftInputKey('project', LOCAL)), 'legacy draft');
  assert.equal(storage.getItem('draft_input_project'), null);
  assert.equal(readDraftInput('project', PEER), '');
});

test('migration preserves an existing qualified destination and its legacy source', (context) => {
  const storage = fixture(context, {
    draft_input_project: 'legacy draft',
    [draftInputKey('project', LOCAL)]: 'current draft',
  });
  assert.equal(readDraftInput('project', LOCAL), 'current draft');
  assert.equal(storage.getItem('draft_input_project'), 'legacy draft');
});

test('failed migration leaves the original draft available', (context) => {
  const storage = fixture(context, { draft_input_project: 'legacy draft' });
  context.mock.method(console, 'warn', () => {});
  context.mock.method(storage, 'setItem', () => { throw new DOMException('full', 'QuotaExceededError'); });
  assert.equal(readDraftInput('project', LOCAL), 'legacy draft');
  assert.equal(storage.getItem('draft_input_project'), 'legacy draft');
  assert.equal(storage.getItem(draftInputKey('project', LOCAL)), null);
});

test('quota failure preserves unrelated raw, project and remote queued drafts', (context) => {
  const saved = {
    draft_input_other: 'unsent raw draft',
    [draftInputKey('project', LOCAL)]: 'unsent local draft',
    [queuedDraftKey({ hostId: PEER, localId: 'session' })]: JSON.stringify({ content: 'remote queue' }),
  };
  const storage = fixture(context, saved);
  const setItem = storage.setItem;
  let failOnce = true;
  context.mock.method(console, 'warn', () => {});
  context.mock.method(storage, 'setItem', (key: string, value: string) => {
    if (failOnce) { failOnce = false; throw new DOMException('full', 'QuotaExceededError'); }
    setItem(key, value);
  });
  safeLocalStorage.setItem('draft_input_active', 'new text');
  for (const [key, value] of Object.entries(saved)) assert.equal(storage.getItem(key), value);
});
