import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseExternalJsonlActivity,
  parseOmpTranscriptEnded,
  parseOpenCodeActivity,
  readExternalSessionActivityDetailed,
  readExternalTranscriptEndedDetailed,
  resolveExternalSessionActivity,
} from '@/modules/providers/services/external-session-activity.service.js';

const line = (value: unknown) => JSON.stringify(value);

test('Oh My Pi activity follows the final turn-relevant JSONL message', () => {
  assert.equal(parseExternalJsonlActivity('omp', [
    line({ type: 'message', message: { role: 'user', content: 'go' } }),
    line({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [] } }),
    line({ type: 'message', message: { role: 'toolResult', content: 'ok' } }),
  ].join('\n')), 'running');
  assert.equal(parseExternalJsonlActivity('omp', line({
    type: 'message',
    message: { role: 'assistant', stopReason: 'stop', content: [] },
  })), 'waiting_user');
});

test('Oh My Pi recognizes a native user question inside a tool-use turn', () => {
  assert.equal(parseExternalJsonlActivity('omp', line({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'ask' }],
    },
  })), 'asking_user');
});

test('Oh My Pi transcript-ended matches only a trailing session_exit record', () => {
  assert.equal(parseOmpTranscriptEnded([
    { type: 'message', message: { role: 'assistant', stopReason: 'stop' } },
    { type: 'custom', customType: 'session_exit', data: { reason: 'dispose' } },
  ]), true);
  // A record after session_exit means the stream resumed — not ended.
  assert.equal(parseOmpTranscriptEnded([
    { type: 'custom', customType: 'session_exit' },
    { type: 'message', message: { role: 'user', content: 'resumed' } },
  ]), false);
  assert.equal(parseOmpTranscriptEnded([]), false);
});

test('Claude activity distinguishes tool execution, questions, and completed turns', () => {
  assert.equal(parseExternalJsonlActivity('claude', line({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] },
  })), 'running');
  assert.equal(parseExternalJsonlActivity('claude', line({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion' }] },
  })), 'asking_user');
  assert.equal(parseExternalJsonlActivity('claude', line({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  })), 'waiting_user');
});

test('Codex activity uses explicit task lifecycle events and request_user_input', () => {
  assert.equal(parseExternalJsonlActivity('codex', [
    line({ type: 'event_msg', payload: { type: 'task_complete' } }),
    line({ type: 'event_msg', payload: { type: 'task_started' } }),
  ].join('\n')), 'running');
  assert.equal(parseExternalJsonlActivity('codex', line({
    type: 'response_item',
    payload: { type: 'function_call', name: 'request_user_input' },
  })), 'asking_user');
  assert.equal(parseExternalJsonlActivity('codex', line({
    type: 'event_msg',
    payload: { type: 'task_complete' },
  })), 'waiting_user');
});

test('Cursor activity fails closed and treats unfinished tools as running', () => {
  assert.equal(parseExternalJsonlActivity('cursor', line({
    role: 'assistant',
    content: [{ type: 'tool-call', toolName: 'Read' }],
  })), 'running');
  assert.equal(parseExternalJsonlActivity('cursor', line({
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
  })), 'waiting_user');
  assert.equal(parseExternalJsonlActivity('cursor', 'not-json'), 'unknown');
});

