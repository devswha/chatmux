import express, { type Request, type Response } from 'express';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { sessionConversationsSearchService } from '@/modules/providers/services/session-conversations-search.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { getLiveGjcSessions, IDLE_GJC_ID_PREFIX } from '@/modules/providers/services/live-sessions.service.js';
import {
  captureExternalCliSessionOutput,
  getCurrentTmuxSessionName,
  getExternalCliSessions,
  killExternalCliSession,
  resolveCodexRolloutPath,
  resolveExternalCliCwd,
  sendToExternalCliSession,
  spawnExternalCliSession,
  type ExternalSpawnCli,
} from '@/modules/providers/services/external-cli-sessions.service.js';
import { readExternalSessionActivity } from '@/modules/providers/services/external-session-activity.service.js';
import { getHomeDir, getHomeDirSuggestions } from '@/modules/providers/services/home-dirs.service.js';
import { isValidTmuxName, sendToLiveSession, isValidSpawnName, spawnLiveSession, killLiveSession } from '@/modules/providers/services/live-send.service.js';
import { listLiveGjcCommands } from '@/modules/providers/services/live-commands.service.js';
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

const router = express.Router();

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
    const result = sessionsService.createAppSession(provider, projectPath);
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
  '/sessions/archived',
  asyncHandler(async (_req: Request, res: Response) => {
    const sessions = sessionsService.listArchivedSessions();
    res.json(createApiSuccessResponse({ sessions }));
  }),
);

router.get(
  '/sessions/live',
  asyncHandler(async (_req: Request, res: Response) => {
    // Sessions live in a tmux gjc pane, each with its tmux session name (tmux+lsof;
    // empty if no tmux). gjc panes with no transcript yet (first message pending)
    // appear as synthetic `idle-gjc:<tmux name>` rows. liveSessionIds kept for
    // backward compatibility.
    const liveSessions = await getLiveGjcSessions();
    res.json(createApiSuccessResponse({
      liveSessions,
      // Legacy consumers treat these as transcript-backed session ids — keep
      // synthetic idle-gjc rows out of this surface.
      liveSessionIds: liveSessions
        .filter((session) => !session.id.startsWith(IDLE_GJC_ID_PREFIX))
        .map((session) => session.id),
    }));
  }),
);

router.get(
  '/sessions/external',
  asyncHandler(async (_req: Request, res: Response) => {
    // Local coding-agent tmux sessions open structured transcripts when a
    // native session id is available, with terminal attach as the fallback.
    // GJC panes stay in the dedicated live lane; SSH is always attach-only.
    const externalSessions = await Promise.all((await getExternalCliSessions()).map(async (session) => {
      if (session.kind === 'ssh') {
        return { tmuxName: session.tmuxName, kind: session.kind };
      }
      const projectPath = session.cwd;
      const providerSessionId = session.providerSessionId;
      if (!providerSessionId) {
        return { tmuxName: session.tmuxName, kind: session.kind, projectPath, activity: 'unknown' as const };
      }
      let appSession = sessionsDb.getSessionByProviderSessionId(session.kind, providerSessionId);
      if (!appSession && session.kind === 'codex') {
        const rolloutPath = await resolveCodexRolloutPath(providerSessionId);
        if (rolloutPath) {
          await sessionSynchronizerService.synchronizeProviderFile('codex', rolloutPath).catch(() => null);
          appSession = sessionsDb.getSessionByProviderSessionId('codex', providerSessionId);
        }
      }
      if (!appSession) {
        const activity = await readExternalSessionActivity({
          kind: session.kind,
          providerSessionId,
          jsonlPath: null,
        });
        return { tmuxName: session.tmuxName, kind: session.kind, projectPath, activity };
      }
      const [activeModel, activity] = await Promise.all([
        providerModelsService
          .getCurrentActiveModel(session.kind, appSession.session_id)
          .catch(() => null),
        readExternalSessionActivity({
          kind: session.kind,
          providerSessionId,
          jsonlPath: appSession.jsonl_path,
        }),
      ]);
      return {
        tmuxName: session.tmuxName,
        kind: session.kind,
        projectPath: appSession.project_path ?? projectPath,
        transcriptSessionId: appSession.session_id,
        sessionName: appSession.custom_name,
        model: activeModel?.model ?? null,
        activity,
      };
    }));
    res.json(createApiSuccessResponse({ externalSessions }));
  }),
);

