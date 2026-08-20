import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createExternalCliSessionDiscovery,
  type ExternalCliSession,
} from '@/modules/providers/services/external-cli-sessions.service.js';
import { assertFreshExternalTmuxTarget } from '@/modules/providers/services/tmux-fresh-verifier.service.js';
import { assertFreshLocalAgentTmuxTarget } from '@/modules/providers/services/tmux-target-guard.service.js';
import type { LiveGjcSession } from '@/modules/providers/services/live-sessions.service.js';
import { AppError } from '@/shared/utils.js';

const tmux = {
  socketPath: '/tmp/chatmux-test.sock',
  sessionId: '$7',
  windowId: '@8',
  paneId: '%9',
};
const processGeneration = { pid: 42, startedAtMs: 1234 };
const session: ExternalCliSession = {
  tmuxName: 'external-test',
  tmux,
  kind: 'codex',
  agentPid: processGeneration.pid,
  startedAtMs: processGeneration.startedAtMs,
};

function mismatch(error: unknown): boolean {
  return error instanceof AppError && error.code === 'TMUX_PROCESS_GENERATION_MISMATCH' && error.statusCode === 409;
}

test('fresh verifier performs one uncached scan without populating the display cache', async () => {
  let scans = 0;
  const discovery = createExternalCliSessionDiscovery({
    discover: async () => {
      scans += 1;
      return { ok: true, sessions: [session] };
    },
  });
  const target = await assertFreshExternalTmuxTarget(tmux, processGeneration, {
    scan: () => discovery.getExternalCliSessionsFresh(),
    assertPaneIdentity: async () => {},
  });

  assert.equal(scans, 1);
  await discovery.getExternalCliSessions();
  assert.equal(scans, 2, 'a fresh authorization scan must not seed the display cache');
  assert.equal(target.tmux.paneId, tmux.paneId);
  assert.equal(Object.isFrozen(target), true);
  assert.equal(Object.isFrozen(target.tmux), true);
  assert.equal(Object.isFrozen(target.process), true);
});

test('fresh verifier rejects coordinate, process, terminal-only, connection-issue, and absent targets', async () => {
  const cases: Array<{ sessions: ExternalCliSession[]; requestedTmux?: typeof tmux; requestedProcess?: typeof processGeneration }> = [
    { sessions: [session], requestedTmux: { ...tmux, paneId: '%10' } },
    { sessions: [session], requestedProcess: { ...processGeneration, pid: 43 } },
    { sessions: [{ ...session, kind: 'ssh' }] },
    { sessions: [{ ...session, kind: 'shell' }] },
    { sessions: [] },
    { sessions: [{ ...session, connectionIssue: 'agent_user_mismatch' }] },
    { sessions: [{ ...session, connectionIssue: 'tmux_socket_owner_mismatch' }] },
  ];
  for (const entry of cases) {
    await assert.rejects(
      assertFreshExternalTmuxTarget(
        entry.requestedTmux ?? tmux,
        entry.requestedProcess ?? processGeneration,
        { scan: async () => entry.sessions, assertPaneIdentity: async () => {} },
      ),
      mismatch,
    );
  }
});

test('fresh verifier preserves pane-generation mismatch from its final tmux recheck', async () => {
  await assert.rejects(
    assertFreshExternalTmuxTarget(tmux, processGeneration, {
      scan: async () => [session],
      assertPaneIdentity: async () => {
        throw new AppError('changed', { code: 'TMUX_PANE_GENERATION_MISMATCH', statusCode: 409 });
      },
    }),
    (error) => error instanceof AppError && error.code === 'TMUX_PANE_GENERATION_MISMATCH',
  );
});