test('OpenCode activity uses assistant completion and pending question parts', () => {
  assert.equal(parseOpenCodeActivity({
    role: 'assistant',
    time: { created: 1 },
  }), 'running');
  assert.equal(parseOpenCodeActivity({
    role: 'assistant',
    time: { created: 1 },
  }, [{ type: 'tool', tool: 'question', state: { status: 'running' } }]), 'asking_user');
  assert.equal(parseOpenCodeActivity({
    role: 'assistant',
    time: { created: 1, completed: 2 },
    finish: 'tool-calls',
  }), 'running');
  assert.equal(parseOpenCodeActivity({
    role: 'assistant',
    time: { created: 1, completed: 2 },
    finish: 'stop',
  }), 'waiting_user');
  assert.equal(parseOpenCodeActivity({
    role: 'assistant',
    time: { created: 1, completed: 2 },
    error: { name: 'APIError' },
  }), 'waiting_user');
});
test('all external provider parsers classify running, waiting, asking, and unknown evidence', () => {
  const jsonlCases = [
    {
      kind: 'omp' as const,
      evidence: {
        running: line({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [] } }),
        waiting_user: line({ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [] } }),
        asking_user: line({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'ask' }] } }),
        unknown: 'not-json',
      },
    },
    {
      kind: 'claude' as const,
      evidence: {
        running: line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } }),
        waiting_user: line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } }),
        asking_user: line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion' }] } }),
        unknown: 'not-json',
      },
    },
    {
      kind: 'codex' as const,
      evidence: {
        running: line({ type: 'event_msg', payload: { type: 'task_started' } }),
        waiting_user: line({ type: 'event_msg', payload: { type: 'task_complete' } }),
        asking_user: line({ type: 'response_item', payload: { type: 'function_call', name: 'request_user_input' } }),
        unknown: 'not-json',
      },
    },
    {
      kind: 'cursor' as const,
      evidence: {
        running: line({ role: 'assistant', content: [{ type: 'tool-call', toolName: 'Read' }] }),
        waiting_user: line({ role: 'assistant', content: [{ type: 'text', text: 'done' }] }),
        asking_user: line({ role: 'assistant', content: [{ type: 'tool-call', toolName: 'question' }] }),
        unknown: 'not-json',
      },
    },
  ];

  for (const { kind, evidence } of jsonlCases) {
    for (const [expected, value] of Object.entries(evidence)) {
      assert.equal(parseExternalJsonlActivity(kind, value), expected, kind);
    }
  }

  const openCodeCases: Array<{
    expected: 'running' | 'waiting_user' | 'asking_user' | 'unknown';
    message: unknown;
    parts?: unknown[];
  }> = [
    { expected: 'running', message: { role: 'assistant', time: { created: 1 } } },
    { expected: 'waiting_user', message: { role: 'assistant', time: { created: 1, completed: 2 }, finish: 'stop' } },
    {
      expected: 'asking_user',
      message: { role: 'assistant', time: { created: 1 } },
      parts: [{ type: 'tool', tool: 'question', state: { status: 'pending' } }],
    },
    { expected: 'unknown', message: { role: 'system' } },
  ];
  for (const { expected, message, parts } of openCodeCases) {
    assert.equal(parseOpenCodeActivity(message, parts), expected, 'opencode');
  }
});

test('resolver returns app metadata for readable evidence and fails closed for unavailable sources', async () => {
  const appSession = {
    session_id: 'app-session',
    project_path: '/workspace/project',
    jsonl_path: '/tmp/transcript.jsonl',
    custom_name: 'External session',
  };
  const resolved = await resolveExternalSessionActivity(
    { kind: 'claude', providerSessionId: 'provider-session' },
    {
      getAppSession: () => appSession,
      readActivity: async (input) => {
        assert.equal(input.jsonlPath, appSession.jsonl_path);
        return { status: 'resolved', activity: 'waiting_user' };
      },
      readTranscriptEnded: async () => ({ status: 'resolved', transcriptEnded: false }),
    },
  );
  assert.deepEqual(resolved, {
    status: 'resolved',
    activity: 'waiting_user',
    appSession: {
      session_id: appSession.session_id,
      project_path: appSession.project_path,
      custom_name: appSession.custom_name,
    },
    transcriptEnded: false,
  });

  const unavailableCases: Array<{
    name: string;
    session: { kind: 'claude' | 'codex'; providerSessionId: string };
    dependencies: Parameters<typeof resolveExternalSessionActivity>[1];
    reasonCode: string;
  }> = [
    {
      name: 'app session database',
      session: { kind: 'claude', providerSessionId: 'provider-session' },
      dependencies: {
        getAppSession: () => {
          throw new Error('database unavailable');
        },
      },
      reasonCode: 'app_session_lookup_unavailable',
    },
    {
      name: 'Codex rollout path',
      session: { kind: 'codex', providerSessionId: 'provider-session' },
      dependencies: {
        getAppSession: () => null,
        resolveCodexRolloutPath: async () => {
          throw new Error('path unavailable');
        },
      },
      reasonCode: 'codex_rollout_unavailable',
    },
    {
      name: 'Codex synchronization',
      session: { kind: 'codex', providerSessionId: 'provider-session' },
      dependencies: {
        getAppSession: () => null,
        resolveCodexRolloutPath: async () => '/tmp/rollout.jsonl',
        synchronizeCodexRollout: async () => {
          throw new Error('sync unavailable');
        },
      },
      reasonCode: 'codex_synchronization_unavailable',
    },
    {
      name: 'transcript read',
      session: { kind: 'claude', providerSessionId: 'provider-session' },
      dependencies: {
        getAppSession: () => appSession,
        readActivity: async () => ({
          status: 'unavailable',
          activity: 'unknown',
          reasonCode: 'transcript_read_unavailable',
        }),
        readTranscriptEnded: async () => ({ status: 'resolved', transcriptEnded: false }),
      },
      reasonCode: 'transcript_read_unavailable',
    },
  ];

  for (const unavailableCase of unavailableCases) {
    const result = await resolveExternalSessionActivity(
      unavailableCase.session,
      unavailableCase.dependencies,
    );
    assert.equal(result.status, 'unavailable', unavailableCase.name);
    assert.equal(result.activity, 'unknown', unavailableCase.name);
    assert.equal(result.transcriptEnded, false, unavailableCase.name);
    assert.equal(
      result.status === 'unavailable' ? result.reasonCode : null,
      unavailableCase.reasonCode,
      unavailableCase.name,
    );
  }
});

