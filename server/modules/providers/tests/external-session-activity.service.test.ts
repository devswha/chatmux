import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
} from '@/modules/database/index.js';
import {
  parseExternalJsonlActivity,
  parseExternalJsonlActivityEvidence,
  parseOmpTranscriptEnded,
  parseOpenCodeActivity,
  parseOpenCodeActivityEvidence,
  readExternalSessionActivityDetailed,
  readExternalTranscriptEndedDetailed,
  resolveExternalSessionActivity,
  toExternalSessionDisplayActivity,
} from '@/modules/providers/services/external-session-activity.service.js';

const line = (value: unknown) => JSON.stringify(value);

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(join(tmpdir(), 'external-activity-db-'));
  closeConnection();
  process.env.DATABASE_PATH = join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

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
test('Claude result evidence requires an exact success subtype', () => {
  assert.deepEqual(
    parseExternalJsonlActivityEvidence('claude', line({ type: 'result', subtype: ' SUCCESS ' })),
    { activity: 'waiting_user', terminalOutcome: 'reply_ready' },
  );
  for (const subtype of ['error', 'cancelled', 'interrupted']) {
    assert.deepEqual(
      parseExternalJsonlActivityEvidence('claude', line({ type: 'result', subtype })),
      { activity: 'waiting_user', terminalOutcome: 'failed' },
      subtype,
    );
  }
  assert.deepEqual(
    parseExternalJsonlActivityEvidence('claude', line({ type: 'result', subtype: 'unknown' })),
    { activity: 'unknown', terminalOutcome: 'unknown' },
  );
});

test('Claude turn_duration closes an interrupted input without creating a completion outcome', () => {
  assert.deepEqual(
    parseExternalJsonlActivityEvidence('claude', [
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', name: 'AskUserQuestion' }],
        },
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
        },
      }),
      line({ type: 'system', subtype: 'turn_duration' }),
    ].join('\n')),
    { activity: 'waiting_user', terminalOutcome: 'none' },
  );
  assert.equal(parseExternalJsonlActivity('claude', [
    line({ type: 'system', subtype: 'turn_duration' }),
    line({ type: 'user', message: { role: 'user', content: 'new turn' } }),
  ].join('\n')), 'running');
});

