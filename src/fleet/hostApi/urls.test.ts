import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hostApprovalUrl,
  hostDirSuggestionsUrl,
  hostInventoryUrl,
  hostProjectFilesUrl,
  hostPromptUrl,
  hostSessionMessagesUrl,
  hostSessionTokenUsageUrl,
  hostSpawnUrl,
  hostTranscriptSearchUrl,
  isLocalHostScope,
} from './urls';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER_A = '22222222-2222-4222-8222-222222222222';
const PEER_B = '33333333-3333-4333-8333-333333333333';
const SESSION = 'session-collision';
const PROJECT = 'project-collision';

const local = { hostId: LOCAL, localHostId: LOCAL };
const unknown = { hostId: null, localHostId: null };
const peerA = { hostId: PEER_A, localHostId: LOCAL };
const peerB = { hostId: PEER_B, localHostId: LOCAL };

test('Given a scope, when locality is asked, then only the local host and an unknown identity are local', () => {
  // Given / When / Then
  assert.equal(isLocalHostScope(local), true);
  assert.equal(isLocalHostScope(unknown), true);
  assert.equal(isLocalHostScope(peerA), false);
});

test('Given the local host, when every session and project URL is built, then existing local endpoints are used unchanged', () => {
  // Given / When / Then
  assert.equal(hostSessionMessagesUrl(local, SESSION, 'limit=20'), `/api/providers/sessions/${SESSION}/messages?limit=20`);
  assert.equal(hostInventoryUrl(local, SESSION), '/api/providers/sessions/live/commands');
  assert.equal(hostSessionTokenUsageUrl(local, PROJECT, SESSION), `/api/projects/${PROJECT}/sessions/${SESSION}/token-usage`);
  assert.equal(hostProjectFilesUrl(local, PROJECT), `/api/projects/${PROJECT}/files`);
  assert.equal(hostPromptUrl(local, SESSION), null);
  assert.equal(hostApprovalUrl(local, SESSION), null);
  assert.equal(hostDirSuggestionsUrl(local, PROJECT, 'repos/app'), '/api/providers/fs/dir-suggestions?prefix=repos%2Fapp');
  assert.equal(hostSpawnUrl(local, PROJECT), null);
  assert.equal(hostTranscriptSearchUrl(local, PROJECT, { query: 'needle', limit: 50 }), null);
});

test('Given the same local session id on two peers, when URLs are built, then each URL names exactly its own host', () => {
  // Given / When
  const messagesA = hostSessionMessagesUrl(peerA, SESSION, 'limit=20');
  const messagesB = hostSessionMessagesUrl(peerB, SESSION, 'limit=20');

  // Then
  assert.equal(messagesA, `/api/hosts/${PEER_A}/providers/sessions/${SESSION}/messages?limit=20`);
  assert.equal(messagesB, `/api/hosts/${PEER_B}/providers/sessions/${SESSION}/messages?limit=20`);
  assert.notEqual(messagesA, messagesB);
  assert.equal(hostInventoryUrl(peerA, SESSION), `/api/hosts/${PEER_A}/providers/sessions/${SESSION}/inventory`);
  assert.equal(hostSessionTokenUsageUrl(peerA, PROJECT, SESSION), null);
  assert.equal(hostProjectFilesUrl(peerA, PROJECT), null);
  assert.equal(hostPromptUrl(peerB, SESSION), `/api/hosts/${PEER_B}/providers/sessions/${SESSION}/prompt`);
  assert.equal(hostApprovalUrl(peerB, SESSION), `/api/hosts/${PEER_B}/providers/sessions/${SESSION}/approval`);
  assert.equal(hostSpawnUrl(peerA, PROJECT), `/api/hosts/${PEER_A}/projects/${PROJECT}/sessions/spawn`);
  assert.equal(
    hostTranscriptSearchUrl(peerA, PROJECT, { query: 'nee dle', limit: 25 }),
    `/api/hosts/${PEER_A}/projects/${PROJECT}/search?query=nee+dle&limit=25`,
  );
  assert.equal(
    hostDirSuggestionsUrl(peerB, PROJECT, 'repos/app'),
    `/api/hosts/${PEER_B}/projects/${PROJECT}/dir-suggestions?prefix=repos%2Fapp`,
  );
});

test('Given identifiers needing escaping, when URLs are built, then every segment is encoded', () => {
  // Given / When
  const url = hostSessionMessagesUrl({ hostId: PEER_A, localHostId: LOCAL }, 'a b/c', '');

  // Then
  assert.equal(url, `/api/hosts/${PEER_A}/providers/sessions/a%20b%2Fc/messages`);
});