test('file caches invalidate same-size rewrites with preserved mtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatmux-external-activity-'));
  const activityPath = join(directory, 'activity.jsonl');
  const transcriptPath = join(directory, 'transcript.jsonl');
  const timestamp = new Date('2020-01-01T00:00:00.000Z');

  try {
    assert.deepEqual(
      await readExternalSessionActivityDetailed({
        kind: 'claude',
        providerSessionId: 'provider-session',
        jsonlPath: activityPath,
      }),
      {
        status: 'unavailable',
        activity: 'unknown',
        reasonCode: 'transcript_read_unavailable',
      },
    );

    await writeFile(activityPath, 'not-json\n');
    assert.deepEqual(
      await readExternalSessionActivityDetailed({
        kind: 'claude',
        providerSessionId: 'provider-session',
        jsonlPath: activityPath,
      }),
      { status: 'resolved', activity: 'unknown' },
    );
    const waiting = `${line({ type: 'result' })}\n`;
    const running = `${line({ type: 'user' }).padEnd(waiting.length - 1, ' ')}\n`;
    assert.equal(Buffer.byteLength(waiting), Buffer.byteLength(running));

    await writeFile(activityPath, waiting);
    await utimes(activityPath, timestamp, timestamp);
    assert.deepEqual(
      await readExternalSessionActivityDetailed({
        kind: 'claude',
        providerSessionId: 'provider-session',
        jsonlPath: activityPath,
      }),
      { status: 'resolved', activity: 'waiting_user' },
    );

    await writeFile(activityPath, running);
    await utimes(activityPath, timestamp, timestamp);
    assert.deepEqual(
      await readExternalSessionActivityDetailed({
        kind: 'claude',
        providerSessionId: 'provider-session',
        jsonlPath: activityPath,
      }),
      { status: 'resolved', activity: 'running' },
    );

    const ended = `${line({ type: 'custom', customType: 'session_exit' })}\n`;
    const resumed = `${line({ type: 'custom', customType: 'session_fail' })}\n`;
    assert.equal(Buffer.byteLength(ended), Buffer.byteLength(resumed));

    await writeFile(transcriptPath, ended);
    await utimes(transcriptPath, timestamp, timestamp);
    assert.deepEqual(
      await readExternalTranscriptEndedDetailed({ kind: 'omp', jsonlPath: transcriptPath }),
      { status: 'resolved', transcriptEnded: true },
    );

    await writeFile(transcriptPath, resumed);
    await utimes(transcriptPath, timestamp, timestamp);
    assert.deepEqual(
      await readExternalTranscriptEndedDetailed({ kind: 'omp', jsonlPath: transcriptPath }),
      { status: 'resolved', transcriptEnded: false },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