test('verified-target factory is neither imported nor called outside the two verifiers', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = join(process.cwd(), 'server');
  // The two verifiers exclusively own the target brand.
  const allowed = new Set([
    join(root, 'modules/providers/services/tmux-fresh-verifier.service.ts'),
    join(root, 'modules/providers/services/tmux-target-guard.service.ts'),
  ]);
  const offenders: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'tests') continue;
        await walk(path);
        continue;
      }
      if (!/\.(?:ts|js)$/.test(entry.name) || /\.(?:test|spec)\./.test(entry.name)) continue;
      const source = await readFile(path, 'utf8');
      // Any mention at all — a call, a re-export, or an aliased import such as
      // `createVerifiedTmuxActionTarget as forge` — would let another module
      // mint the brand, so the boundary matches the bare identifier.
      if (source.includes('createVerifiedTmuxActionTarget') && !allowed.has(path)) {
        offenders.push(path);
      }
    }
  }
  await walk(root);
  assert.deepEqual(offenders, []);
});

test('local-agent verifier falls back to the live gjc lineage lane for panes missing from the external roster', async () => {
  const liveSession = {
    id: 'live-1',
    tmuxName: 'gjc-pane',
    tmux,
    claim: 'lineage',
    process: { ...processGeneration },
  } as unknown as LiveGjcSession;

  // External roster does not know gjc panes; the live lineage lane authorizes.
  const target = await assertFreshLocalAgentTmuxTarget(tmux, processGeneration, {
    assertExternal: async () => {
      throw new AppError('not external', { code: 'TMUX_PROCESS_GENERATION_MISMATCH', statusCode: 409 });
    },
    loadLiveSessions: async () => [liveSession],
    assertPaneIdentity: async () => {},
  });
  assert.equal(target.kind, 'gjc');
  assert.equal(target.tmux.paneId, tmux.paneId);

  // Both rosters unaware of the pane: fail closed.
  await assert.rejects(
    assertFreshLocalAgentTmuxTarget(tmux, processGeneration, {
      assertExternal: async () => {
        throw new AppError('not external', { code: 'TMUX_PROCESS_GENERATION_MISMATCH', statusCode: 409 });
      },
      loadLiveSessions: async () => [],
      assertPaneIdentity: async () => {},
    }),
    (error: unknown) => error instanceof AppError && error.statusCode >= 400,
  );

  // A live row without the lineage claim must never authorize an attach.
  await assert.rejects(
    assertFreshLocalAgentTmuxTarget(tmux, processGeneration, {
      assertExternal: async () => {
        throw new AppError('not external', { code: 'TMUX_PROCESS_GENERATION_MISMATCH', statusCode: 409 });
      },
      loadLiveSessions: async () => [{ ...liveSession, claim: 'workdir' } as unknown as LiveGjcSession],
      assertPaneIdentity: async () => {},
    }),
    (error: unknown) => error instanceof AppError && error.code === 'TMUX_ACTION_NOT_LINEAGE',
  );

  // A live row discovery marked with a connection issue must never authorize
  // control, even when pane identity and process generation both match.
  await assert.rejects(
    assertFreshLocalAgentTmuxTarget(tmux, processGeneration, {
      assertExternal: async () => {
        throw new AppError('not external', { code: 'TMUX_PROCESS_GENERATION_MISMATCH', statusCode: 409 });
      },
      loadLiveSessions: async () => [
        { ...liveSession, connectionIssue: 'tmux_socket_owner_mismatch' } as unknown as LiveGjcSession,
      ],
      assertPaneIdentity: async () => {},
    }),
    (error: unknown) => error instanceof AppError
      && error.code === 'TMUX_PROCESS_GENERATION_MISMATCH'
      && error.statusCode === 409,
  );

  // Non-mismatch failures (e.g. protection) must surface unchanged, without
  // consulting the live lane at all.
  await assert.rejects(
    assertFreshLocalAgentTmuxTarget(tmux, processGeneration, {
      assertExternal: async () => {
        throw new AppError('protected', { code: 'TMUX_TARGET_PROTECTED', statusCode: 403 });
      },
      loadLiveSessions: async () => {
        throw new Error('live lane must not be consulted');
      },
      assertPaneIdentity: async () => {},
    }),
    (error: unknown) => error instanceof AppError && error.code === 'TMUX_TARGET_PROTECTED',
  );
});
