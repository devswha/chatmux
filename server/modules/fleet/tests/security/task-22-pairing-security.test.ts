import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

import { createFleetPairingRouter } from '@/modules/fleet/fleet-pairing.routes.js';
import { FleetPairingFailureLimiter } from '@/modules/fleet/services/fleet-pairing-limiter.service.js';
import { FleetPairingService } from '@/modules/fleet/services/fleet-pairing.service.js';
import { SqliteFleetPairingStore } from '@/modules/fleet/services/fleet-pairing-store.service.js';
import type { SignedInstallationIdentity } from '@/modules/fleet/services/fleet-pairing.service.js';

import {
  assertNoSecretMaterial,
  createInstallation,
  PEER_SECURITY_SCHEMA_SQL,
  signedIdentity,
  type TestInstallation,
} from './support/identities.js';
import { armTraceFlush, recordedTraces, recordTrace } from './support/traces.js';

armTraceFlush('task-22-pairing-security');

const PEER_ID = '00000000-0000-4000-8000-000000000001';
const HUB_ID = '10000000-0000-4000-8000-000000000001';
const UNKNOWN_TOKEN = Buffer.alloc(32, 9).toString('base64url');

type PairingApp = Readonly<{
  baseUrl: string;
  clock: { now: number };
  db: Database.Database;
  hubIdentity: SignedInstallationIdentity;
  issue(): string;
}>;

async function startPairingApp(context: test.TestContext): Promise<PairingApp> {
  const clock = { now: 1_000_000 };
  const peer: TestInstallation = createInstallation(PEER_ID);
  const hub: TestInstallation = createInstallation(HUB_ID);
  const db = new Database(':memory:');
  db.exec(PEER_SECURITY_SCHEMA_SQL);
  const pairing = new FleetPairingService({
    store: new SqliteFleetPairingStore(db),
    identity: await signedIdentity(peer),
    now: () => clock.now,
  });
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.set('trust proxy', true);
  app.use((request, _response, next) => {
    if (request.headers['x-test-owner'] === 'yes') {
      Object.defineProperty(request, 'user', { value: { id: 1 } });
    }
    next();
  });
  app.use('/fleet', createFleetPairingRouter({
    authMode: 'password',
    limiter: new FleetPairingFailureLimiter({ now: () => clock.now }),
    pairing,
    hubPairing: { enroll: async () => ({ peerId: PEER_ID }) },
    revocation: { remove: async () => ({ localRemoval: 'removed' as const, peerRevocation: 'revoked' as const }) },
  }));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('pairing app has no TCP address');
  context.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    db.close();
  });
  return {
    baseUrl: `http://127.0.0.1:${address.port}/fleet`,
    clock, db,
    hubIdentity: await signedIdentity(hub),
    issue: () => pairing.issueToken().token,
  };
}

