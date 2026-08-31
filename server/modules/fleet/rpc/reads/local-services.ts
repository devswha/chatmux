import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  assertFreshExternalTmuxTarget,
  assertLineageTmuxTarget,
  captureTmuxPane,
  getHomeDirSuggestions,
  getTmuxApprovalPrompt,
  getTmuxInteractivePrompt,
  listLiveGjcCommands,
  normalizeExternalPaneOutput,
  providerSkillsService,
  sameTmuxPaneIdentity,
  sessionConversationsSearchService,
  sessionsService,
  type DiscoveryCollector,
  type DiscoveryRow,
  type VerifiedTmuxActionTarget,
} from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import type { JsonValue } from '../../../../../shared/fleet.js';
import { fleetCatalogPaneKey } from '../../catalog/keys.js';

import { FleetReadRpcError } from './errors.js';
import type { FleetReadServices } from './peer.js';

function json(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value !== 'object') return null;
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = json(item);
  }
  return result;
}

function rowMatchesPane(row: DiscoveryRow, target: Parameters<FleetReadServices['capturePane']>[0]): boolean {
  return fleetCatalogPaneKey(row.lane, row.tmux) === target.localId && row.lane === target.lane && row.process?.pid === target.process.pid
    && row.process.startedAtMs === target.process.startedAtMs && sameTmuxPaneIdentity(row.tmux, target.tmux);
}

async function verifiedRow(row: DiscoveryRow): Promise<VerifiedTmuxActionTarget> {
  if (row.process === null) throw new FleetReadRpcError('HOST_NOT_FOUND', 'local pane generation was not found');
  return row.lane === 'live'
    ? assertLineageTmuxTarget(row.tmux, row.process)
    : assertFreshExternalTmuxTarget(row.tmux, row.process);
}

async function freshSessionTarget(discovery: DiscoveryCollector, localId: string): Promise<VerifiedTmuxActionTarget> {
  const session = sessionsDb.getSessionById(localId);
  if (session === null) throw new FleetReadRpcError('HOST_NOT_FOUND', 'local session was not found');
  await discovery.ensureFresh(0, true);
  const nativeId = session.provider_session_id ?? session.session_id;
  const rows = discovery.currentSnapshot().rows.filter((row) => row.providerSessionId === nativeId && row.process !== null);
  if (rows.length !== 1) throw new FleetReadRpcError('HOST_NOT_FOUND', 'local session has no unique fresh pane');
  const row = rows[0];
  if (row === undefined) throw new FleetReadRpcError('HOST_NOT_FOUND', 'local session pane was not found');
  return verifiedRow(row);
}

export function createLocalFleetReadServices(discovery: DiscoveryCollector): FleetReadServices {
  return {
    sessionMetadata: async (localId) => {
      const session = sessionsDb.getSessionById(localId);
      if (session === null) return null;
      const project = session.project_path === null ? null : projectsDb.getProjectPath(session.project_path);
      return json({
        sessionId: session.session_id,
        provider: session.provider,
        summary: session.custom_name ?? '',
        projectId: project?.project_id ?? null,
        projectPath: session.project_path,
        projectName: project === null
          ? null
          : project.custom_project_name?.trim() || path.basename(project.project_path) || project.project_path,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
      });
    },
    history: async (localId, options) => json(await sessionsService.fetchHistory(localId, options)),
    search: async (projectLocalId, options) => {
      if (projectsDb.getProjectById(projectLocalId) === null) throw new FleetReadRpcError('HOST_NOT_FOUND', 'local project was not found');
      const results: JsonValue[] = []; let totalMatches = 0;
      await sessionConversationsSearchService.search({ query: options.query, limit: options.limit, signal: options.signal, onProgress: ({ projectResult }) => {
        if (projectResult?.projectId !== projectLocalId) return;
        results.push(json(projectResult));
        totalMatches += projectResult.sessions.reduce((total, session) => total + session.matches.length, 0);
      } });
      return { query: options.query, totalMatches, results };
    },
    prompt: async (localId) => json({ prompt: await getTmuxInteractivePrompt(await freshSessionTarget(discovery, localId)) }),
    approval: async (localId) => json({ approval: await getTmuxApprovalPrompt(await freshSessionTarget(discovery, localId)) }),
    capturePane: async (target) => {
      await discovery.ensureFresh(0, true);
      const row = discovery.currentSnapshot().rows.find((candidate) => rowMatchesPane(candidate, target));
      if (row === undefined) throw new FleetReadRpcError('HOST_NOT_FOUND', 'local pane was not found');
      return { output: normalizeExternalPaneOutput(await captureTmuxPane(await verifiedRow(row))) };
    },
    providerInventory: async (localId) => {
      const session = sessionsDb.getSessionById(localId);
      if (session === null) return null;
      const workspacePath = session.project_path ?? undefined;
      const entries = session.provider === 'gjc'
        ? await listLiveGjcCommands(workspacePath)
        : await providerSkillsService.listProviderSkills(session.provider, { workspacePath });
      return json({ provider: session.provider, commands: entries.map((entry) => ({ name: entry.name, description: entry.description ?? '', scope: entry.scope })) });
    },
    chatSubscription: async (localId, lastSeq) => {
      if (sessionsDb.getSessionById(localId) === null) return null;
      const run = chatRunRegistry.getRun(localId);
      return json({
        isProcessing: run?.status === 'running',
        lastSeq: run?.lastSeq ?? 0,
        events: run?.status === 'running' ? chatRunRegistry.replayEvents(localId, lastSeq) : [],
      });
    },
    pathSuggestions: async (projectLocalId, prefix) => projectsDb.getProjectById(projectLocalId) === null
      ? null
      : { suggestions: await getHomeDirSuggestions(prefix) },
  };
}
