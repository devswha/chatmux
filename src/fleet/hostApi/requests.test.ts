import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDirSuggestions,
  parseProviderInventory,
  parseTranscriptSearch,
  requestHostJson,
} from './requests';

const PEER_A = '22222222-2222-4222-8222-222222222222';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function withFetch<T>(
  respond: (url: string, init?: RequestInit) => Response,
  run: (calls: readonly string[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    return Promise.resolve(respond(String(input), init));
  }) as typeof globalThis.fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test('Given a successful envelope, when a host request runs, then the payload is unwrapped once', async () => {
  // Given / When
  const result = await withFetch(
    () => jsonResponse({ success: true, data: { provider: 'codex', commands: [] } }),
    () => requestHostJson('/api/hosts/x/inventory'),
  );

  // Then
  assert.deepEqual(result, { ok: true, value: { provider: 'codex', commands: [] } });
});

test('Given an uncertain mutation outcome, when a host request runs, then the result is a non-success needing reconciliation', async () => {
  // Given / When
  const result = await withFetch(
    () => jsonResponse({ success: false, error: { code: 'HOST_COMMAND_OUTCOME_UNKNOWN', message: 'outcome unknown' } }, 409),
    () => requestHostJson(`/api/hosts/${PEER_A}/projects/p/sessions/spawn`, { method: 'POST' }),
  );

  // Then
  assert.deepEqual(result, {
    ok: false,
    failure: { code: 'HOST_COMMAND_OUTCOME_UNKNOWN', message: 'outcome unknown', outcome: 'unknown' },
  });
});

test('Given an unavailable host, when a host request runs, then the failure keeps its machine code and reports no side effect', async () => {
  // Given / When
  const offline = await withFetch(
    () => jsonResponse({ success: false, error: { code: 'HOST_OFFLINE', message: 'Fleet host is offline.' } }, 503),
    () => requestHostJson('/api/hosts/x/prompt'),
  );
  const malformed = await withFetch(() => new Response('not json', { status: 500 }), () => requestHostJson('/api/hosts/x/prompt'));

  // Then
  assert.deepEqual(offline, {
    ok: false,
    failure: { code: 'HOST_OFFLINE', message: 'Fleet host is offline.', outcome: 'none' },
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.ok === false ? malformed.failure.code : '', 'HOST_REQUEST_FAILED');
});

test('Given a network error, when a host request runs, then the outcome is unknown for a mutation and none for a read', async () => {
  // Given
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError('socket closed'))) as typeof globalThis.fetch;

  // When
  try {
    const read = await requestHostJson('/api/hosts/x/prompt');
    const mutation = await requestHostJson('/api/hosts/x/spawn', { method: 'POST' });

    // Then
    assert.deepEqual(read.ok === false ? read.failure.outcome : null, 'none');
    assert.deepEqual(mutation.ok === false ? mutation.failure.outcome : null, 'unknown');
  } finally {
    globalThis.fetch = original;
  }
});

test('Given peer payloads, when inventory, suggestions and search are parsed, then only contract-shaped values survive', () => {
  // Given / When
  const inventory = parseProviderInventory({
    provider: 'codex',
    commands: [{ name: 'ship', description: 'ship it', scope: 'project' }, { name: 42 }],
  });
  const suggestions = parseDirSuggestions({ suggestions: ['repos', 'repos/app', 7] });
  const matches = parseTranscriptSearch({
    query: 'needle',
    results: [{
      projectId: 'project-collision',
      projectName: 'app',
      sessions: [{ sessionId: 'session-collision', provider: 'codex', sessionSummary: 'peer summary', matches: [{ snippet: 'needle here' }] }],
    }],
  }, 'project-collision');
  const otherProject = parseTranscriptSearch({
    query: 'needle',
    results: [{ projectId: 'other', projectName: 'other', sessions: [{ sessionId: 's', provider: 'codex', sessionSummary: '', matches: [] }] }],
  }, 'project-collision');

  // Then
  assert.deepEqual(inventory, { provider: 'codex', commands: [{ name: 'ship', description: 'ship it', scope: 'project' }] });
  assert.deepEqual(suggestions, ['repos', 'repos/app']);
  assert.deepEqual(matches, [{ sessionId: 'session-collision', label: 'peer summary', snippet: 'needle here', provider: 'codex' }]);
  assert.deepEqual(otherProject, []);
  assert.equal(parseProviderInventory({ commands: [] }), null);
  assert.deepEqual(parseDirSuggestions({}), []);
});