test('Claude API overloaded responses are promoted to ERROR evidence', () => {
  const overloaded = {
    type: 'error',
    error: {
      details: null,
      type: 'overloaded_error',
      message: 'Overloaded',
    },
    request_id: 'req_011CdWwUjREwRBPM8SAkFNMR',
  };

  assert.deepEqual(
    parseExternalJsonlActivityEvidence('claude', line(overloaded)),
    { activity: 'waiting_user', terminalOutcome: 'failed' },
  );
  assert.equal(toExternalSessionDisplayActivity({
    status: 'resolved',
    activity: 'waiting_user',
    terminalOutcome: 'failed',
    appSession: null,
    transcriptEnded: false,
  }), 'error');
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

test('default app-session lookup resolves qualified session metadata through the project join', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession(
      'native-session',
      'claude',
      '/workspace/project',
      'External session',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '/tmp/transcript.jsonl',
    );
    const resolved = await resolveExternalSessionActivity(
      { kind: 'claude', providerSessionId: 'native-session' },
      {
        readActivityEvidence: async () => ({
          status: 'resolved',
          evidence: {
            activity: 'waiting_user',
            terminalOutcome: 'reply_ready',
            evidenceCursor: 'cursor',
            evidenceDigest: 'digest',
          },
        }),
        readTranscriptEnded: async () => ({ status: 'resolved', transcriptEnded: false }),
      },
    );
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(resolved.appSession, {
      session_id: 'native-session',
      project_path: '/workspace/project',
      custom_name: 'External session',
    });
  });
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
      readActivityEvidence: async (input) => {
        assert.equal(input.jsonlPath, appSession.jsonl_path);
        return {
          status: 'resolved',
          evidence: {
            activity: 'waiting_user',
            terminalOutcome: 'reply_ready',
            evidenceCursor: 'test-cursor',
            evidenceDigest: 'test-digest',
          },
        };
      },
      readTranscriptEnded: async () => ({ status: 'resolved', transcriptEnded: false }),
    },
  );
  assert.deepEqual(resolved, {
    status: 'resolved',
    activity: 'waiting_user',
    terminalOutcome: 'reply_ready',
    evidenceCursor: 'test-cursor',
    evidenceDigest: 'test-digest',
    appSession: {
      session_id: appSession.session_id,
      project_path: appSession.project_path,
      custom_name: appSession.custom_name,
    },
    transcriptEnded: false,
  });
  const resolvedJson = JSON.stringify(resolved);
  assert.doesNotMatch(resolvedJson, /provider-session/);
  assert.doesNotMatch(resolvedJson, /\/tmp\/transcript\.jsonl/);

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
        readActivityEvidence: async () => ({
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
test('standalone Codex and OpenCode use production resolver paths while Claude and OMP fail closed', async () => {
  const appSession = {
    session_id: 'codex-app',
    project_path: '/workspace/project',
    jsonl_path: '/private/codex.jsonl',
    custom_name: null,
  };
  for (const kind of ['codex', 'opencode'] as const) {
    let appLookups = 0;
    const result = await resolveExternalSessionActivity(
      { kind, providerSessionId: `${kind}-native-id` },
      {
        getAppSession: () => {
          appLookups += 1;
          return kind === 'codex' && appLookups > 1 ? appSession : null;
        },
        resolveCodexRolloutPath: async () => '/private/rollout.jsonl',
        synchronizeCodexRollout: async () => undefined,
        readActivityEvidence: async (input) => {
          assert.equal(input.jsonlPath, kind === 'codex' ? appSession.jsonl_path : null, kind);
          return {
            status: 'resolved',
            evidence: {
              activity: 'waiting_user',
              terminalOutcome: 'reply_ready',
              evidenceCursor: `${kind}-cursor`,
              evidenceDigest: `${kind}-digest`,
            },
          };
        },
        readTranscriptEnded: async () => ({ status: 'resolved', transcriptEnded: false }),
      },
    );
    assert.equal(result.status, 'resolved', kind);
    assert.equal(result.terminalOutcome, 'reply_ready', kind);
    assert.doesNotMatch(JSON.stringify(result), /native-id|\/private\//, kind);
  }

  for (const kind of ['claude', 'omp'] as const) {
    const result = await resolveExternalSessionActivity(
      { kind, providerSessionId: `${kind}-native-id` },
      { getAppSession: () => null },
    );
    assert.equal(result.status, 'unavailable', kind);
    assert.equal(result.status === 'unavailable' ? result.reasonCode : null, 'app_session_unavailable', kind);
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
    const waiting = `${line({ type: 'result', subtype: 'success' })}\n`;
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
test('OpenCode only treats a completed stop as reply-ready and gives errors precedence over asks', () => {
  assert.deepEqual(
    parseOpenCodeActivityEvidence({
      role: 'assistant',
      time: { created: 1, completed: 2 },
      finish: 'length',
    }),
    { activity: 'unknown', terminalOutcome: 'unknown' },
  );
  assert.deepEqual(
    parseOpenCodeActivityEvidence(
      { role: 'assistant', error: { message: 'failed' }, time: { created: 1, completed: 2 }, finish: 'stop' },
      [{ type: 'tool', tool: 'question', state: { status: 'pending' } }],
    ),
    { activity: 'waiting_user', terminalOutcome: 'failed' },
  );
});
test('display activity promotes only confirmed terminal failures to error', () => {
  assert.equal(toExternalSessionDisplayActivity({
    status: 'resolved',
    activity: 'waiting_user',
    terminalOutcome: 'failed',
    appSession: null,
    transcriptEnded: false,
  }), 'error');
  assert.equal(toExternalSessionDisplayActivity({
    status: 'resolved',
    activity: 'waiting_user',
    terminalOutcome: 'reply_ready',
    appSession: null,
    transcriptEnded: false,
  }), 'waiting_user');
  assert.equal(toExternalSessionDisplayActivity({
    status: 'unavailable',
    activity: 'unknown',
    reasonCode: 'transcript_read_unavailable',
    appSession: null,
    transcriptEnded: false,
  }), 'unknown');
});

test('OMP error records take precedence over nearby asks and completed assistant stops are reply-ready', () => {
  assert.deepEqual(
    parseExternalJsonlActivityEvidence('omp', [
      line({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'ask' }] } }),
      line({ type: 'error', error: { message: 'network' } }),
    ].join('\n')),
    { activity: 'waiting_user', terminalOutcome: 'failed' },
  );
  assert.deepEqual(
    parseExternalJsonlActivityEvidence('omp', line({
      type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [] },
    })),
    { activity: 'waiting_user', terminalOutcome: 'reply_ready' },
  );
});
