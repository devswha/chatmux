import express, { type Request, type Response } from 'express';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { emitRelayKeyDiagnostic } from '@/modules/notifications/index.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { sessionConversationsSearchService } from '@/modules/providers/services/session-conversations-search.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import {
  getLiveGjcSessionsDetailed,
  type LiveGjcSession,
} from '@/modules/providers/services/live-sessions.service.js';
import {
  getCurrentTmuxPaneIdentityState,
  getExternalCliSessionsDetailed,
  normalizeExternalPaneOutput,
  resolveExternalCliCwd,
  spawnExternalCliSession,
  type ExternalCliSession,
  type ExternalSpawnCli,
} from '@/modules/providers/services/external-cli-sessions.service.js';
import {
  type DiscoveryCollector,
  type DiscoveryLane,
  type DiscoveryRow,
} from '@/modules/providers/services/discovery-collector.service.js';
import {
  resolveExternalSessionActivity,
  toExternalSessionDisplayActivity,
} from '@/modules/providers/services/external-session-activity.service.js';
import { getHomeDir, getHomeDirSuggestions } from '@/modules/providers/services/home-dirs.service.js';
import { isValidSpawnName, spawnLiveSession } from '@/modules/providers/services/live-send.service.js';
import { listLiveGjcCommands } from '@/modules/providers/services/live-commands.service.js';
import { assertLineageTmuxTarget } from '@/modules/providers/services/tmux-target-guard.service.js';
import { assertFreshExternalTmuxTarget, type VerifiedTmuxActionTarget } from '@/modules/providers/services/tmux-fresh-verifier.service.js';
import {
  answerPendingTmuxAskSelection,
  findPendingTmuxAsk,
  submitPendingTmuxAskCustomResponse,
  type PendingTmuxAsk,
} from '@/modules/providers/services/tmux-ask-selection.service.js';
import {
  answerTmuxApproval,
  getTmuxApprovalPrompt,
  type TmuxApprovalDecision,
} from '@/modules/providers/services/tmux-approval.service.js';
import {
  answerTmuxInteractivePrompt,
  getCachedTmuxInteractiveActivity,
  getTmuxInteractivePrompt,
  submitTmuxInteractiveCustomResponse,
} from '@/modules/providers/services/tmux-interactive-prompt.service.js';
import {
  captureTmuxPane,
  killTmuxPane,
  killTmuxSession,
  readTmuxPaneIdentity,
  readTmuxProcessGeneration,
  sendTmuxProcessAction,
  sendToTmuxPane,
  stopAgentProcessInPane,
  type TmuxProcessAction,
} from '@/modules/providers/services/tmux-pane-actions.service.js';
import type {
  LLMProvider,
  McpScope,
  McpTransport,
  ProviderChangeActiveModelInput,
  ProviderSkillCreateFile,
  ProviderSkillCreateInput,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import { attachCapabilityService } from './services/attach-capability.service.js';


const router = express.Router();

type TmuxTerminationMode = 'process' | 'pane' | 'session';

function readTerminationMode(value: unknown): TmuxTerminationMode {
  if (value === undefined || value === null || value === '') return 'process';
  if (value === 'process' || value === 'pane' || value === 'session') return value;
  throw new AppError('mode must be process, pane, or session.', {
    code: 'INVALID_TMUX_TERMINATION_MODE',
    statusCode: 400,
  });
}
function readTmuxProcessAction(value: unknown): TmuxProcessAction {
  if (value === 'interrupt' || value === 'escape') return value;
  // No action-specific error code exists in the established control API.
  throw new AppError('action must be interrupt or escape.', {
    code: 'INVALID_TMUX_TERMINATION_MODE',
    statusCode: 400,
  });
}
function externalProcessGeneration(session: {
  agentPid?: number;
  startedAtMs?: number;
}) {
  return session.agentPid !== undefined && session.startedAtMs !== undefined
    ? { pid: session.agentPid, startedAtMs: session.startedAtMs }
    : null;
}

function readAskToolId(value: unknown): string {
  const toolId = typeof value === 'string' ? value.trim() : '';
  if (!toolId || toolId.length > 500) {
    throw new AppError('toolId is required.', {
      code: 'INVALID_TMUX_ASK_TOOL_ID',
      statusCode: 400,
    });
  }
  return toolId;
}

function readAskOptionIndex(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < -1 || (value as number) > 32) {
    throw new AppError('optionIndex must identify a displayed choice, direct input, or cancel.', {
      code: 'INVALID_TMUX_ASK_SELECTION',
      statusCode: 400,
    });
  }
  return value as number;
}

async function loadPendingTmuxAsk(
  target: VerifiedTmuxActionTarget,
  sessionIdValue: unknown,
  toolIdValue: unknown,
): Promise<PendingTmuxAsk> {
  if (target.kind !== 'gjc' && target.kind !== 'codex' && target.kind !== 'omp' && target.kind !== 'claude') {
    throw new AppError('This CLI does not support transcript selections.', {
      code: 'TMUX_ASK_UNSUPPORTED',
      statusCode: 400,
    });
  }
  const sessionId = assertTmuxTranscriptTarget(target, sessionIdValue);
  const toolId = readAskToolId(toolIdValue);
  const history = await sessionsService.fetchHistory(sessionId, { limit: 500, offset: 0 });
  const pending = findPendingTmuxAsk(history.messages, toolId);
  if (!pending) {
    throw new AppError('The selected transcript question is no longer pending.', {
      code: 'TMUX_ASK_PROMPT_STALE',
      statusCode: 409,
    });
  }
  return pending;
}

