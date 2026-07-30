import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, afterEach, before, beforeEach } from 'node:test';

import express, { type Express } from 'express';

// Route imports bind database/auth configuration during module evaluation.
const root = await mkdtemp(path.join(os.tmpdir(), 'chatmux-completion-route-'));
process.env.CHATMUX_AUTH = 'password';
process.env.JWT_SECRET = 'completion-route-test-secret';
process.env.DATABASE_PATH = path.join(root, 'completion.db');

const { authenticateToken, generateToken } = await import('@/middleware/auth.js');
const {
  initializeDatabase,
  userDb,
  appConfigDb,
  completionNotificationTargetsDb,
  sessionsDb,
  notificationPreferencesDb,
  completionAppAlias,
  completionAppIdentityKey,
  completionExternalGenerationAlias,
  completionExternalGenerationIdentityFromSession,
  completionExternalGenerationIdentityKey,
} = await import('@/modules/database/index.js');
const { getConnection } = await import('@/modules/database/connection.js');
const { completionTargetResolver } = await import('@/modules/notifications/index.js');
const { default: settingsRoutes } = await import('./settings.js');

type Response = { status: number; body: Record<string, any> };
let app: Express;
let server: Server | undefined;
let baseUrl: string;
let token: string;
let otherToken: string;
let userId: number;

