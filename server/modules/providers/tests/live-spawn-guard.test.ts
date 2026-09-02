import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExternalCliSession } from '@/modules/providers/services/external-cli-sessions.service.js';
import {
  createFindLiveTmuxSpawnBlock,
  findLiveTmuxPaneForSession,
} from '@/modules/providers/services/live-spawn-guard.service.js';

const tmux = {
  socketPath: '/tmp/tmux-1000/default',
  sessionId: '$1',
  windowId: '@1',
  paneId: '%1',
};

function session(overrides: Partial<ExternalCliSession>): ExternalCliSession {
  return { tmuxName: 'work', tmux, kind: 'omo', ...overrides };
}

// #44 regression lock: a chat.send to a session whose transcript is owned by a
// live tmux pane must be refused — a second headless resume would interleave
// two writers in one JSONL and the live agent would never see the message.
test('a live pane owning the exact provider session blocks the spawn', () => {
  const sessions = [
    session({ kind: 'omo', providerSessionId: 'S-1', tmuxName: 'omo-pane' }),
    session({ kind: 'omp', providerSessionId: 'S-2', tmuxName: 'omp-pane' }),
  ];

  assert.deepEqual(findLiveTmuxPaneForSession('omo', 'S-1', sessions), { tmuxName: 'omo-pane' });
  assert.deepEqual(findLiveTmuxPaneForSession('omp', 'S-2', sessions), { tmuxName: 'omp-pane' });
});

test('a different provider, different id, or unresolved pane never blocks', () => {
  const sessions = [
    session({ kind: 'omo', providerSessionId: 'S-1' }),
    // A pane whose native id inference has not resolved yet cannot claim ownership.
    session({ kind: 'omo', providerSessionId: undefined }),
  ];

  // Same id under a different provider is a different session space.
  assert.equal(findLiveTmuxPaneForSession('omp', 'S-1', sessions), null);
  assert.equal(findLiveTmuxPaneForSession('omo', 'S-other', sessions), null);
  assert.equal(findLiveTmuxPaneForSession('omo', 'S-1', []), null);
});

test('the discovery adapter preserves unavailable, clear, and blocked states', async () => {
  const unavailable = createFindLiveTmuxSpawnBlock(async () => ({ ok: false, sessions: [] }));
  assert.deepEqual(await unavailable('omo', 'S-1'), { kind: 'discovery_unavailable' });

  const throwing = createFindLiveTmuxSpawnBlock(async () => { throw new Error('scan failed'); });
  assert.deepEqual(await throwing('omo', 'S-1'), { kind: 'discovery_unavailable' });

  const clear = createFindLiveTmuxSpawnBlock(async () => ({ ok: true, sessions: [] }));
  assert.deepEqual(await clear('omo', 'S-1'), { kind: 'clear' });

  const blocked = createFindLiveTmuxSpawnBlock(async () => ({
    ok: true,
    sessions: [session({ kind: 'omo', providerSessionId: 'S-1', tmuxName: 'omo-pane' })],
  }));
  assert.deepEqual(await blocked('omo', 'S-1'), { kind: 'blocked', tmuxName: 'omo-pane' });
});

test('the discovery adapter skips discovery without a guarded provider session id', async () => {
  let discoveryCalls = 0;
  const findBlock = createFindLiveTmuxSpawnBlock(async () => {
    discoveryCalls++;
    return { ok: true, sessions: [] };
  });

  assert.deepEqual(await findBlock('omo', null), { kind: 'clear' });
  assert.deepEqual(await findBlock('omo', undefined), { kind: 'clear' });
  assert.deepEqual(await findBlock('gjc', 'S-1'), { kind: 'clear' });
  assert.equal(discoveryCalls, 0);
});

test('every headless-resume provider is guarded; gjc and non-CLI lanes are not', () => {
  for (const kind of ['claude', 'codex', 'cursor', 'opencode', 'omp', 'omo'] as const) {
    const sessions = [session({ kind, providerSessionId: 'S-1', tmuxName: `${kind}-pane` })];
    assert.deepEqual(
      findLiveTmuxPaneForSession(kind, 'S-1', sessions),
      { tmuxName: `${kind}-pane` },
      kind,
    );
  }

  // gjc reaches live sessions through the SDK connect lane, not a fork —
  // its rows must never be blocked by this guard.
  assert.equal(
    findLiveTmuxPaneForSession('gjc', 'S-1', [session({ kind: 'omo', providerSessionId: 'S-1' })]),
    null,
  );
});