function assertTmuxTranscriptTarget(
  target: VerifiedTmuxActionTarget,
  sessionIdValue: unknown,
): string {
  const sessionId = parseSessionId(sessionIdValue);
  const session = sessionsDb.getSessionById(sessionId);
  if (
    !session
    || session.provider !== target.kind
    || !target.providerSessionId
    || session.provider_session_id !== target.providerSessionId
  ) {
    throw new AppError('The transcript no longer belongs to this tmux agent.', {
      code: 'TMUX_ASK_SESSION_MISMATCH',
      statusCode: 409,
    });
  }
  return sessionId;
}

function readApprovalDecision(value: unknown): TmuxApprovalDecision {
  if (
    value !== 'approve-once'
    && value !== 'approve-remember'
    && value !== 'reject'
    && value !== 'cancel'
  ) {
    throw new AppError('A valid approval decision is required.', {
      code: 'TMUX_APPROVAL_DECISION_INVALID',
      statusCode: 400,
    });
  }
  return value;
}

function readInteractivePromptId(value: unknown): string {
  const promptId = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-f0-9]{32}$/.test(promptId)) {
    throw new AppError('A valid interactive prompt id is required.', {
      code: 'TMUX_INTERACTIVE_PROMPT_ID_INVALID',
      statusCode: 400,
    });
  }
  return promptId;
}

function readInteractiveChoices(value: unknown): number[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > 32
    || value.some((choice) => !Number.isInteger(choice) || choice < 0 || choice > 32)
  ) {
    throw new AppError('choices must contain displayed choice numbers.', {
      code: 'TMUX_INTERACTIVE_CHOICE_INVALID',
      statusCode: 400,
    });
  }
  return value as number[];
}

function refreshDiscoveryForInteractiveActivity(
  req: Request,
  target: VerifiedTmuxActionTarget,
  previous: 'asking_user' | null,
): void {
  if (getCachedTmuxInteractiveActivity(target) !== previous) {
    (req.app.locals.discoveryCollector as DiscoveryCollector | undefined)?.forceRefresh();
  }
}

async function handleTmuxAskSelection(
  target: VerifiedTmuxActionTarget,
  body: { sessionId?: unknown; toolId?: unknown; optionIndex?: unknown },
) {
  const pending = await loadPendingTmuxAsk(target, body.sessionId, body.toolId);
  return answerPendingTmuxAskSelection(
    target,
    pending,
    readAskOptionIndex(body.optionIndex),
  );
}

async function handleTmuxAskCustom(
  target: VerifiedTmuxActionTarget,
  body: { sessionId?: unknown; toolId?: unknown; message?: unknown },
) {
  const message = typeof body.message === 'string' ? body.message : '';
  const pending = await loadPendingTmuxAsk(target, body.sessionId, body.toolId);
  return submitPendingTmuxAskCustomResponse(
    target,
    pending,
    message,
  );
}

function discoveryRows(req: Request, lane: DiscoveryLane): readonly DiscoveryRow[] {
  const collector = req.app.locals.discoveryCollector as DiscoveryCollector | undefined;
  return collector?.currentSnapshot().rows.filter((row) => row.lane === lane) ?? [];
}

function snapshotExternalSessions(rows: readonly DiscoveryRow[]): ExternalCliSession[] {
  return rows.map((row) => ({
    tmuxName: row.tmuxName,
    tmux: row.tmux,
    kind: row.kind as ExternalCliSession['kind'],
    providerSessionId: row.providerSessionId ?? undefined,
    cwd: row.cwd ?? undefined,
    agentPid: row.process?.pid,
    startedAtMs: row.process?.startedAtMs,
    connectionIssue: row.connectionIssue,
  }));
}

function snapshotLiveSessions(rows: readonly DiscoveryRow[]): LiveGjcSession[] {
  return rows.flatMap((row) => (
    row.providerSessionId === null ? [] : [{
      id: row.providerSessionId,
      tmuxName: row.tmuxName,
      tmux: row.tmux,
      process: row.process,
      claim: 'lineage' as const,
      kind: null,
      model: null,
      effort: null,
      connectionIssue: row.connectionIssue,
      running: row.activity === 'running',
      error: row.activity === 'error',
    }]
  ));
}

function snapshotPresence(rows: readonly DiscoveryRow[]): Map<string, DiscoveryRow['presence']> {
  return new Map(rows.map((row) => [
    `${row.tmux.socketPath}\0${row.tmux.sessionId}\0${row.tmux.windowId}\0${row.tmux.paneId}`,
    row.presence,
  ]));
}

function rowPresence(
  presence: ReadonlyMap<string, DiscoveryRow['presence']>,
  tmux: { socketPath: string; sessionId: string; windowId: string; paneId: string },
): DiscoveryRow['presence'] {
  return presence.get(`${tmux.socketPath}\0${tmux.sessionId}\0${tmux.windowId}\0${tmux.paneId}`) ?? 'present';
}


async function assertTerminationAllowed(
  target: VerifiedTmuxActionTarget,
  mode: TmuxTerminationMode,
): Promise<void> {
  const tmux = target.tmux;
  if ((target.tmuxName ?? '').toLowerCase().startsWith('company')) {
    throw new AppError('This tmux target is protected.', {
      code: 'EXTERNAL_CLI_SESSION_PROTECTED',
      statusCode: 403,
    });
  }
  const current = await getCurrentTmuxPaneIdentityState();
  if (
    current.state === 'unavailable'
    || (
      current.state === 'hosted'
      && current.tmux.socketPath === tmux.socketPath
      && (
        (mode === 'session' && current.tmux.sessionId === tmux.sessionId)
        || ((mode === 'process' || mode === 'pane') && current.tmux.paneId === tmux.paneId)
      )
    )
  ) {
    throw new AppError('The tmux target hosting ChatMux is protected.', {
      code: 'EXTERNAL_CLI_SESSION_PROTECTED',
      statusCode: 403,
    });
  }
}

