import { randomUUID } from 'node:crypto';

import express, { type Request } from 'express';

import { createApiSuccessResponse } from '@/shared/utils.js';

import { FLEET_ERROR_CODES, parseFleetReference } from '../../../../shared/fleet.js';
import type { FleetErrorCode, FleetOperation, FleetPaneReference, JsonValue } from '../../../../shared/fleet.js';

import { fleetApplicationRouting, type FleetApplicationRouting } from './application-routing.js';
import { createHostQualifiedActionRoutes } from './host-qualified-action.routes.js';
import { FleetHostRoutingError, type FleetRoutingPrincipal } from './host-router.js';

const REQUEST_DEADLINE_MS = 10_000;

export type RoutingResolver = () => FleetApplicationRouting | undefined;

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\0')) {
    throw new FleetHostRoutingError('FLEET_IDENTIFIER_INVALID', `${name} is invalid.`);
  }
  return value;
}

function principal(request: Request): FleetRoutingPrincipal {
  const candidate = 'user' in request ? request.user : undefined;
  if (candidate === null || typeof candidate !== 'object') return { id: '', owner: false };
  const fields = Object.entries(candidate);
  const value = (name: string): unknown => fields.find(([key]) => key === name)?.[1];
  const idValue = value('id') ?? value('userId') ?? value('username');
  const role = value('tailscaleRole');
  return {
    id: typeof idValue === 'string' || typeof idValue === 'number' ? String(idValue) : '',
    owner: role === undefined || role === 'owner' || role === 'local',
  };
}

function routing(resolve: RoutingResolver): FleetApplicationRouting {
  const value = resolve();
  if (value === undefined) throw new FleetHostRoutingError('HOST_OFFLINE', 'Fleet routing is unavailable.');
  return value;
}

function route(request: Request, resolve: RoutingResolver, operation: FleetOperation) {
  const active = routing(resolve);
  const selected = active.router.route({
    hostId: text(request.params.hostId, 'hostId'),
    operation,
    principal: principal(request),
  });
  return { active, selected };
}

function deadline(): number { return Date.now() + REQUEST_DEADLINE_MS; }
function signal(): AbortSignal { return AbortSignal.timeout(REQUEST_DEADLINE_MS); }
function body(request: Request): Readonly<Record<string, unknown>> {
  const value = request.body;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', 'Request body is invalid.');
  }
  return Object.fromEntries(Object.entries(value));
}
/**
 * A spawn path is host-home relative by contract: the controller never learns or
 * sends an absolute path for another installation, so an absolute or traversing
 * value is rejected here before any host is contacted.
 */
function peerRelativePath(value: unknown, name: string): string {
  const candidate = text(value, name);
  if (candidate.startsWith('/') || candidate.startsWith('~') || candidate.split('/').includes('..')) {
    throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', `${name} must be relative to the host home directory.`);
  }
  return candidate;
}
/**
 * Typed fleet failures from the read/mutation clients (host unavailable, capability
 * missing, deadline exceeded, uncertain outcome) already name their machine code.
 * Passing them through untranslated would collapse them into an opaque 500, so an
 * uncertain mutation would look like a server bug instead of a state the browser
 * must reconcile before the user may retry.
 */
function failure(error: unknown): unknown {
  if (error instanceof FleetHostRoutingError || error === null || typeof error !== 'object' || !('code' in error)) return error;
  const code: unknown = error.code;
  return typeof code === 'string' && (FLEET_ERROR_CODES as readonly string[]).includes(code)
    ? new FleetHostRoutingError(code as FleetErrorCode, error instanceof Error ? error.message : 'Fleet request failed.')
    : error;
}
/** A local read answers `null` for an id this installation does not own. */
function present(value: JsonValue | null): JsonValue {
  if (value === null) throw new FleetHostRoutingError('HOST_NOT_FOUND', 'Fleet target was not found.');
  return value;
}
function pane(request: Request): FleetPaneReference {
  const input = body(request);
  const target = parseFleetReference({
    kind: 'pane', hostId: text(request.params.hostId, 'hostId'),
    localId: text(request.params.localId, 'localId'), lane: input.lane,
    tmux: input.tmux, process: input.process,
  });
  if (target.kind !== 'pane') throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', 'Pane target is invalid.');
  return target;
}