let originalCompletionStatusDetailedDiscovery: unknown;
async function request(pathname: string, method: string, body?: unknown, authorization = `Bearer ${token}`): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/settings${pathname}`, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function validSubscription(endpoint = 'https://push.example.test/subscription') {
  return { endpoint, keys: { p256dh: 'AQ', auth: 'Ag' } };
}

function statusDescriptor(provider = 'claude', sessionId = 'session-active') {
  return { kind: 'app', provider, sessionId };
}

before(async () => {
  await initializeDatabase();
  const user = userDb.createUser(`completion-route-${Date.now()}`, 'test');
  const other = userDb.createUser(`completion-route-other-${Date.now()}`, 'test');
  userId = Number(user.id);
  appConfigDb.set(`auth_token_version:${user.id}`, '0');
  appConfigDb.set(`auth_token_version:${other.id}`, '0');
  appConfigDb.set('auth_token_version_schema', '1');
  token = generateToken({ id: userId, username: user.username });
  otherToken = generateToken({ id: Number(other.id), username: other.username });
  app = express();
  app.use(express.json());
  app.use('/api/settings', authenticateToken, settingsRoutes);
  const fixtureServer = createServer(app);
  server = fixtureServer;
  await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  const address = fixtureServer.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  originalCompletionStatusDetailedDiscovery = app.locals.completionStatusDetailedDiscovery;
  app.locals.completionStatusDetailedDiscovery = async () => ({ ok: true, sessions: [] });
});

afterEach(() => {
  if (originalCompletionStatusDetailedDiscovery === undefined) {
    delete app.locals.completionStatusDetailedDiscovery;
  } else {
    app.locals.completionStatusDetailedDiscovery = originalCompletionStatusDetailedDiscovery;
  }
});

after(async () => {
  const serverToClose = server;
  if (serverToClose?.listening) {
    await new Promise<void>((resolve, reject) => serverToClose.close((error) => error ? reject(error) : resolve()));
  }
  await rm(root, { recursive: true, force: true });
});

test('completion status is authenticated, deduplicates app descriptors, and skips discovery for app-only requests', async () => {
  let successCalls = 0;
  app.locals.completionStatusDetailedDiscovery = async () => {
    successCalls += 1;
    return { ok: true, sessions: [] };
  };

  const unauthorized = await request('/completion-notifications/status', 'POST', { descriptors: [] }, '');
  assert.equal(unauthorized.status, 401);

  const descriptors = Array.from({ length: 200 }, () => statusDescriptor('claude', 'deduplicated'));
  const status = await request('/completion-notifications/status', 'POST', { descriptors });
  assert.equal(status.status, 200);
  assert.equal(successCalls, 0);
  assert.equal(status.body.targets.length, 1);
  assert.equal(status.body.targets[0].reason, 'not_found');
  assert.equal((await request('/completion-notifications/status', 'POST', { descriptors: [...descriptors, statusDescriptor()] })).status, 400);
  assert.equal(successCalls, 0);

  const beforeTargets = getConnection().prepare('SELECT count(*) AS count FROM completion_notification_targets').get() as { count: number };
  let unavailableCalls = 0;
  app.locals.completionStatusDetailedDiscovery = async () => {
    unavailableCalls += 1;
    throw new Error('discovery unavailable');
  };
  const unavailable = await request('/completion-notifications/status', 'POST', { descriptors: [statusDescriptor()] });
  assert.equal(unavailable.status, 200);
  assert.equal(unavailableCalls, 0);
  assert.equal(unavailable.body.targets[0].reason, 'not_found');
  const afterTargets = getConnection().prepare('SELECT count(*) AS count FROM completion_notification_targets').get() as { count: number };
  assert.equal(afterTargets.count, beforeTargets.count);
});

test('direct app descriptors expose active and mapping-state outcomes without leaking raw discovery fields', async () => {
  const original = completionTargetResolver.resolveAppDescriptor;
  const alias = completionAppAlias({ provider: 'claude', sessionId: 'direct' });
  const states = [
    ['active', { alias, mappingState: 'one_active', reason: 'eligible', target: { alias, kind: 'app', revision: 0, watched: false } }],
    ['missing', { alias, mappingState: 'none', reason: 'not_found' }],
    ['inactive-session', { alias, mappingState: 'inactive_match', reason: 'identity_inactive' }],
    ['inactive-project', { alias, mappingState: 'inactive_match', reason: 'identity_inactive' }],
    ['missing-project', { alias, mappingState: 'inactive_match', reason: 'identity_inactive' }],
    ['ambiguous', { alias, mappingState: 'ambiguous_active', reason: 'identity_ambiguous' }],
  ] as const;
  let index = 0;
  completionTargetResolver.resolveAppDescriptor = () => states[index++][1] as any;
  try {
    for (const [name] of states) {
      const response = await request('/completion-notifications/status', 'POST', { descriptors: [statusDescriptor('claude', name)] });
      assert.equal(response.status, 200);
      assert.equal(response.body.targets[0].reason, states[index - 1][1].reason);
      assert.equal(JSON.stringify(response.body).includes('socketPath'), false);
    }
  } finally {
    completionTargetResolver.resolveAppDescriptor = original;
  }
});
test('active GJC app descriptors are eligible while OMP and Cursor remain excluded', async () => {
  const identity = { provider: 'gjc', sessionId: `gjc-active-${Date.now()}` };
  const projectPath = `/gjc-project-${Date.now()}`;
  getConnection().prepare(
    'INSERT INTO projects (project_id, project_path) VALUES (?, ?)',
  ).run(`gjc-project-${Date.now()}`, projectPath);
  getConnection().prepare(`
    INSERT INTO sessions (session_id, provider, provider_session_id, project_path)
    VALUES (?, ?, ?, ?)
  `).run(identity.sessionId, identity.provider, 'gjc-native-session', projectPath);

  const gjc = await request('/completion-notifications/status', 'POST', { descriptors: [statusDescriptor(identity.provider, identity.sessionId)] });
  assert.equal(gjc.status, 200);
  assert.equal(gjc.body.targets[0].reason, 'eligible');
  assert.equal(gjc.body.targets[0].target.kind, 'app');

  for (const provider of ['omp', 'cursor']) {
    const response = await request('/completion-notifications/status', 'POST', {
      descriptors: [statusDescriptor(provider, identity.sessionId)],
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.targets[0].reason, 'not_found');
  }
});

test('standalone supported generations are watchable before a transcript exists while Cursor remains excluded', async () => {
  const sessions = (['claude', 'codex', 'opencode', 'omp'] as const).map((kind, index) => ({
    kind,
    tmuxName: `${kind}-standalone`,
    tmux: { socketPath: `/private/${kind}.socket`, sessionId: `$${index}`, windowId: `@${index}`, paneId: `%${index}` },
    agentPid: 10_000 + index,
    startedAtMs: 1_000 + index,
    providerSessionId: `${kind}-native-session`,
  }));
  const cursor = {
    kind: 'cursor' as const,
    tmuxName: 'cursor-attach-only',
    tmux: { socketPath: '/private/cursor.socket', sessionId: '$cursor', windowId: '@cursor', paneId: '%cursor' },
    agentPid: 20_000,
    startedAtMs: 2_000,
    providerSessionId: 'cursor-native-session',
  };
  app.locals.completionStatusDetailedDiscovery = async () => ({ ok: true, sessions: [...sessions, cursor] });

  const resolverStatuses = completionTargetResolver.resolveExternalStatuses(
    { ok: true, sessions: [...sessions, cursor] },
    userId,
  );
  assert.equal(resolverStatuses.length, sessions.length);
  assert.ok(resolverStatuses.every((status) => (
    status.mappingState === 'none'
    && status.reason === 'eligible'
    && status.target?.kind === 'external_generation'
  )));

  const response = await request('/completion-notifications/status', 'POST', {
    descriptors: sessions.map((session) => ({ kind: 'external_generation', session })),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.targets.map((target: any) => target.mappingState),
    sessions.map(() => 'none'),
  );
  assert.deepEqual(
    response.body.targets.map((target: any) => target.reason),
    sessions.map(() => 'eligible'),
  );
  assert.doesNotMatch(JSON.stringify(response.body), /native-session/);
  assert.ok(response.body.targets.every((target: any) => target.target?.kind === 'external_generation'));

  for (const target of response.body.targets) {
    const watch = await request('/completion-notifications', 'PUT', {
      alias: target.target.alias,
      expectedRevision: target.target.revision,
      mutationId: `standalone-${target.target.alias}`,
      watched: true,
    });
    assert.equal(watch.status, 200);
    assert.equal(watch.body.target.watched, true);
  }

  const ordinaryAppIdentity = { provider: 'omp', sessionId: 'ordinary-app-session' };
  getConnection().prepare(
    'INSERT INTO projects (project_id, project_path) VALUES (?, ?)',
  ).run('ordinary-omp-project', '/ordinary-omp-project');
  getConnection().prepare(`
    INSERT INTO sessions (session_id, provider, provider_session_id, project_path)
    VALUES (?, ?, ?, ?)
  `).run(ordinaryAppIdentity.sessionId, ordinaryAppIdentity.provider, 'ordinary-omp-native', '/ordinary-omp-project');
  const ordinaryAppIdentityKey = completionAppIdentityKey(ordinaryAppIdentity);
  const targetsBefore = getConnection().prepare(
    'SELECT count(*) AS count FROM completion_notification_targets WHERE identity_key = ?',
  ).get(ordinaryAppIdentityKey) as { count: number };

  const ordinaryOmp = await request('/completion-notifications/status', 'POST', {
    descriptors: [statusDescriptor(ordinaryAppIdentity.provider, ordinaryAppIdentity.sessionId)],
  });
  assert.equal(ordinaryOmp.status, 200);
  assert.deepEqual(ordinaryOmp.body.targets[0], {
    alias: completionAppAlias(ordinaryAppIdentity),
    mappingState: 'none',
    reason: 'not_found',
  });
  const targetsAfter = getConnection().prepare(
    'SELECT count(*) AS count FROM completion_notification_targets WHERE identity_key = ?',
  ).get(ordinaryAppIdentityKey) as { count: number };
  assert.equal(targetsAfter.count, targetsBefore.count);
  const unreadable = {
    kind: 'claude' as const,
    tmuxName: 'claude-unreadable',
    tmux: { socketPath: '/private/unreadable.socket', sessionId: '$unreadable', windowId: '@unreadable', paneId: '%unreadable' },
    agentPid: 30_000,
    startedAtMs: 3_000,
    providerSessionId: 'claude-native-session',
  };
  const unreadableIdentity = completionExternalGenerationIdentityFromSession(unreadable);
  assert.ok(unreadableIdentity);
  const unreadableTargetCount = getConnection().prepare(
    'SELECT count(*) AS count FROM completion_notification_targets WHERE identity_key = ?',
  ).get(completionExternalGenerationIdentityKey(unreadableIdentity)) as { count: number };
  assert.equal(unreadableTargetCount.count, 0);
  const unreadableStatuses = completionTargetResolver.resolveExternalStatuses(
    { ok: true, sessions: [unreadable] },
    userId,
  );
  assert.equal(unreadableStatuses.length, 1);
  assert.equal(unreadableStatuses[0]?.mappingState, 'none');
  assert.equal(unreadableStatuses[0]?.reason, 'eligible');
  assert.equal(unreadableStatuses[0]?.target?.kind, 'external_generation');
  const unreadableMapped = {
    ...sessions.find((session) => session.kind === 'codex')!,
    tmux: { socketPath: '/private/mapped.socket', sessionId: '$mapped', windowId: '@mapped', paneId: '%mapped' },
    agentPid: 40_000,
    startedAtMs: 4_000,
    providerSessionId: 'unreadable-mapped-codex',
  };
  const mappedProjectPath = `/unreadable-mapped-${Date.now()}`;
  getConnection().prepare(
    'INSERT INTO projects (project_id, project_path) VALUES (?, ?)',
  ).run(`unreadable-mapped-${Date.now()}`, mappedProjectPath);
  getConnection().prepare(`
    INSERT INTO sessions (session_id, provider, provider_session_id, project_path)
    VALUES (?, ?, ?, ?)
  `).run(`unreadable-mapped-${Date.now()}`, 'codex', unreadableMapped.providerSessionId, mappedProjectPath);
  assert.deepEqual(
    completionTargetResolver.resolveExternalStatuses({ ok: true, sessions: [unreadableMapped] }, userId),
    [{
      alias: completionExternalGenerationAlias(completionExternalGenerationIdentityFromSession(unreadableMapped)!),
      mappingState: 'none',
      reason: 'not_found',
    }],
  );
});
test('external descriptors return all resolver states from one HTTP discovery result and redact raw descriptor data', async () => {
  const original = completionTargetResolver.resolveExternalStatuses;
  const sessions = Array.from({ length: 4 }, (_, index) => ({
    kind: 'codex' as const,
    tmuxName: `codex-${index}`,
    tmux: { socketPath: `/private/socket-${index}`, sessionId: '$1', windowId: '@1', paneId: `%${index}` },
    agentPid: 9000 + index,
    startedAtMs: 10 + index,
  }));
  const aliases = sessions.map((session) => {
    const identity = completionExternalGenerationIdentityFromSession(session);
    assert.ok(identity);
    return completionExternalGenerationAlias(identity);
  });
  let calls = 0;
  completionTargetResolver.resolveExternalStatuses = (_detailed, resolvedUserId) => {
    calls += 1;
    assert.equal(resolvedUserId, userId);
    return [
      { alias: aliases[0], mappingState: 'one_active', reason: 'eligible', target: { alias: aliases[0], kind: 'external_generation', revision: 0, watched: false } },
      { alias: aliases[1], mappingState: 'none', reason: 'not_found' },
      { alias: aliases[2], mappingState: 'inactive_match', reason: 'identity_inactive' },
      { alias: aliases[3], mappingState: 'ambiguous_active', reason: 'identity_ambiguous' },
    ] as any;
  };
  try {
    const response = await request('/completion-notifications/status', 'POST', { descriptors: sessions.map((session) => ({ kind: 'external_generation', session })) });
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.deepEqual(response.body.targets.map((target: any) => target.reason), ['eligible', 'not_found', 'identity_inactive', 'identity_ambiguous']);
    assert.equal(JSON.stringify(response.body).includes('/private/socket-'), false);
    assert.equal(JSON.stringify(response.body).includes('9000'), false);
  } finally {
    completionTargetResolver.resolveExternalStatuses = original;
  }
});
test('one identity conflict is isolated without hiding unrelated session notification targets', async () => {
  const external = {
    kind: 'claude' as const,
    tmuxName: 'raw-tmux-name-evidence',
    tmux: {
      socketPath: '/private/raw-socket-path-evidence',
      sessionId: '$raw-native-session-evidence',
      windowId: '@raw-window-evidence',
      paneId: '%raw-pane-evidence',
    },
    agentPid: 12_345,
    startedAtMs: 1,
    providerSessionId: 'raw-native-session-evidence',
  };
  sessionsDb.createSession(
    external.providerSessionId,
    external.kind,
    '/private/raw-project-path-evidence',
    undefined,
    undefined,
    undefined,
    process.execPath,
  );

  const repository = completionNotificationTargetsDb;
  const createTarget = repository.createTarget;
  repository.createTarget = ((identityKey: string, kind: 'app' | 'external_generation', aliases: string[] = []) => {
    if (kind === 'app') {
      return { id: 903, kind: 'app', identity_key: 'raw-identity-key-evidence', revision: 1 };
    }
    return createTarget.call(repository, identityKey, kind, aliases);
  }) as typeof repository.createTarget;
  const healthy = {
    kind: 'codex' as const,
    tmuxName: 'healthy-codex',
    tmux: {
      socketPath: '/private/healthy.socket',
      sessionId: '$healthy',
      windowId: '@healthy',
      paneId: '%healthy',
    },
    agentPid: 54_321,
    startedAtMs: 2,
  };
  app.locals.completionStatusDetailedDiscovery = async () => ({ ok: true, sessions: [external, healthy] });

  const originalConsoleError = console.error;
  const captured: unknown[][] = [];
  console.error = (...args: unknown[]) => { captured.push(args); };
  try {
    const response = await request('/completion-notifications/status', 'POST', {
      descriptors: [
        { kind: 'external_generation', session: external },
        { kind: 'external_generation', session: healthy },
      ],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.targets.map((target: any) => target.reason), ['not_found', 'eligible']);
    assert.equal(response.body.targets[1]?.target?.kind, 'external_generation');
    assert.deepEqual(captured, []);
  } finally {
    console.error = originalConsoleError;
    repository.createTarget = createTarget;
  }
});
test('external discovery failures are fail-closed and do not mutate targets or watches', async () => {
  const session = {
    kind: 'codex',
    tmux: { socketPath: '/private/unavailable.socket', sessionId: '$unavailable', windowId: '@unavailable', paneId: '%unavailable' },
    agentPid: 50_000,
    startedAtMs: 5_000,
  };
  const descriptor = { kind: 'external_generation', session };
  const database = getConnection();
  const before = database.prepare(`
    SELECT
      (SELECT count(*) FROM completion_notification_targets) AS targets,
      (SELECT count(*) FROM completion_notification_watches) AS watches
  `).get() as { targets: number; watches: number };
  const failures = [
    ['throws', async () => { throw new Error('discovery unavailable'); }],
    ['reports unavailable', async () => ({ ok: false, sessions: [] })],
    ['is malformed', async () => ({ ok: true, sessions: [null] })],
  ] as const;

  for (const [, discovery] of failures) {
    app.locals.completionStatusDetailedDiscovery = discovery;
    const response = await request('/completion-notifications/status', 'POST', { descriptors: [descriptor] });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'discovery_unavailable' });
    assert.deepEqual(database.prepare(`
      SELECT
        (SELECT count(*) FROM completion_notification_targets) AS targets,
        (SELECT count(*) FROM completion_notification_watches) AS watches
    `).get(), before);
  }
});

test('watch mutations provide CAS conflicts, idempotent replay, replay conflict, and global pause state', async () => {
  const identity = { provider: 'claude', sessionId: 'watch-target' };
  const alias = completionAppAlias(identity);
  const target = completionNotificationTargetsDb.createTarget(completionAppIdentityKey(identity), 'app', [alias]);
  const initialRevision = target.revision;
  const first = await request('/completion-notifications', 'PUT', { alias, expectedRevision: initialRevision, mutationId: 'watch-1', watched: true });
  assert.equal(first.status, 200);
  assert.equal(first.body.target.watched, true);
  assert.equal(first.body.globalPaused, true);
  const replay = await request('/completion-notifications', 'PUT', { alias, expectedRevision: initialRevision, mutationId: 'watch-1', watched: true });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.target, first.body.target);
  const stale = await request('/completion-notifications', 'PUT', {
    alias,
    expectedRevision: initialRevision,
    mutationId: 'stale',
    watched: false,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'revision_conflict');
  assert.deepEqual(stale.body.target, {
    alias,
    kind: 'app',
    revision: initialRevision + 1,
    watched: true,
  });
  const missing = await request('/completion-notifications', 'PUT', {
    alias: 'missing-target',
    expectedRevision: 0,
    mutationId: 'missing-watch',
    watched: true,
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'not_found');
  assert.equal(missing.body.target, null);

  const replayConflict = await request('/completion-notifications', 'PUT', { alias, expectedRevision: initialRevision, mutationId: 'watch-1', watched: false });
  assert.equal(replayConflict.status, 409);
  assert.deepEqual(replayConflict.body, {
    error: 'mutation_replay_conflict',
    target: null,
    globalPaused: true,
    device: {
      supported: true,
      registered: false,
      setupRequired: true,
      reason: 'device_endpoint_missing',
    },
  });
});
test('completion preference updates require explicit subscription to enable and atomically pause queued delivery on normal disable', async () => {
  const before = notificationPreferencesDb.getPreferences(userId);
  const paused = await request('/notification-preferences', 'PUT', {
    ...before,
    channels: { ...before.channels, webPush: false },
  });
  assert.equal(paused.status, 200);
  assert.equal(notificationPreferencesDb.isCompletionGlobalPaused(userId), true);

  const unconsentedEnable = await request('/notification-preferences', 'PUT', {
    ...paused.body.preferences,
    channels: { ...paused.body.preferences.channels, webPush: true },
  });
  assert.equal(unconsentedEnable.status, 500);
  assert.equal(notificationPreferencesDb.isCompletionGlobalPaused(userId), true);
  const endpoint = 'https://push.example.test/route-pause';
  const subscribed = await request('/push/subscribe', 'POST', validSubscription(endpoint));
  assert.equal(subscribed.status, 200);
  const partial = await request('/notification-preferences', 'PUT', { events: { error: false } });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.preferences.channels.webPush, true);
  assert.equal(notificationPreferencesDb.isCompletionGlobalPaused(userId), false);

  const db = getConnection();
  const decisionId = `route-pause-${Date.now()}`;
  const outboxId = db.prepare(`INSERT INTO completion_notification_outbox
    (decision_id, decision_key, user_id, event_code, target_alias_snapshot, payload_json, notification_tag)
    VALUES (?, ?, ?, 'reply_ready', 'route-pause', '{}', 'tag')`)
    .run(decisionId, decisionId, userId).lastInsertRowid;
  const subscription = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as { id: number };
  const deliveryId = db.prepare(`INSERT INTO completion_notification_deliveries
    (outbox_id, subscription_id, subscription_id_at_creation, endpoint_owner_id, endpoint_snapshot, next_due_at)
    VALUES (?, ?, ?, ?, ?, 0)`)
    .run(outboxId, subscription.id, subscription.id, userId, endpoint).lastInsertRowid;
  assert.equal((db.prepare('SELECT state FROM completion_notification_deliveries WHERE id = ?')
    .get(deliveryId) as { state: string }).state, 'pending');

  const disabled = await request('/notification-preferences', 'PUT', {
    ...notificationPreferencesDb.getPreferences(userId),
    channels: { ...notificationPreferencesDb.getPreferences(userId).channels, webPush: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal(notificationPreferencesDb.isCompletionGlobalPaused(userId), true);
  assert.equal((db.prepare('SELECT state FROM completion_notification_deliveries WHERE id = ?')
    .get(deliveryId) as { state: string }).state, 'paused_global');
});

test('push subscribe records consent while register does not; validation, owner isolation, and unsubscribe are HTTP-visible', async () => {
  const current = notificationPreferencesDb.getPreferences(userId);
  const disabled = await request('/notification-preferences', 'PUT', {
    ...current,
    channels: { ...current.channels, webPush: false },
  });
  assert.equal(disabled.status, 200);
  const invalid = await request('/push/subscribe', 'POST', { endpoint: 'http://example.test', keys: { p256dh: '***', auth: 'Ag' } });
  assert.equal(invalid.status, 400);
  const registered = await request('/push/register', 'POST', validSubscription('https://push.example.test/register'));
  assert.equal(registered.status, 200);
  assert.equal(notificationPreferencesDb.getPreferences(userId).channels.webPush, false);
  const subscribed = await request('/push/subscribe', 'POST', validSubscription());
  assert.equal(subscribed.status, 200);
  assert.equal(notificationPreferencesDb.getPreferences(userId).channels.webPush, true);
  const crossOwner = await request('/push/register', 'POST', validSubscription(), `Bearer ${otherToken}`);
  assert.equal(crossOwner.status, 409);
  assert.equal(crossOwner.body.error, 'endpoint_owned_by_another_user');
  const removed = await request('/push/unsubscribe', 'POST', { endpoint: 'https://push.example.test/subscription' });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.device.registered, false);
});