const readPathParam = (value: unknown, name: string): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  throw new AppError(`${name} path parameter is invalid.`, {
    code: 'INVALID_PATH_PARAMETER',
    statusCode: 400,
  });
};

const normalizeProviderParam = (value: unknown): string =>
  readPathParam(value, 'provider').trim().toLowerCase();

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

const parseSessionId = (value: unknown): string => {
  const sessionId = readPathParam(value, 'sessionId').trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AppError('Invalid sessionId.', {
      code: 'INVALID_SESSION_ID',
      statusCode: 400,
    });
  }

  return sessionId;
};

const readOptionalQueryString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const parseOptionalBooleanQuery = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new AppError(`${name} must be "true" or "false".`, {
    code: 'INVALID_QUERY_PARAMETER',
    statusCode: 400,
  });
};

const parseMcpScope = (value: unknown): McpScope | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'user' || normalized === 'local' || normalized === 'project') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP scope "${normalized}".`, {
    code: 'INVALID_MCP_SCOPE',
    statusCode: 400,
  });
};

const parseMcpTransport = (value: unknown): McpTransport => {
  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    throw new AppError('transport is required.', {
      code: 'MCP_TRANSPORT_REQUIRED',
      statusCode: 400,
    });
  }

  if (normalized === 'stdio' || normalized === 'http' || normalized === 'sse') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP transport "${normalized}".`, {
    code: 'INVALID_MCP_TRANSPORT',
    statusCode: 400,
  });
};

const parseMcpUpsertPayload = (payload: unknown): UpsertProviderMcpServerInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const name = readOptionalQueryString(body.name);
  if (!name) {
    throw new AppError('name is required.', {
      code: 'MCP_NAME_REQUIRED',
      statusCode: 400,
    });
  }

  const transport = parseMcpTransport(body.transport);
  const scope = parseMcpScope(body.scope);
  const workspacePath = readOptionalQueryString(body.workspacePath);

  return {
    name,
    transport,
    scope,
    workspacePath,
    command: readOptionalQueryString(body.command),
    args: Array.isArray(body.args) ? body.args.filter((entry): entry is string => typeof entry === 'string') : undefined,
    env: typeof body.env === 'object' && body.env !== null
      ? Object.fromEntries(
        Object.entries(body.env as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    cwd: readOptionalQueryString(body.cwd),
    url: readOptionalQueryString(body.url),
    headers: typeof body.headers === 'object' && body.headers !== null
      ? Object.fromEntries(
        Object.entries(body.headers as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    envVars: Array.isArray(body.envVars)
      ? body.envVars.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
    bearerTokenEnvVar: readOptionalQueryString(body.bearerTokenEnvVar),
    envHttpHeaders: typeof body.envHttpHeaders === 'object' && body.envHttpHeaders !== null
      ? Object.fromEntries(
        Object.entries(body.envHttpHeaders as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
  };
};

const parseProviderSkillCreatePayload = (payload: unknown): ProviderSkillCreateInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const rawEntries = Array.isArray(body.entries)
    ? body.entries
    : typeof body.content === 'string'
      ? [{
          content: body.content,
          directoryName: body.directoryName,
          fileName: body.fileName,
          files: body.files,
        }]
      : null;

  if (!rawEntries || rawEntries.length === 0) {
    throw new AppError('At least one skill entry is required.', {
      code: 'PROVIDER_SKILLS_REQUIRED',
      statusCode: 400,
    });
  }

  const entries = rawEntries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new AppError(`Skill entry ${index + 1} must be an object.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }

    const record = entry as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content : '';
    const directoryName = readOptionalQueryString(record.directoryName);
    const fileName = readOptionalQueryString(record.fileName);
    const rawFiles = record.files;

    if (!content.trim()) {
      throw new AppError(`Skill entry ${index + 1} must include markdown content.`, {
        code: 'PROVIDER_SKILL_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }

    if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
      throw new AppError(`Skill entry ${index + 1} files must be an array.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }

    const files: ProviderSkillCreateFile[] | undefined = rawFiles?.map((file, fileIndex) => {
      if (!file || typeof file !== 'object') {
        throw new AppError(`Skill entry ${index + 1} file ${fileIndex + 1} must be an object.`, {
          code: 'INVALID_REQUEST_BODY',
          statusCode: 400,
        });
      }

      const fileRecord = file as Record<string, unknown>;
      const relativePath = readOptionalQueryString(fileRecord.relativePath);
      const fileContent = typeof fileRecord.content === 'string' ? fileRecord.content : null;
      const encoding = fileRecord.encoding === 'utf8' || fileRecord.encoding === 'base64'
        ? fileRecord.encoding
        : null;

      if (!relativePath || fileContent === null || !encoding) {
        throw new AppError(
          `Skill entry ${index + 1} file ${fileIndex + 1} requires relativePath, content, and encoding.`,
          {
            code: 'INVALID_REQUEST_BODY',
            statusCode: 400,
          },
        );
      }

      return {
        relativePath,
        content: fileContent,
        encoding,
      };
    });

    return {
      content,
      directoryName,
      fileName,
      files,
    };
  });

  return { entries };
};

const parseProvider = (value: unknown): LLMProvider => {
  const normalized = normalizeProviderParam(value);
  if (
    normalized === 'claude'
    || normalized === 'codex'
    || normalized === 'cursor'
    || normalized === 'opencode'
    || normalized === 'gjc'
    || normalized === 'omp'
    || normalized === 'omo'
  ) {
    return normalized;
  }

  throw new AppError(`Unsupported provider "${normalized}".`, {
    code: 'UNSUPPORTED_PROVIDER',
    statusCode: 400,
  });
};

const parseSessionRenameSummary = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  if (!summary) {
    throw new AppError('Summary is required.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  if (summary.length > 500) {
    throw new AppError('Summary must not exceed 500 characters.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  return summary;
};

const parseSessionSearchQuery = (value: unknown): string => {
  const query = readOptionalQueryString(value) ?? '';
  if (query.length < 2) {
    throw new AppError('Query must be at least 2 characters', {
      code: 'INVALID_SEARCH_QUERY',
      statusCode: 400,
    });
  }

  return query;
};

const parseSessionSearchLimit = (value: unknown): number => {
  const raw = readOptionalQueryString(value);
  if (!raw) {
    return 50;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new AppError('limit must be a valid integer.', {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return Math.max(1, Math.min(parsed, 100));
};

const parseChangeActiveModelPayload = (payload: unknown): ProviderChangeActiveModelInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const model = readOptionalQueryString(body.model);
  if (!model) {
    throw new AppError('model is required.', {
      code: 'MODEL_REQUIRED',
      statusCode: 400,
    });
  }

  return {
    sessionId: '',
    model,
  };
};

router.get(
  '/:provider/auth/status',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const status = await providerAuthService.getProviderAuthStatus(provider);
    res.json(createApiSuccessResponse(status));
  }),
);

router.get(
  '/:provider/models',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const bypassCache = parseOptionalBooleanQuery(req.query.bypassCache, 'bypassCache') ?? false;
    const result = await providerModelsService.getProviderModels(provider, { bypassCache });
    res.json(createApiSuccessResponse({ provider, models: result.models, cache: result.cache }));
  }),
);

router.post(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const payload = parseChangeActiveModelPayload(req.body);
    const result = await providerModelsService.changeActiveModel(provider, {
      ...payload,
      sessionId,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

// ----------------- Skills routes -----------------
router.get(
  '/:provider/skills',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    const skills = await providerSkillsService.listProviderSkills(provider, { workspacePath });
    res.json(createApiSuccessResponse({ provider, skills }));
  }),
);

router.post(
  '/:provider/skills',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const input = parseProviderSkillCreatePayload(req.body);
    const skills = await providerSkillsService.addProviderSkills(provider, input);
    res.json(createApiSuccessResponse({ provider, skills }));
  }),
);

router.delete(
  '/:provider/skills/:directoryName',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const result = await providerSkillsService.removeProviderSkill(provider, {
      directoryName: readPathParam(req.params.directoryName, 'directoryName'),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

// ----------------- MCP routes -----------------
router.get(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    const scope = parseMcpScope(req.query.scope);

    if (scope) {
      const servers = await providerMcpService.listProviderMcpServersForScope(provider, scope, { workspacePath });
      res.json(createApiSuccessResponse({ provider, scope, servers }));
      return;
    }

    const groupedServers = await providerMcpService.listProviderMcpServers(provider, { workspacePath });
    res.json(createApiSuccessResponse({ provider, scopes: groupedServers }));
  }),
);

router.post(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const payload = parseMcpUpsertPayload(req.body);
    const server = await providerMcpService.upsertProviderMcpServer(provider, payload);
    res.status(201).json(createApiSuccessResponse({ server }));
  }),
);