router.get(
  '/sessions/external/output',
  asyncHandler(async (req: Request, res: Response) => {
    const tmuxName = typeof req.query.tmuxName === 'string' ? req.query.tmuxName : '';
    if (!isValidTmuxName(tmuxName)) {
      throw new AppError('A valid tmuxName is required.', { code: 'INVALID_TMUX_NAME', statusCode: 400 });
    }
    const external = (await getExternalCliSessions()).find(
      (session) => session.tmuxName === tmuxName && session.kind !== 'ssh',
    );
    if (!external) {
      throw new AppError('The selected tmux session is no longer a supported local CLI session.', {
        code: 'EXTERNAL_CLI_SESSION_MISMATCH',
        statusCode: 409,
      });
    }
    const output = await captureExternalCliSessionOutput(tmuxName);
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
    const supportedClis: ExternalSpawnCli[] = ['claude', 'codex', 'cursor', 'opencode', 'omp'];
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
    res.status(201).json(createApiSuccessResponse({ ok: true, tmuxName: body.name, cwd, cli }));
  }),
);

router.post(
  '/sessions/external/kill',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { tmuxName?: unknown };
    if (!isValidTmuxName(body.tmuxName)) {
      throw new AppError('A valid tmuxName is required.', { code: 'INVALID_TMUX_NAME', statusCode: 400 });
    }
    if (body.tmuxName === await getCurrentTmuxSessionName()) {
      throw new AppError('The tmux session hosting ChatMux is protected.', {
        code: 'EXTERNAL_CLI_SESSION_PROTECTED',
        statusCode: 403,
      });
    }
    const target = (await getExternalCliSessions()).find(
      (session) => session.tmuxName === body.tmuxName && session.kind !== 'ssh',
    );
    if (!target) {
      throw new AppError('The selected tmux session is no longer a supported local CLI session.', {
        code: 'EXTERNAL_CLI_SESSION_MISMATCH',
        statusCode: 409,
      });
    }
    try {
      await killExternalCliSession(body.tmuxName);
    } catch {
      throw new AppError('The external CLI tmux session could not be stopped.', {
        code: 'EXTERNAL_CLI_KILL_FAILED',
        statusCode: 409,
      });
    }
    res.json(createApiSuccessResponse({ ok: true }));
  }),
);

