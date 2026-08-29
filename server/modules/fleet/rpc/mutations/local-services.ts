import { randomUUID } from 'node:crypto';

import { getConnection, projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  answerTmuxApproval,
  answerTmuxInteractivePrompt,
  assertFreshExternalTmuxTarget,
  assertLineageTmuxTarget,
  getCurrentTmuxPaneIdentityState,
  killTmuxPane,
  killTmuxSession,
  resolveExternalCliCwd,
  sameTmuxPaneIdentity,
  sendTmuxProcessAction,
  sendToTmuxPane,
  spawnLiveSession,
  stopAgentProcessInPane,
  submitTmuxInteractiveCustomResponse,
  type DiscoveryCollector,
  type DiscoveryRow,
  type VerifiedTmuxActionTarget,
} from '@/modules/providers/index.js';

import type { FleetPaneReference } from '../../../../../shared/fleet.js';
import { fleetCatalogPaneKey } from '../../catalog/keys.js';

import { FleetMutationRpcError } from './errors.js';
import type { FleetMutationRequest, PromptResponse } from './contracts.js';
import type { FleetMutationServices, MutationActionTarget, VerifiedSpawn } from './peer.js';

type Database = ReturnType<typeof getConnection>;
function paneMatches(row: DiscoveryRow, target: FleetPaneReference): boolean { return fleetCatalogPaneKey(row.lane, row.tmux) === target.localId && row.lane === target.lane && row.process?.pid === target.process.pid && row.process.startedAtMs === target.process.startedAtMs && sameTmuxPaneIdentity(row.tmux, target.tmux); }
async function verifyRow(row: DiscoveryRow): Promise<VerifiedTmuxActionTarget> {
  if (row.process === null) throw new FleetMutationRpcError('FLEET_STALE_GENERATION', 'pane process generation is stale');
  return row.lane === 'live' ? assertLineageTmuxTarget(row.tmux, row.process) : assertFreshExternalTmuxTarget(row.tmux, row.process);
}
function protectionMode(operation: FleetMutationRequest['operation']): 'process' | 'pane' | 'session' | null {
  switch (operation) {
    case 'chat.abort': case 'pane.interrupt': case 'pane.escape': case 'pane.terminate': return 'pane';
    case 'process.terminate': return 'process';
    case 'session.terminate': return 'session';
    case 'chat.send': case 'pane.input': case 'prompt.respond': case 'approval.respond': case 'session.spawn': return null;
  }
}
async function assertProtection(target: VerifiedTmuxActionTarget, mode: 'process' | 'pane' | 'session'): Promise<void> {
  if ((target.tmuxName ?? '').toLowerCase().startsWith('company')) throw new FleetMutationRpcError('FLEET_UNAUTHORIZED', 'tmux target is protected');
  const current = await getCurrentTmuxPaneIdentityState();
  if (current.state === 'unavailable') throw new FleetMutationRpcError('FLEET_UNAUTHORIZED', 'hosted pane protection is unavailable');
  if (current.state !== 'hosted' || current.tmux.socketPath !== target.tmux.socketPath) return;
  if (mode === 'session' ? current.tmux.sessionId === target.tmux.sessionId : current.tmux.paneId === target.tmux.paneId) throw new FleetMutationRpcError('FLEET_UNAUTHORIZED', 'tmux target is protected');
}
type PersistedMutationAuthorityOptions = Readonly<{ readonly db: Database; readonly localHostId: string; readonly beforeRead?: () => Promise<void> }>;
export function createPersistedMutationAuthority(options: PersistedMutationAuthorityOptions): Readonly<{ readonly assertCurrent: (request: FleetMutationRequest) => Promise<void> }> {
  return { assertCurrent: async (request) => {
    await options.beforeRead?.();
    const key = `fleet.peer.connection-generation.${options.localHostId}`;
    const generation = options.db.prepare<[string], Readonly<{ value: unknown }>>('SELECT value FROM app_config WHERE key = ?').get(key);
    if (Number(generation?.value) !== request.connectionGeneration) throw new FleetMutationRpcError('FLEET_STALE_GENERATION', 'connection generation is stale');
    const grant = options.db.prepare<[string], Readonly<{ count: number }>>("SELECT COUNT(*) AS count FROM fleet_hub_grants WHERE peer_id = ? AND grant_state = 'active'").get(options.localHostId);
    if (grant?.count !== 1) throw new FleetMutationRpcError('HOST_REVOKED', 'hub grant is no longer active');
  } };
}
export function createLocalFleetMutationServices(localHostId: string, discovery: DiscoveryCollector, db: Database): FleetMutationServices {
  const authority = createPersistedMutationAuthority({ db, localHostId });
  const verified = new WeakMap<MutationActionTarget, VerifiedTmuxActionTarget>();
  const wrap = (value: VerifiedTmuxActionTarget): MutationActionTarget => { const key = { token: randomUUID() }; verified.set(key, value); return key; };
  const unwrap = (key: MutationActionTarget): VerifiedTmuxActionTarget => { const value = verified.get(key); if (value === undefined) throw new FleetMutationRpcError('FLEET_STALE_GENERATION', 'verified target expired'); return value; };
  const verifyPane = async (target: FleetPaneReference): Promise<MutationActionTarget> => { await discovery.ensureFresh(0, true); const row = discovery.currentSnapshot().rows.find((item) => paneMatches(item, target)); if (row === undefined) throw new FleetMutationRpcError('FLEET_STALE_GENERATION', 'pane generation is stale'); return wrap(await verifyRow(row)); };
  const verifySession = async (localId: string): Promise<MutationActionTarget> => {
    const session = sessionsDb.getSessionById(localId); if (session === null) throw new FleetMutationRpcError('HOST_NOT_FOUND', 'session was not found');
    await discovery.ensureFresh(0, true); const nativeId = session.provider_session_id ?? session.session_id; const rows = discovery.currentSnapshot().rows.filter((row) => row.providerSessionId === nativeId && row.process !== null);
    if (rows.length !== 1 || rows[0] === undefined) throw new FleetMutationRpcError('FLEET_STALE_GENERATION', 'session has no unique current pane'); return wrap(await verifyRow(rows[0]));
  };
  const finalCheck = async (request: FleetMutationRequest, value: MutationActionTarget | VerifiedSpawn): Promise<void> => {
    if ('token' in value) { const mode = protectionMode(request.operation); if (mode !== null) await assertProtection(unwrap(value), mode); }
    await authority.assertCurrent(request);
  };
  const prompt = async (key: MutationActionTarget, response: PromptResponse) => response.response === 'choices' ? answerTmuxInteractivePrompt(unwrap(key), response.promptId, response.choices) : submitTmuxInteractiveCustomResponse(unwrap(key), response.promptId, response.message).then(() => ({ action: 'selected' as const }));
  return {
    verifySession, verifyPane,
    verifySpawn: async (projectLocalId, cwd) => { if (projectsDb.getProjectById(projectLocalId) === null) throw new FleetMutationRpcError('HOST_NOT_FOUND', 'project was not found'); const resolved = await resolveExternalCliCwd(cwd); if (resolved === null) throw new FleetMutationRpcError('FLEET_UNAUTHORIZED', 'spawn cwd is outside peer home'); return { cwd: resolved }; },
    finalCheck, send: (key, message) => sendToTmuxPane(unwrap(key), message), abort: (key) => sendTmuxProcessAction(unwrap(key), 'interrupt'), interrupt: (key) => sendTmuxProcessAction(unwrap(key), 'interrupt'), escape: (key) => sendTmuxProcessAction(unwrap(key), 'escape'), respondPrompt: prompt,
    respondApproval: (key, decision) => answerTmuxApproval(unwrap(key), decision), spawn: async (value, name) => spawnLiveSession(name, value.cwd), terminateProcess: (key) => stopAgentProcessInPane(unwrap(key)), terminatePane: (key) => killTmuxPane(unwrap(key)), terminateSession: (key) => killTmuxSession(unwrap(key)),
  };
}