router.delete(
  '/:provider/mcp/servers/:name',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const scope = parseMcpScope(req.query.scope);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    const result = await providerMcpService.removeProviderMcpServer(provider, {
      name: readPathParam(req.params.name, 'name'),
      scope,
      workspacePath,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/mcp/servers/global',
  asyncHandler(async (req: Request, res: Response) => {
    const payload = parseMcpUpsertPayload(req.body);
    if (payload.scope === 'local') {
      throw new AppError('Global MCP add supports only "user" or "project" scopes.', {
        code: 'INVALID_GLOBAL_MCP_SCOPE',
        statusCode: 400,
      });
    }

    const results = await providerMcpService.addMcpServerToAllProviders({
      ...payload,
      scope: payload.scope === 'user' ? 'user' : 'project',
    });
    res.status(201).json(createApiSuccessResponse({ results }));
  }),
);

router.get(
  '/capabilities',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse({
      providers: providerCapabilitiesService.listAllProviderCapabilities(),
    }));
  }),
);

router.get(
  '/:provider/capabilities',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    res.json(createApiSuccessResponse(
      providerCapabilitiesService.getProviderCapabilities(provider),
    ));
  }),
);

// ----------------- Session routes -----------------
/**
 * Session gateway entry point: allocates the stable app-facing session id for
 * a brand-new chat. The frontend must call this before the first `chat.send`
 * so the session id in the URL, the store, and the websocket all agree from
 * the very first message — there is no client-visible session-id handoff.
 */
router.post(
  '/sessions',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = parseProvider(body.provider);
    const projectPath = typeof body.projectPath === 'string' ? body.projectPath : '';
    const result = await sessionsService.createAppSession(provider, projectPath);
    res.status(201).json(createApiSuccessResponse(result));
  }),
);

router.get(
  '/sessions/running',
  asyncHandler(async (_req: Request, res: Response) => {
    const sessions = sessionsService.listRunningSessions();
    res.json(createApiSuccessResponse({ sessions }));
  }),
);