router.post(
  '/sessions/external/send',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { tmuxName?: unknown; sessionId?: unknown; message?: unknown };
    if (!isValidTmuxName(body.tmuxName)) {
      throw new AppError('A valid tmuxName is required.', { code: 'INVALID_TMUX_NAME', statusCode: 400 });
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
    const message = typeof body.message === 'string' ? body.message : '';
    if (sessionId !== null && !SESSION_ID_PATTERN.test(sessionId)) {
      throw new AppError('A valid sessionId is required.', { code: 'INVALID_SESSION_ID', statusCode: 400 });
    }
    if (!message.trim()) {
      throw new AppError('message is required.', { code: 'EMPTY_MESSAGE', statusCode: 400 });
    }

    const external = (await getExternalCliSessions()).find(
      (session) => session.tmuxName === body.tmuxName && session.kind !== 'ssh',
    );
    if (!external) {
      throw new AppError('External CLI tmux session changed; reopen it from the session list.', {
        code: 'EXTERNAL_CLI_SESSION_MISMATCH',
        statusCode: 409,
      });
    }
    const providerSessionId = external.providerSessionId;
    const mapped = sessionId && providerSessionId
      ? sessionsDb.getSessionByProviderSessionId(external.kind, providerSessionId)
      : null;
    if (sessionId && (!mapped || mapped.session_id !== sessionId)) {
      throw new AppError('External CLI tmux session changed; reopen it from the session list.', {
        code: 'EXTERNAL_CLI_SESSION_MISMATCH',
        statusCode: 409,
      });
    }

    await sendToExternalCliSession(body.tmuxName, message);
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

/**
 * Server-side lineage gate for tmux-destructive/injective actions (kill, send).
 * The client hides these controls for non-lineage rows, but a stale UI snapshot
 * or a direct authenticated request could still target a tmux session that no
 * gjc provably runs inside (실사고: patina — cwd-label row killed an unrelated
 * claude tmux). Fail-closed: transient lsof misses deny the action; retrying
 * once detection recovers is the intended UX for a destructive operation.
 *
 * `tmuxId` (`$N`, tmux server-unique) is the GENERATION token: when the client
 * sends the id it observed, a same-named session recreated after that snapshot
 * fails the match and the action is refused (이름 재사용 race 차단). The tower
 * still acts by name, so a residual window of one detection→proxy hop remains —
 * documented, and closable only by a tower-side id-addressed API.
 */
const TMUX_ID_RE = /^\$\d+$/;

async function assertLineageTmuxTarget(tmuxName: string, tmuxId: string | null): Promise<void> {
  const live = await getLiveGjcSessions();
  const matches = live.filter((session) => session.tmuxName === tmuxName && session.claim === 'lineage');
  if (matches.length === 0) {
    throw new AppError('tmux 세션에 대한 조작이 거부되었습니다 — gjc가 그 세션 안에서 실행 중임이 확인될 때만 허용됩니다.', {
      code: 'TMUX_ACTION_NOT_LINEAGE',
      statusCode: 403,
    });
  }
  if (tmuxId !== null && !matches.some((session) => session.tmuxId === tmuxId)) {
    throw new AppError('tmux 세션이 그 사이 교체되었습니다 — 같은 이름의 다른 세션입니다. 목록을 새로고침한 뒤 다시 시도하세요.', {
      code: 'TMUX_GENERATION_MISMATCH',
      statusCode: 409,
    });
  }
}

/** Optional `$N` generation token from the request body; malformed values are rejected. */
function readTmuxIdParam(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'string' && TMUX_ID_RE.test(value)) {
    return value;
  }
  throw new AppError('tmuxId must look like "$<number>".', { code: 'INVALID_TMUX_ID', statusCode: 400 });
}

router.post(
  '/sessions/live/send',
  asyncHandler(async (req: Request, res: Response) => {
    // Relay a message into a live tmux gjc session via the control tower's /send.
    const body = (req.body ?? {}) as { tmuxName?: unknown; tmuxId?: unknown; message?: unknown };
    if (!isValidTmuxName(body.tmuxName)) {
      throw new AppError('A valid tmuxName is required.', { code: 'INVALID_TMUX_NAME', statusCode: 400 });
    }
    const message = typeof body.message === 'string' ? body.message : '';
    if (!message.trim()) {
      throw new AppError('message is required.', { code: 'EMPTY_MESSAGE', statusCode: 400 });
    }
    await assertLineageTmuxTarget(body.tmuxName, readTmuxIdParam(body.tmuxId));
    const result = await sendToLiveSession(body.tmuxName, message);
    res.json(createApiSuccessResponse(result));
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
    const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : '';
    if (!cwd) {
      throw new AppError('cwd is required.', { code: 'EMPTY_CWD', statusCode: 400 });
    }
    const result = await spawnLiveSession(body.name, cwd);
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/live/kill',
  asyncHandler(async (req: Request, res: Response) => {
    // Kill a live tmux session via the control tower's /kill. The tower is the
    // fleet-lifecycle authority (protected sessions → 403, unknown → 422).
    const body = (req.body ?? {}) as { tmuxName?: unknown; tmuxId?: unknown };
    if (!isValidTmuxName(body.tmuxName)) {
      throw new AppError('A valid tmuxName is required.', { code: 'INVALID_TMUX_NAME', statusCode: 400 });
    }
    await assertLineageTmuxTarget(body.tmuxName, readTmuxIdParam(body.tmuxId));
    const result = await killLiveSession(body.tmuxName);
    res.json(createApiSuccessResponse(result));
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
    const force = parseOptionalBooleanQuery(req.query.force, 'force') ?? false;
    const deletedFromDisk = parseOptionalBooleanQuery(req.query.deletedFromDisk, 'deletedFromDisk') ?? force;
    const result = await sessionsService.deleteOrArchiveSessionById(sessionId, {
      force,
      deletedFromDisk,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/:sessionId/restore',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = sessionsService.restoreSessionById(sessionId);
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
    });
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
