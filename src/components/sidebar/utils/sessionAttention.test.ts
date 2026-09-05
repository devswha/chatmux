import assert from 'node:assert/strict';
import test from 'node:test';

import { nextAttentionRow, sessionAttention } from './sessionAttention';

test('attention distinguishes input, completion, unknown, failures and connection issues', () => {
  assert.equal(sessionAttention({ activity: 'asking_user' }), 'input');
  assert.equal(sessionAttention({ activity: 'waiting_user' }), null);
  assert.equal(sessionAttention({ activity: 'unknown' }), null);
  assert.equal(sessionAttention({ activity: 'running' }), null);
  assert.equal(sessionAttention({}), null);
  assert.equal(sessionAttention({ activity: 'error' }), 'failure');
  for (const activity of ['asking_user', 'error'] as const) {
    assert.equal(sessionAttention({ activity, connectionIssue: 'transcript_ambiguous' }), 'connection');
    assert.equal(sessionAttention({ activity, presence: 'stale' }), null);
    assert.equal(sessionAttention({ activity, authority: 'none' }), null);
    assert.equal(sessionAttention({ activity, presence: 'stale', connectionIssue: 'agent_user_mismatch' }), null);
  }
});

test('next attention follows the supplied sidebar order and wraps across resolved or removed rows', () => {
  const rows = ['failure-b', 'ready', 'input-a', 'unknown'];
  const getId = (row: string) => row;
  const matches = (row: string) => row.startsWith('input') || row.startsWith('failure');
  assert.equal(nextAttentionRow(rows, null, getId, matches), 'failure-b');
  assert.equal(nextAttentionRow(rows, 'failure-b', getId, matches), 'input-a');
  assert.equal(nextAttentionRow(rows, 'input-a', getId, matches), 'failure-b');
  assert.equal(nextAttentionRow(rows, 'ready', getId, matches), 'input-a');
  assert.equal(nextAttentionRow(rows, 'removed', getId, matches), 'failure-b');
  assert.equal(nextAttentionRow(rows, 'input-a', getId, (row) => row === 'input-a'), 'input-a');
  assert.equal(nextAttentionRow(rows, null, getId, () => false), null);
  assert.equal(nextAttentionRow([], null, getId, matches), null);
});