router.get(
  '/sessions/live',
  asyncHandler(async (_req: Request, res: Response) => {
    // Sessions live in exact tmux panes. Fresh GJC panes without transcripts
    // appear as synthetic idle rows until the first message is indexed.
    const result = await getLiveGjcSessionsDetailed();
    const snapshotRows = result.ok ? [] : discoveryRows(_req, 'live');
    const presence = snapshotPresence(snapshotRows);
    const liveSessions = (result.ok ? result.sessions : snapshotLiveSessions(snapshotRows)).map((session) => ({
      ...session,
      presence: session.tmux === null
        ? 'present'
        : rowPresence(presence, session.tmux),
    }));
    res.json(createApiSuccessResponse({ liveSessions, discovery: { ok: result.ok } }));
  }),
);

router.get(
  '/sessions/external',
  asyncHandler(async (req: Request, res: Response) => {
    // Coding-agent panes open structured transcripts when a native session id
    // is available, with terminal attach as the fallback. GJC stays in the
    // dedicated live lane; SSH and unclassified shell panes are attach-only.
    const result = await getExternalCliSessionsDetailed();
    const snapshotRows = result.ok ? [] : discoveryRows(req, 'external');
    const presence = snapshotPresence(snapshotRows);
    const sessions = result.ok ? result.sessions : snapshotExternalSessions(snapshotRows);
    const externalSessions = await Promise.all(sessions.map(async (session) => {
      const base = {
        tmuxName: session.tmuxName,
        tmux: session.tmux,
        process: externalProcessGeneration(session),
        kind: session.kind,
        presence: rowPresence(presence, session.tmux),
        connectionIssue: session.connectionIssue,
      };
      if (session.kind === 'ssh' || session.kind === 'shell') {
        const attachCapability = await attachCapabilityService.issue(
          String((req as typeof req & { user?: { id?: string | number } }).user?.id),
          session.tmux,
        ).catch(() => null);
        return attachCapability ? { ...base, attachCapability } : base;
      }

      const projectPath = session.cwd;
      const resolution = await resolveExternalSessionActivity(session);
      const interactiveActivity = base.process
        ? getCachedTmuxInteractiveActivity({ tmux: session.tmux, process: base.process })
        : null;
      const appSession = resolution.appSession;
      const activeModel = appSession
        ? await providerModelsService
          .getCurrentActiveModel(session.kind, appSession.session_id)
          .catch(() => null)
        : session.kind === 'claude'
          ? await providerModelsService.getCurrentActiveModel('claude').catch(() => null)
          : null;

      return {
        ...base,
        projectPath: appSession?.project_path ?? projectPath,
        ...(appSession
          ? {
            transcriptSessionId: appSession.session_id,
            sessionName: appSession.custom_name,
          }
          : {}),
        model: activeModel?.model ?? null,
        effort: activeModel?.effort ?? null,
        activity: interactiveActivity ?? toExternalSessionDisplayActivity(resolution),
        ...(appSession ? { transcriptEnded: resolution.transcriptEnded } : {}),
      };
    }));
    res.json(createApiSuccessResponse({ externalSessions, discovery: { ok: result.ok } }));
  }),
);

router.post(
  '/sessions/external/output',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { tmux?: unknown; process?: unknown };
    const target = await assertFreshExternalTmuxTarget(body.tmux, body.process);
    const output = normalizeExternalPaneOutput(await captureTmuxPane(target));
    res.json(createApiSuccessResponse({ output }));
  }),
);

router.post(
  '/sessions/external/spawn',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { name?: unknown; cwd?: unknown; cli?: unknown };
    if (!isValidSpawnName(body.name)) {
      throw new AppError('A valid session name is required (alphanumeric, not "company").', {
        code: 'INVALID_SPAWN_NAME',
        statusCode: 400,
      });
    }
    const supportedClis: ExternalSpawnCli[] = ['claude', 'codex', 'cursor', 'opencode', 'omp', 'omo'];
    if (body.cli !== undefined && !supportedClis.includes(body.cli as ExternalSpawnCli)) {
      throw new AppError(`cli must be one of: ${supportedClis.join(', ')}.`, {
        code: 'INVALID_CLI',
        statusCode: 400,
      });
    }
    const cli: ExternalSpawnCli = body.cli === undefined
      ? 'codex'
      : body.cli as ExternalSpawnCli;
    const cwdInput = typeof body.cwd === 'string' ? body.cwd.trim() : '';
    if (!cwdInput) {
      throw new AppError('cwd is required.', { code: 'EMPTY_CWD', statusCode: 400 });
    }
    const cwd = await resolveExternalCliCwd(cwdInput);
    if (!cwd) {
      throw new AppError('cwd must be an existing directory under HOME.', {
        code: 'INVALID_CWD',
        statusCode: 400,
      });
    }
    try {
      await spawnExternalCliSession(cli, body.name, cwd);
    } catch {
      throw new AppError('The external CLI session could not be created; the tmux name may already exist.', {
        code: 'EXTERNAL_CLI_SPAWN_FAILED',
        statusCode: 409,
      });
    }
    (req.app.locals.discoveryCollector as DiscoveryCollector | undefined)?.forceRefresh();
    res.status(201).json(createApiSuccessResponse({ ok: true, tmuxName: body.name, cwd, cli }));
  }),
);

router.post(
  '/sessions/external/kill',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      tmux?: unknown;
      process?: unknown;
      mode?: unknown;
      confirmOtherPanes?: unknown;
    };
    const mode = readTerminationMode(body.mode);
    const target = await assertFreshExternalTmuxTarget(body.tmux, body.process);
    await assertTerminationAllowed(target, mode);
    if (mode === 'process') {
      await stopAgentProcessInPane(target);
    } else if (mode === 'pane') {
      await killTmuxPane(target);
    } else {
      await killTmuxSession(target, undefined, { allowOtherPanes: body.confirmOtherPanes === true });
    }
    res.json(createApiSuccessResponse({ ok: true, mode }));
  }),
);

