import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../types/app';

import { mergeExpandedSessionPages, projectMergeKey, upsertSessionIntoProject, type SessionUpsertedEvent } from './projectsStateMerge';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

function project(hostId: string | undefined, sessionIds: readonly string[]): Project {
  return {
    projectId: 'project-1',
    displayName: 'chatmux',
    fullPath: '/home/dev/chatmux',
    ...(hostId === undefined ? {} : { hostId }),
    sessions: sessionIds.map((id) => ({ id })),
    sessionMeta: { total: sessionIds.length, hasMore: false },
  };
}

test('Given one project id on two hosts, when merge keys are derived, then they stay distinct', () => {
  // Given / When / Then
  assert.notEqual(projectMergeKey(project(HOST_A, [])), projectMergeKey(project(HOST_B, [])));
  assert.equal(projectMergeKey(project(HOST_A, [])), projectMergeKey(project(HOST_A, ['x'])));
});

test('Given the same project id on two hosts, when expanded pages merge, then no host inherits the other rows', () => {
  // Given
  const previous = [project(HOST_A, ['a-1', 'a-2', 'a-3'])];
  const incoming = [project(HOST_B, ['b-1'])];

  // When
  const merged = mergeExpandedSessionPages(previous, incoming);

  // Then
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sessions?.map((session) => session.id), ['b-1']);
});

test('Given one host with more loaded pages, when its own incoming page merges, then the deeper page survives', () => {
  // Given
  const previous = [project(HOST_A, ['a-1', 'a-2', 'a-3'])];
  const incoming = [project(HOST_A, ['a-1'])];

  // When
  const merged = mergeExpandedSessionPages(previous, incoming);

  // Then
  assert.deepEqual(merged[0].sessions?.map((session) => session.id), ['a-1', 'a-2', 'a-3']);
});

test('Given a session upsert from another host, when applied to a local project, then the project is unchanged', () => {
  // Given
  const target = project(HOST_A, ['a-1']);
  const event: SessionUpsertedEvent = {
    kind: 'session_upserted',
    hostId: HOST_B,
    sessionId: 'a-1',
    provider: 'claude',
    session: { id: 'a-1', summary: 'remote summary' },
    project: {
      projectId: 'project-1',
      path: '/home/dev/chatmux',
      fullPath: '/home/dev/chatmux',
      displayName: 'chatmux',
      isStarred: false,
    },
  };

  // When
  const merged = upsertSessionIntoProject(target, event);

  // Then
  assert.equal(merged, target, 'a foreign host event must not touch this project');
});

test('Given a session upsert from the owning host, when applied, then the session is updated', () => {
  // Given
  const target = project(HOST_A, ['a-1']);
  const event: SessionUpsertedEvent = {
    kind: 'session_upserted',
    hostId: HOST_A,
    sessionId: 'a-1',
    provider: 'claude',
    session: { id: 'a-1', summary: 'local summary' },
    project: null,
  };

  // When
  const merged = upsertSessionIntoProject(target, event);

  // Then
  assert.equal(merged.sessions?.[0].summary, 'local summary');
});

test('Given a legacy upsert without a host, when applied to an unqualified project, then it still merges', () => {
  // Given
  const target = project(undefined, ['a-1']);
  const event: SessionUpsertedEvent = {
    kind: 'session_upserted',
    sessionId: 'a-1',
    provider: 'claude',
    session: { id: 'a-1', summary: 'legacy summary' },
    project: null,
  };

  // When
  const merged = upsertSessionIntoProject(target, event);

  // Then
  assert.equal(merged.sessions?.[0].summary, 'legacy summary');
});