function redeem(
  app: PairingApp,
  token: string,
  headers: Readonly<Record<string, string>> = {},
  query = '',
): Promise<Response> {
  return fetch(`${app.baseUrl}/pairing/redeem${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ token, hub: app.hubIdentity }),
  });
}

async function bodyText(response: Response): Promise<string> {
  return JSON.stringify(await response.json());
}

test('Given a live pairing route, when one client brute forces tokens, then the sixth attempt is rate limited and the window resets', async (context) => {
  // Given
  const app = await startPairingApp(context);
  // When: five well-shaped unknown tokens and a sixth attempt arrive from one client.
  const failures = [];
  for (let attempt = 0; attempt < 5; attempt += 1) failures.push(await redeem(app, UNKNOWN_TOKEN));
  const blocked = await redeem(app, UNKNOWN_TOKEN);
  // Then: explicit 401s, a bounded 429, and zero grants persisted.
  assert.deepEqual(failures.map((response) => response.status), [401, 401, 401, 401, 401]);
  for (const failure of failures) assert.deepEqual(await failure.json(), { error: 'TOKEN_NOT_FOUND' });
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: 'PAIRING_RATE_LIMITED' });
  assert.equal(blocked.headers.get('retry-after'), '60');
  recordTrace({ case: 'pairing.brute-force', surface: 'http', request: 'POST /pairing/redeem x6 unknown-token', outcome: '401 TOKEN_NOT_FOUND x5 then 429 PAIRING_RATE_LIMITED retry-after=60', sideEffects: 'grants=0' });
  // When: the failure window elapses on the fake clock.
  app.clock.now += 61_000;
  const afterWindow = await redeem(app, UNKNOWN_TOKEN);
  // Then: admission resumes and still fails explicitly without a grant.
  assert.equal(afterWindow.status, 401);
  const grants = app.db.prepare<[], Readonly<{ count: number }>>('SELECT COUNT(*) AS count FROM fleet_hub_grants').get();
  assert.deepEqual(grants, { count: 0 });
});

test('Given one live token, when eight clients redeem concurrently, then exactly one enrolls and the rest fail once', async (context) => {
  // Given
  const app = await startPairingApp(context);
  const token = app.issue();
  // When: eight distinct clients race the same token through the real route and store.
  const responses = await Promise.all(Array.from({ length: 8 }, (_value, index) => redeem(
    app,
    token,
    { 'x-forwarded-for': `10.22.22.${index + 1}` },
  )));
  // Then: one winner, seven explicit once-only rejections, one active grant, no token leakage.
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 410, 410, 410, 410, 410, 410, 410]);
  const bodies = await Promise.all(responses.map(bodyText));
  const winner = responses.findIndex((response) => response.status === 200);
  assert.notEqual(winner, -1);
  assert.match(bodies[winner] ?? '', new RegExp(PEER_ID));
  for (const [index, body] of bodies.entries()) {
    if (index !== winner) assert.deepEqual(JSON.parse(body), { error: 'TOKEN_ALREADY_USED' });
    assert.equal(body.includes(token), false, 'pairing response echoes the token');
  }
  const active = app.db.prepare<[], Readonly<{ count: number }>>(
    "SELECT COUNT(*) AS count FROM fleet_hub_grants WHERE grant_state = 'active'",
  ).get();
  assert.deepEqual(active, { count: 1 });
  recordTrace({ case: 'pairing.redeem-race', surface: 'http', request: 'POST /pairing/redeem x8 concurrent same-token', outcome: '200 x1 then 410 TOKEN_ALREADY_USED x7', sideEffects: 'active-grants=1' });
});

test('Given browser credential channels, when redemption carries them, then rejection precedes the limiter and replacement requires revocation', async (context) => {
  // Given
  const app = await startPairingApp(context);
  // When: cookie, authorization, origin, and query credentials arrive on the machine channel.
  const cookie = await redeem(app, UNKNOWN_TOKEN, { cookie: 'chatmux_auth=browser-secret' });
  const bearer = await redeem(app, UNKNOWN_TOKEN, { authorization: 'Bearer browser-secret' });
  const origin = await redeem(app, UNKNOWN_TOKEN, { origin: 'https://attacker.example' });
  const query = await redeem(app, UNKNOWN_TOKEN, {}, '?token=query-secret');
  // Then: each fails 400 before the limiter and before any service call.
  for (const response of [cookie, bearer, origin, query]) {
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'MACHINE_CREDENTIAL_INVALID' });
  }
  recordTrace({ case: 'pairing.credential-channel', surface: 'http', request: 'POST /pairing/redeem with cookie/authorization/origin/query', outcome: '400 MACHINE_CREDENTIAL_INVALID x4', sideEffects: 'limiter-failures=0 grants=0' });
  // When: four real token failures follow, a valid redemption is still admitted.
  for (let attempt = 0; attempt < 4; attempt += 1) assert.equal((await redeem(app, UNKNOWN_TOKEN)).status, 401);
  const first = await redeem(app, app.issue());
  assert.equal(first.status, 200);
  // When: a replacement token is offered while the grant is active, and after owner revocation.
  const blocked = await redeem(app, app.issue());
  const nonOwner = await fetch(`${app.baseUrl}/hub-grant`, { method: 'DELETE' });
  const revoked = await fetch(`${app.baseUrl}/hub-grant`, { method: 'DELETE', headers: { 'x-test-owner': 'yes' } });
  const replacement = await redeem(app, app.issue());
  // Then: active grant conflicts, owner-only revocation, and clean replacement.
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { error: 'ACTIVE_GRANT_EXISTS' });
  assert.equal(nonOwner.status, 403);
  assert.deepEqual(await nonOwner.json(), { error: 'owner_required' });
  assert.deepEqual(await revoked.json(), { revoked: true });
  assert.equal(replacement.status, 200);
  recordTrace({ case: 'pairing.replacement-gating', surface: 'http', request: 'redeem active-grant then DELETE /hub-grant non-owner/owner then re-redeem', outcome: '409 ACTIVE_GRANT_EXISTS, 403 owner_required, revoked=true, 200', sideEffects: 'active-grants=1' });
});

test('Given the recorded denial surface, when it is scanned, then no secret material crosses', () => {
  // Given: every denial this file produced over real HTTP.
  const serialized = JSON.stringify(recordedTraces());
  // When: the surface is scanned for known secrets and secret shapes.
  assertNoSecretMaterial(serialized, [UNKNOWN_TOKEN]);
  // Then: outcomes are machine codes only.
  for (const trace of recordedTraces()) {
    assert.match(trace.outcome, /^[0-9a-zA-Z_=, .:-]+$/);
  }
});