router.post(
  '/sessions/external/send',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      tmux?: unknown;
      process?: unknown;
      message?: unknown;
    };
    const message = typeof body.message === 'string' ? body.message : '';
    if (!message.trim()) {
      throw new AppError('message is required.', { code: 'EMPTY_MESSAGE', statusCode: 400 });
    }
    const target = await assertFreshExternalTmuxTarget(body.tmux, body.process);
    await sendToTmuxPane(target, message);
    res.json(createApiSuccessResponse({ ok: true }));
  }),
);
router.post(
  '/sessions/external/interactive',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { tmux?: unknown; process?: unknown };
    const target = await assertFreshExternalTmuxTarget(body.tmux, body.process);
    const previousActivity = getCachedTmuxInteractiveActivity(target);
    const prompt = await getTmuxInteractivePrompt(target);
    refreshDiscoveryForInteractiveActivity(req, target, previousActivity);
    res.json(createApiSuccessResponse({ prompt }));
  }),
);
router.post(
  '/sessions/external/interactive/respond',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      tmux?: unknown;
      process?: unknown;
      promptId?: unknown;
      choices?: unknown;
    };
    const target = await assertFreshExternalTmuxTarget(body.tmux, body.process);
    const previousActivity = getCachedTmuxInteractiveActivity(target);
    const result = await answerTmuxInteractivePrompt(
      target,
      readInteractivePromptId(body.promptId),
      readInteractiveChoices(body.choices),
    );
    refreshDiscoveryForInteractiveActivity(req, target, previousActivity);
    res.json(createApiSuccessResponse({ ok: true, ...result }));
  }),
);
router.post(
  '/sessions/external/interactive/custom',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      tmux?: unknown;
      process?: unknown;
      promptId?: unknown;
      message?: unknown;
    };
    const target = await assertFreshExternalTmuxTarget(body.tmux, body.process);
    const previousActivity = getCachedTmuxInteractiveActivity(target);
    await submitTmuxInteractiveCustomResponse(
      target,
      readInteractivePromptId(body.promptId),
      typeof body.message === 'string' ? body.message : '',
    );
    refreshDiscoveryForInteractiveActivity(req, target, previousActivity);
    res.json(createApiSuccessResponse({ ok: true }));
  }),
);
router.post(
  '/sessions/external/ask',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      tmux?: unknown;
      process?: unknown;
      sessionId?: unknown;
      toolId?: unknown;
      optionIndex?: unknown;
    };
    const target = await assertFreshExternalTmuxTarget(body.tmux, body.process);
    const result = await handleTmuxAskSelection(target, body);
    res.json(createApiSuccessResponse({ ok: true, ...result }));
  }),
);
router.post(
  '/sessions/external/ask/custom',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      tmux?: unknown;
      process?: unknown;
      sessionId?: unknown;
      toolId?: unknown;
      message?: unknown;
    };
    const target = await assertFreshExternalTmuxTarget(body.tmux, body.process);
    const result = await handleTmuxAskCustom(target, body);
    res.json(createApiSuccessResponse({ ok: true, ...result }));
  }),
);
router.post(
  '/sessions/external/approval',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      tmux?: unknown;
      process?: unknown;
      sessionId?: unknown;
    };
    const target = await assertFreshExternalTmuxTarget(body.tmux, body.process);
    assertTmuxTranscriptTarget(target, body.sessionId);
    const approval = await getTmuxApprovalPrompt(target);
    res.json(createApiSuccessResponse({ approval }));
  }),
);
router.post(
  '/sessions/external/approval/respond',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      tmux?: unknown;
      process?: unknown;
      sessionId?: unknown;
      decision?: unknown;
    };
    const target = await assertFreshExternalTmuxTarget(body.tmux, body.process);
    assertTmuxTranscriptTarget(target, body.sessionId);
    await answerTmuxApproval(target, readApprovalDecision(body.decision));
    res.json(createApiSuccessResponse({ ok: true }));
  }),
);
router.post(
  '/sessions/external/actions',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { tmux?: unknown; process?: unknown; action?: unknown };
    const action = readTmuxProcessAction(body.action);
    try {
      const target = await assertFreshExternalTmuxTarget(body.tmux, body.process);
      // Process actions share the pane-level self/company protection boundary:
      // an interrupt is non-destructive, but must not be misdirected to those targets.
      await assertTerminationAllowed(target, 'pane');
      await sendTmuxProcessAction(target, action);
      emitRelayKeyDiagnostic('relay_key_sent', target.kind);
    } catch (error) {
      if (
        error instanceof AppError
        && (error.code === 'TMUX_PROCESS_GENERATION_MISMATCH' || error.code === 'TMUX_PANE_GENERATION_MISMATCH')
      ) {
        emitRelayKeyDiagnostic('relay_key_refused_generation', 'external');
      }
      throw error;
    }
    res.json(createApiSuccessResponse({ ok: true }));
  }),
);


router.get(
  '/fs/dir-suggestions',
  asyncHandler(async (req: Request, res: Response) => {
    // Home-relative directory autocomplete (spawn form cwd + files panel root).
    // Read-only readdir under $HOME, traversal-guarded in the service.
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
    const suggestions = await getHomeDirSuggestions(prefix);
    res.json(createApiSuccessResponse({ home: getHomeDir(), suggestions }));
  }),
);

