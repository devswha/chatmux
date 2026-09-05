import { readFile } from 'node:fs/promises';
import { mock } from 'node:test';

import type { ExternalSessionBinding } from '@/modules/providers/services/external-cli-sessions.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

import {
  assert, assertError, assertSuccess, externalTmux, fixtureBin, liveTmux,
  path, request, sessionsDb, test, validProcess, writeFile,
} from './support/provider-routes-contract.support.js';

// Load only after the HTTP harness has installed its isolated DB and fake tmux.
const { defaultExternalCliSessionDiscovery } = await import('../services/external-cli-sessions/discovery.js');
const { defaultLiveGjcSessionDiscovery } = await import('../services/live-sessions/discovery-cache.js');
const { sessionsService } = await import('../services/sessions.service.js');

const unproven = [null, undefined, 'inferred', 'unknown', '', 'TAGGED', true, {}, ['observed']];
const question = { question: 'Choose an action', options: [{ label: 'Allow' }, { label: 'Reject' }] };
const toolId = 'binding-ask';
const message = {
  kind: 'tool_use', toolId, toolName: 'AskUserQuestion', toolInput: { questions: [question] },
} as NormalizedMessage;

for (const provider of ['gjc', 'codex'] as const) {
  test(`${provider} transcript routes refuse unproven grades before history reads or tmux input`, async (t) => {
    const nativeId = `binding-${provider}-native`;
    const sessionId = sessionsDb.createSession(nativeId, provider, '/tmp', 'Binding fixture');
    const tmux = provider === 'gjc' ? liveTmux : externalTmux;
    const lane = provider === 'gjc' ? 'live' : 'external';
    let binding: unknown;
    let reads = 0;
    const history = mock.method(sessionsService, 'fetchHistory', async () => {
      reads += 1;
      return { messages: [message], total: 1, hasMore: false, offset: 0, limit: 500 };
    });
    const live = mock.method(defaultLiveGjcSessionDiscovery, 'getLiveGjcSessions', async () => [{
      id: nativeId, tmuxName: 'live', tmux, process: validProcess,
      claim: 'lineage' as const, binding: binding as ExternalSessionBinding,
      kind: 'interactive' as const, model: null, effort: null, running: false,
    }]);
    const external = mock.method(defaultExternalCliSessionDiscovery, 'getExternalCliSessionsFresh', async () => [{
      tmuxName: 'external', tmux, kind: 'codex' as const, providerSessionId: nativeId,
      binding: binding as ExternalSessionBinding, agentPid: validProcess.pid, startedAtMs: validProcess.startedAtMs,
    }]);
    const log = path.join(fixtureBin, `binding-${provider}.log`);
    process.env.CHATMUX_CONTRACT_TMUX_LOG = log;
    t.after(() => {
      history.mock.restore(); live.mock.restore(); external.mock.restore();
      delete process.env.CHATMUX_CONTRACT_TMUX_LOG;
      delete process.env.CHATMUX_CONTRACT_CAPTURE;
    });
    const routes = [
      { suffix: 'ask', body: { toolId, optionIndex: 0 } },
      { suffix: 'ask/custom', body: { toolId, message: 'fixture input' } },
      ...(provider === 'codex' ? [{ suffix: 'approval/respond', body: { decision: 'approve-once' } }] : []),
    ];
    for (binding of unproven) {
      for (const route of routes) {
        reads = 0;
        await writeFile(log, '');
        assertError(await request(`/sessions/${lane}/${route.suffix}`, {
          tmux, process: validProcess, sessionId, ...route.body,
        }), 409, 'TMUX_SESSION_BINDING_INFERRED');
        assert.equal(reads, 0, 'unproven binding must be refused before transcript access');
        assert.doesNotMatch(await readFile(log, 'utf8'), /send-keys|load-buffer|paste-buffer|kill-/u);
      }
    }

    for (binding of ['tagged', 'observed']) {
      process.env.CHATMUX_CONTRACT_CAPTURE = provider === 'gjc'
        ? 'Choose an action\n│❯ Allow │\n│  Reject │\n│  Other (type your own) │\n up/down navigate  enter select  esc cancel'
        : 'Choose an action\n› 1. Allow\n  2. Reject\n  3. None of the above\ntab to add notes | enter to submit answer | esc to interrupt';
      reads = 0;
      await writeFile(log, '');
      assertSuccess(await request(`/sessions/${lane}/ask`, { tmux, process: validProcess, sessionId, toolId, optionIndex: 0 }));
      assert.equal(reads, 1);
      assert.match(await readFile(log, 'utf8'), /send-keys/u, 'proven prompt response reaches only the fake tmux');
    }

    // Pane-addressed control has independent identity/lineage checks and needs no transcript.
    binding = undefined;
    await writeFile(log, '');
    assertSuccess(await request(`/sessions/${lane}/send`, { tmux, process: validProcess, message: 'fixture pane input' }));
    assert.match(await readFile(log, 'utf8'), /paste-buffer/u);
    await writeFile(log, '');
    assertError(await request(`/sessions/${lane}/send`, {
      tmux, process: { ...validProcess, startedAtMs: validProcess.startedAtMs + 1 }, message: 'stale fixture',
    }), 409, 'TMUX_PROCESS_GENERATION_MISMATCH');
    assert.doesNotMatch(await readFile(log, 'utf8'), /send-keys|load-buffer|paste-buffer/u);
  });
}
