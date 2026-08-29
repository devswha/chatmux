import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completionExternalGenerationIdentityFromSession,
  completionExternalGenerationIdentityKey,
  completionNotificationTargetsDb,
} from '@/modules/database/index.js';
import { FleetCompletionPeerPublisher, fleetCompletionPeerGateway } from '@/modules/fleet/index.js';
import { publishFleetTerminalCompletion } from '@/modules/notifications/index.js';
import type { ExternalCliSession } from '@/modules/providers/index.js';

import { withRepositoryDatabase } from './support/completion-notification-test-support.js';

const HOST = '11111111-1111-4111-8111-111111111111';

const session: ExternalCliSession = {
  kind: 'claude', tmuxName: 'Remote agent', providerSessionId: 'provider-secret',
  tmux: { socketPath: '/home/private/tmux.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
  agentPid: 42, startedAtMs: 100,
};

test('Given an armed external generation completes, when the host-safe monitor records it, then the peer emits redacted pane identity', () => {
  withRepositoryDatabase(() => {
    const identity = completionExternalGenerationIdentityFromSession(session);
    if (identity === null) throw new TypeError('test generation identity missing');
    const identityKey = completionExternalGenerationIdentityKey(identity);
    const generation = completionNotificationTargetsDb.createTarget(identityKey, 'external_generation');
    const events: unknown[] = [];
    const publisher = new FleetCompletionPeerPublisher(HOST, 'studio');
    const releaseGateway = fleetCompletionPeerGateway.bind(publisher);
    const releaseEvents = publisher.subscribe((event) => { events.push(event); });
    try {
      publishFleetTerminalCompletion({
        generationTargetId: generation.id, evidenceCursor: '/private/transcript:99', eventCode: 'reply_ready',
        targetAliasSnapshot: 'opaque', now: 100,
        payload: { title: 'Agent', body: 'Ready', navigation: { href: '/session/app-session', title: 'Agent' } },
      }, { status: 'decided', decisionIds: [] }, new Map([[identityKey, session]]));
    } finally {
      releaseEvents();
      releaseGateway();
    }

    const serialized = JSON.stringify(events);
    assert.equal(events.length, 1);
    assert.equal(serialized.includes('/home/private'), false);
    assert.equal(serialized.includes('/private/transcript'), false);
    assert.equal(serialized.includes('provider-secret'), false);
    assert.deepEqual((events[0] as { target: unknown }).target, {
      kind: 'pane_generation', hostId: HOST, lane: 'external', appLocalId: 'app-session',
      tmux: { sessionId: '$1', windowId: '@1', paneId: '%1' },
      process: { pid: 42, startedAtMs: 100 },
    });
  });
});

test('Given a startup baseline or empty replay, when observed, then no historical completion is emitted', () => {
  const publisher = new FleetCompletionPeerPublisher(HOST, 'studio');
  const events: unknown[] = [];
  const releaseGateway = fleetCompletionPeerGateway.bind(publisher);
  const releaseEvents = publisher.subscribe((event) => { events.push(event); });
  try {
    const input = {
      generationTargetId: 1, evidenceCursor: 'baseline', eventCode: 'reply_ready' as const,
      targetAliasSnapshot: 'opaque', now: 100,
      payload: { title: 'Agent', body: 'Ready', navigation: { href: '/', title: 'Agent' } },
    };
    publishFleetTerminalCompletion(input, { status: 'baselined', decisionIds: [] }, new Map());
    publishFleetTerminalCompletion(input, { status: 'replay', decisionIds: [] }, new Map());
  } finally {
    releaseEvents();
    releaseGateway();
  }
  assert.deepEqual(events, []);
});