router.post(
  '/sessions/live/output',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { tmux?: unknown; process?: unknown };
    const tmux = readTmuxPaneIdentity(body.tmux);
    const processGeneration = readTmuxProcessGeneration(body.process);
    const target = await assertLineageTmuxTarget(tmux, processGeneration);
    const output = normalizeExternalPaneOutput(await captureTmuxPane(target));
    res.json(createApiSuccessResponse({ output }));
  }),
);

router.post(
  '/sessions/live/send',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { tmux?: unknown; process?: unknown; message?: unknown };
    const tmux = readTmuxPaneIdentity(body.tmux);
    const processGeneration = readTmuxProcessGeneration(body.process);
    const message = typeof body.message === 'string' ? body.message : '';
    if (!message.trim()) {
      throw new AppError('message is required.', { code: 'EMPTY_MESSAGE', statusCode: 400 });
    }
    const target = await assertLineageTmuxTarget(tmux, processGeneration);
    await sendToTmuxPane(target, message);
    res.json(createApiSuccessResponse({
      ok: true,
      reachable: true,
      queued: false,
      detail: `Delivered to ${tmux.paneId}`,
    }));
  }),
);
router.post(
  '/sessions/live/interactive',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { tmux?: unknown; process?: unknown };
    const tmux = readTmuxPaneIdentity(body.tmux);
    const processGeneration = readTmuxProcessGeneration(body.process);
    const target = await assertLineageTmuxTarget(tmux, processGeneration);
    const previousActivity = getCachedTmuxInteractiveActivity(target);
    const prompt = await getTmuxInteractivePrompt(target);
    refreshDiscoveryForInteractiveActivity(req, target, previousActivity);
    res.json(createApiSuccessResponse({ prompt }));
  }),
);
router.post(
  '/sessions/live/interactive/respond',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      tmux?: unknown;
      process?: unknown;
      promptId?: unknown;
      choices?: unknown;
    };
    const tmux = readTmuxPaneIdentity(body.tmux);
    const processGeneration = readTmuxProcessGeneration(body.process);
    const target = await assertLineageTmuxTarget(tmux, processGeneration);
    const previousActivity = getCachedTmuxInteractiveActivity(target);
    const result = await answerTmuxInteractivePrompt(
      target,
      readInteractivePromptId(body.promptId),
      readInteractiveChoices(body.choices),
    );
    refreshDiscoveryForInteractiveActivity(req, target, previousActivity);
    res.json(createApiSuccessResponse({ ok: true, ...result }));
  }),
);
router.post(
  '/sessions/live/interactive/custom',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      tmux?: unknown;
      process?: unknown;
      promptId?: unknown;
      message?: unknown;
    };
    const tmux = readTmuxPaneIdentity(body.tmux);
    const processGeneration = readTmuxProcessGeneration(body.process);
    const target = await assertLineageTmuxTarget(tmux, processGeneration);
    const previousActivity = getCachedTmuxInteractiveActivity(target);
    await submitTmuxInteractiveCustomResponse(
      target,
      readInteractivePromptId(body.promptId),
      typeof body.message === 'string' ? body.message : '',
    );
    refreshDiscoveryForInteractiveActivity(req, target, previousActivity);
    res.json(createApiSuccessResponse({ ok: true }));
  }),
);
router.post(
  '/sessions/live/ask',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      tmux?: unknown;
      process?: unknown;
      sessionId?: unknown;
      toolId?: unknown;
      optionIndex?: unknown;
    };
    const tmux = readTmuxPaneIdentity(body.tmux);
    const processGeneration = readTmuxProcessGeneration(body.process);
    const target = await assertLineageTmuxTarget(tmux, processGeneration);
    const result = await handleTmuxAskSelection(target, body);
    res.json(createApiSuccessResponse({ ok: true, ...result }));
  }),
);
router.post(
  '/sessions/live/ask/custom',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      tmux?: unknown;
      process?: unknown;
      sessionId?: unknown;
      toolId?: unknown;
      message?: unknown;
    };
    const tmux = readTmuxPaneIdentity(body.tmux);
    const processGeneration = readTmuxProcessGeneration(body.process);
    const target = await assertLineageTmuxTarget(tmux, processGeneration);
    const result = await handleTmuxAskCustom(target, body);
    res.json(createApiSuccessResponse({ ok: true, ...result }));
  }),
);
router.post(
  '/sessions/live/actions',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { tmux?: unknown; process?: unknown; action?: unknown };
    const action = readTmuxProcessAction(body.action);
    const tmux = readTmuxPaneIdentity(body.tmux);
    const processGeneration = readTmuxProcessGeneration(body.process);
    try {
      const target = await assertLineageTmuxTarget(tmux, processGeneration);
      // Keep the same pane-level protection as termination for all control keys.
      await assertTerminationAllowed(target, 'pane');
      await sendTmuxProcessAction(target, action);
      emitRelayKeyDiagnostic('relay_key_sent', target.kind);
    } catch (error) {
      if (error instanceof AppError) {
        if (error.code === 'TMUX_ACTION_NOT_LINEAGE') {
          emitRelayKeyDiagnostic('relay_key_refused_lineage', 'gjc');
        } else if (
          error.code === 'TMUX_PROCESS_GENERATION_MISMATCH'
          || error.code === 'TMUX_PANE_GENERATION_MISMATCH'
        ) {
          emitRelayKeyDiagnostic('relay_key_refused_generation', 'gjc');
        }
      }
      throw error;
    }
    res.json(createApiSuccessResponse({
      ok: true,
      reachable: true,
      queued: false,
      detail: `Delivered to ${tmux.paneId}`,
    }));
  }),
);