export function createHostQualifiedRoutes(resolve: RoutingResolver = () => fleetApplicationRouting.current()) {
  const router = express.Router();
  router.use(createHostQualifiedActionRoutes(resolve));

  router.get('/hosts/:hostId/providers/sessions/:sessionId', async (request, response, next) => {
    try {
      const sessionId = text(request.params.sessionId, 'sessionId');
      const { active, selected } = route(request, resolve, 'session.read');
      const result = selected.kind === 'local'
        ? await active.localReads.sessionMetadata(sessionId, signal())
        : await selected.clients.reads.metadata({ kind: 'session', hostId: selected.hostId, localId: sessionId }, deadline());
      response.json(createApiSuccessResponse(result));
    } catch (error) { next(failure(error)); }
  });

  router.get('/hosts/:hostId/providers/sessions/:sessionId/messages', async (request, response, next) => {
    try {
      const sessionId = text(request.params.sessionId, 'sessionId');
      const limitValue = typeof request.query.limit === 'string' ? Number(request.query.limit) : null;
      const offsetValue = typeof request.query.offset === 'string' ? Number(request.query.offset) : 0;
      const options = { limit: Number.isSafeInteger(limitValue) && limitValue !== null ? limitValue : null, offset: Number.isSafeInteger(offsetValue) ? offsetValue : 0, includeImages: request.query.includeImages === 'true' };
      const { active, selected } = route(request, resolve, 'session.history');
      const result = selected.kind === 'local'
        ? await active.localReads.history(sessionId, options, signal())
        : await selected.clients.reads.history({ kind: 'session', hostId: selected.hostId, localId: sessionId }, { ...options, deadlineAtMs: deadline() });
      response.json(createApiSuccessResponse(result));
    } catch (error) { next(failure(error)); }
  });

  router.get('/hosts/:hostId/providers/sessions/:sessionId/tool-result', async (request, response, next) => {
    try {
      const sessionId = text(request.params.sessionId, 'sessionId');
      const toolId = typeof request.query.toolId === 'string' ? request.query.toolId : '';
      const offset = request.query.offset === undefined ? 0 : typeof request.query.offset === 'string' ? Number(request.query.offset) : NaN;
      const revision = request.query.revision === undefined ? null : request.query.revision;
      if (!toolId || toolId.length > 500 || toolId.includes('\0') || !Number.isSafeInteger(offset) || offset < 0
        || (revision !== null && (typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision)))
        || (offset > 0 && revision === null)) {
        throw new FleetHostRoutingError('FLEET_MALFORMED_FRAME', 'Tool output read parameters are invalid.');
      }
      const { active, selected } = route(request, resolve, 'session.read');
      const options = { toolId, offset, revision, deadlineAtMs: deadline() };
      if (selected.kind === 'local' && !active.localReads.toolResult) throw new FleetHostRoutingError('FLEET_CAPABILITY_UNAVAILABLE', 'Tool output reads are unavailable.');
      const result = selected.kind === 'local'
        ? await active.localReads.toolResult!(sessionId, options, signal())
        : await selected.clients.reads.toolResult({ kind: 'session', hostId: selected.hostId, localId: sessionId }, options);
      response.json(createApiSuccessResponse(result));
    } catch (error) { next(failure(error)); }
  });

  router.get('/hosts/:hostId/projects/:projectId/search', async (request, response, next) => {
    try {
      const projectId = text(request.params.projectId, 'projectId');
      const query = text(request.query.query, 'query');
      const limit = typeof request.query.limit === 'string' && Number.isSafeInteger(Number(request.query.limit)) ? Number(request.query.limit) : 50;
      const { active, selected } = route(request, resolve, 'session.search');
      const result = selected.kind === 'local'
        ? await active.localReads.search(projectId, { query, limit, signal: signal() })
        : await selected.clients.reads.search({ kind: 'project', hostId: selected.hostId, localId: projectId }, { query, limit, deadlineAtMs: deadline() });
      response.json(createApiSuccessResponse(result));
    } catch (error) { next(failure(error)); }
  });

  router.post('/hosts/:hostId/providers/panes/:localId/capture', async (request, response, next) => {
    try {
      const target = pane(request);
      const { active, selected } = route(request, resolve, 'pane.capture');
      const result: JsonValue = selected.kind === 'local'
        ? await active.localReads.capturePane(target, signal())
        : await selected.clients.reads.capturePane(target, deadline());
      response.json(createApiSuccessResponse(result));
    } catch (error) { next(failure(error)); }
  });

  // Slash commands and skills are host-local provider state: the owning host
  // resolves its own installed inventory, never the controller's.
  router.get('/hosts/:hostId/providers/sessions/:sessionId/inventory', async (request, response, next) => {
    try {
      const sessionId = text(request.params.sessionId, 'sessionId');
      const { active, selected } = route(request, resolve, 'session.read');
      const result = selected.kind === 'local'
        ? present(await active.localReads.providerInventory(sessionId, signal()))
        : await selected.clients.reads.providerInventory({ kind: 'session', hostId: selected.hostId, localId: sessionId }, deadline());
      response.json(createApiSuccessResponse(result));
    } catch (error) { next(failure(error)); }
  });

  router.get('/hosts/:hostId/providers/sessions/:sessionId/prompt', async (request, response, next) => {
    try {
      const sessionId = text(request.params.sessionId, 'sessionId');
      const { active, selected } = route(request, resolve, 'prompt.read');
      const result = selected.kind === 'local'
        ? await active.localReads.prompt(sessionId, signal())
        : await selected.clients.reads.prompt({ kind: 'session', hostId: selected.hostId, localId: sessionId }, deadline());
      response.json(createApiSuccessResponse(result));
    } catch (error) { next(failure(error)); }
  });

  router.get('/hosts/:hostId/providers/sessions/:sessionId/approval', async (request, response, next) => {
    try {
      const sessionId = text(request.params.sessionId, 'sessionId');
      const { active, selected } = route(request, resolve, 'approval.read');
      const result = selected.kind === 'local'
        ? await active.localReads.approval(sessionId, signal())
        : await selected.clients.reads.approval({ kind: 'session', hostId: selected.hostId, localId: sessionId }, deadline());
      response.json(createApiSuccessResponse(result));
    } catch (error) { next(failure(error)); }
  });

  router.get('/hosts/:hostId/projects/:projectId/dir-suggestions', async (request, response, next) => {
    try {
      const projectId = text(request.params.projectId, 'projectId');
      const prefix = typeof request.query.prefix === 'string' ? request.query.prefix : '';
      const { active, selected } = route(request, resolve, 'session.search');
      const result = selected.kind === 'local'
        ? present(await active.localReads.pathSuggestions(projectId, prefix, signal()))
        : await selected.clients.reads.pathSuggestions({ kind: 'project', hostId: selected.hostId, localId: projectId }, { prefix, deadlineAtMs: deadline() });
      response.json(createApiSuccessResponse(result));
    } catch (error) { next(failure(error)); }
  });

  router.post('/hosts/:hostId/projects/:projectId/sessions/spawn', async (request, response, next) => {
    try {
      const projectId = text(request.params.projectId, 'projectId');
      const input = body(request);
      const name = text(input.name, 'name');
      const cwd = peerRelativePath(input.cwd, 'cwd');
      const { active, selected } = route(request, resolve, 'session.spawn');
      const result = selected.kind === 'local'
        ? await active.localSpawn.spawn(projectId, { name, cwd })
        : await selected.clients.mutations.spawn({ kind: 'project', hostId: selected.hostId, localId: projectId }, {
          requestId: `browser-${randomUUID()}`, deadlineAtMs: deadline(), name, cwd,
        });
      response.json(createApiSuccessResponse(result));
    } catch (error) { next(failure(error)); }
  });

  return router;
}
