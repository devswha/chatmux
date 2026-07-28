import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../types/app';

import {
  mergeExpandedSessionPages,
  mergeSessionProviderLists,
  upsertSessionIntoProject,
  type SessionUpsertedEvent,
} from './projectsStateMerge';

const project = (sessions: Project['sessions'], total = sessions?.length ?? 0): Project => ({
  projectId: 'project-1',
  displayName: 'Project 1',
  fullPath: '/workspace/project-1',
  sessions,
  sessionMeta: { total, hasMore: (sessions?.length ?? 0) < total },
});

test('project session page merges preserve loaded rows and deduplicate by session id', () => {
  const previous = project([{ id: 'one' }, { id: 'two' }], 3);
  const incoming = project([{ id: 'one', summary: 'updated' }], 3);

  const expanded = mergeExpandedSessionPages([previous], [incoming]);
  assert.deepEqual(expanded[0].sessions, [{ id: 'one', summary: 'updated' }, { id: 'two' }]);
  assert.deepEqual(expanded[0].sessionMeta, { total: 3, hasMore: true });

  assert.deepEqual(
    mergeSessionProviderLists([{ id: '1' }], [{ id: 1 as unknown as string }, { id: '2' }]),
    [{ id: '1' }, { id: '2' }],
  );
});

test('session upserts replace aliases without blanking a known summary and prepend new rows', () => {
  const existing = project([{ id: 'provider-session', summary: 'Known title' }], 1);
  const replacement = upsertSessionIntoProject(existing, {
    sessionId: 'canonical-session',
    providerSessionId: 'provider-session',
    provider: 'claude',
    session: { id: 'provider-session', summary: '' },
  } as SessionUpsertedEvent);

  assert.deepEqual(replacement.sessions, [{
    id: 'canonical-session',
    summary: 'Known title',
    __provider: 'claude',
  }]);
  assert.equal(replacement.sessionMeta?.total, 1);

  const inserted = upsertSessionIntoProject(existing, {
    sessionId: 'new-session',
    provider: 'claude',
    session: { id: 'new-session', summary: 'New title' },
  } as SessionUpsertedEvent);
  assert.deepEqual(inserted.sessions?.map((session) => session.id), ['new-session', 'provider-session']);
  assert.deepEqual(inserted.sessionMeta, { total: 2, hasMore: false });
});