router.post(
  '/sessions/live/spawn',
  asyncHandler(async (req: Request, res: Response) => {
    // Spawn a new tmux gjc session via the control tower's /spawn (name + cwd).
    const body = (req.body ?? {}) as { name?: unknown; cwd?: unknown };
    if (!isValidSpawnName(body.name)) {
      throw new AppError('A valid session name is required (alphanumeric, not "company").', { code: 'INVALID_SPAWN_NAME', statusCode: 400 });
    }
    const cwdInput = typeof body.cwd === 'string' ? body.cwd.trim() : '';
    if (!cwdInput) {
      throw new AppError('cwd is required.', { code: 'EMPTY_CWD', statusCode: 400 });
    }
    const cwd = await resolveExternalCliCwd(cwdInput);
    if (!cwd) {
      throw new AppError('cwd must be an existing directory under HOME.', {
        code: 'INVALID_CWD',
        statusCode: 400,
      });
    }
    const result = await spawnLiveSession(body.name, cwd);
    if (result.ok) {
      (req.app.locals.discoveryCollector as DiscoveryCollector | undefined)?.forceRefresh();
    }
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/live/kill',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      tmux?: unknown;
      process?: unknown;
      mode?: unknown;
      confirmOtherPanes?: unknown;
    };
    const tmux = readTmuxPaneIdentity(body.tmux);
    const processGeneration = readTmuxProcessGeneration(body.process);
    const mode = readTerminationMode(body.mode);
    const target = await assertLineageTmuxTarget(tmux, processGeneration);
    await assertTerminationAllowed(target, mode);
    if (mode === 'process') {
      await stopAgentProcessInPane(target);
    } else if (mode === 'pane') {
      await killTmuxPane(target);
    } else {
      await killTmuxSession(target, undefined, { allowOtherPanes: body.confirmOtherPanes === true });
    }
    res.json(createApiSuccessResponse({ ok: true, mode }));
  }),
);

router.get(
  '/sessions/live/commands',
  asyncHandler(async (req: Request, res: Response) => {
    // Slash commands a live tmux gjc session can execute — native
    // (`~/.gjc/agent/commands`), project (`<workspace>/.gjc/commands`), and
    // installed skills. Read-only; powers the live relay composer's palette.
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    const commands = await listLiveGjcCommands(workspacePath);
    res.json(createApiSuccessResponse({ commands }));
  }),
);

router.get(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    const project = session.project_path
      ? projectsDb.getProjectPath(session.project_path)
      : null;
    res.json(createApiSuccessResponse({
      session: {
        sessionId: session.session_id,
        provider: session.provider,
        summary: session.custom_name ?? '',
        projectId: project?.project_id ?? null,
        projectPath: session.project_path,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
      },
    }));
  }),
);

router.delete(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = await sessionsService.deleteSessionById(sessionId);
    res.json(createApiSuccessResponse(result));
  }),
);

router.put(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const summary = parseSessionRenameSummary(req.body);
    const result = sessionsService.renameSessionById(sessionId, summary);
    res.json(createApiSuccessResponse(result));
  }),
);

router.get(
  '/sessions/:sessionId/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const limitRaw = readOptionalQueryString(req.query.limit);
    const offsetRaw = readOptionalQueryString(req.query.offset);
    const includeImages = parseOptionalBooleanQuery(req.query.includeImages, 'includeImages');

    let limit: number | null = null;
    if (limitRaw !== undefined) {
      const parsedLimit = Number.parseInt(limitRaw, 10);
      if (Number.isNaN(parsedLimit) || parsedLimit < 0) {
        throw new AppError('limit must be a non-negative integer.', {
          code: 'INVALID_QUERY_PARAMETER',
          statusCode: 400,
        });
      }
      limit = parsedLimit;
    }

    let offset = 0;
    if (offsetRaw !== undefined) {
      const parsedOffset = Number.parseInt(offsetRaw, 10);
      if (Number.isNaN(parsedOffset) || parsedOffset < 0) {
        throw new AppError('offset must be a non-negative integer.', {
          code: 'INVALID_QUERY_PARAMETER',
          statusCode: 400,
        });
      }
      offset = parsedOffset;
    }

    const result = await sessionsService.fetchHistory(sessionId, {
      limit,
      offset,
      includeImages,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.get(
  '/sessions/:sessionId/tool-result',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const toolId = readAskToolId(req.query.toolId);
    const result = await sessionsService.fetchToolResult(sessionId, toolId);
    res.json(createApiSuccessResponse(result));
  }),
);

router.get('/search/sessions', asyncHandler(async (req: Request, res: Response) => {
  const query = parseSessionSearchQuery(req.query.q);
  const limit = parseSessionSearchLimit(req.query.limit);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const abortController = new AbortController();
  req.on('close', () => {
    closed = true;
    abortController.abort();
  });

  try {
    await sessionConversationsSearchService.search({
      query,
      limit,
      signal: abortController.signal,
      onProgress: ({ projectResult, totalMatches, scannedProjects, totalProjects }) => {
        if (closed) {
          return;
        }

        if (projectResult) {
          res.write(`event: result\ndata: ${JSON.stringify({ projectResult, totalMatches, scannedProjects, totalProjects })}\n\n`);
          return;
        }

        res.write(`event: progress\ndata: ${JSON.stringify({ totalMatches, scannedProjects, totalProjects })}\n\n`);
      },
    });

    if (!closed) {
      res.write('event: done\ndata: {}\n\n');
    }
  } catch (error) {
    console.error('Error searching conversations:', error);
    if (!closed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Search failed' })}\n\n`);
    }
  } finally {
    if (!closed) {
      res.end();
    }
  }
}));

export default router;
