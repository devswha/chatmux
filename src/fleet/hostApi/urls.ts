/**
 * Host-qualified request URLs.
 *
 * One place decides, per request, whether a session/project belongs to this
 * installation or to a peer. Local requests keep the existing endpoints so
 * single-machine ChatMux is byte-identical; a peer request is addressed through
 * `/api/hosts/:hostId/...` so the hub routes it to the owning installation.
 *
 * `hostId: null` means "no authoritative local host id yet" — pre-fleet
 * behaviour, never "any host". Endpoints that exist only in host-qualified form
 * return `null` for a local scope: the caller then uses its existing local API,
 * which keeps this module free of local-endpoint special cases.
 */

export type HostScope = {
  /** Host owning the addressed session/project. */
  readonly hostId: string | null;
  /** Authoritative local host id, or null before the server supplies one. */
  readonly localHostId: string | null;
};

export type TranscriptSearchQuery = {
  readonly query: string;
  readonly limit: number;
};

export function isLocalHostScope(scope: HostScope): boolean {
  return scope.hostId === null || scope.hostId === scope.localHostId;
}

function hostPrefix(scope: HostScope): string {
  return `/api/hosts/${encodeURIComponent(scope.hostId ?? '')}`;
}

function query(suffix: string): string {
  return suffix ? `?${suffix}` : '';
}

export function hostSessionMessagesUrl(scope: HostScope, localId: string, search: string): string {
  const session = encodeURIComponent(localId);
  return isLocalHostScope(scope)
    ? `/api/providers/sessions/${session}/messages${query(search)}`
    : `${hostPrefix(scope)}/providers/sessions/${session}/messages${query(search)}`;
}

/**
 * Slash commands and skills for a session. The local host keeps its existing
 * live-commands endpoint; a peer answers from its own installed inventory.
 */
export function hostInventoryUrl(scope: HostScope, localId: string): string {
  return isLocalHostScope(scope)
    ? '/api/providers/sessions/live/commands'
    : `${hostPrefix(scope)}/providers/sessions/${encodeURIComponent(localId)}/inventory`;
}

/**
 * Token usage is already included in host-qualified transcript history. The
 * standalone compatibility endpoint reads this installation's DB/filesystem,
 * so a peer must never be sent there with a colliding project or session id.
 */
export function hostSessionTokenUsageUrl(
  scope: HostScope,
  projectLocalId: string,
  sessionLocalId: string,
): string | null {
  return isLocalHostScope(scope)
    ? `/api/projects/${encodeURIComponent(projectLocalId)}/sessions/${encodeURIComponent(sessionLocalId)}/token-usage`
    : null;
}

/** Full project file access is local-only until Fleet advertises that capability. */
export function hostProjectFilesUrl(scope: HostScope, projectLocalId: string): string | null {
  return isLocalHostScope(scope)
    ? `/api/projects/${encodeURIComponent(projectLocalId)}/files`
    : null;
}

export function hostPromptUrl(scope: HostScope, localId: string): string | null {
  return isLocalHostScope(scope)
    ? null
    : `${hostPrefix(scope)}/providers/sessions/${encodeURIComponent(localId)}/prompt`;
}

export function hostApprovalUrl(scope: HostScope, localId: string): string | null {
  return isLocalHostScope(scope)
    ? null
    : `${hostPrefix(scope)}/providers/sessions/${encodeURIComponent(localId)}/approval`;
}

export function hostDirSuggestionsUrl(scope: HostScope, projectLocalId: string, prefix: string): string {
  const search = new URLSearchParams({ prefix }).toString();
  return isLocalHostScope(scope)
    ? `/api/providers/fs/dir-suggestions?${search}`
    : `${hostPrefix(scope)}/projects/${encodeURIComponent(projectLocalId)}/dir-suggestions?${search}`;
}

export function hostSpawnUrl(scope: HostScope, projectLocalId: string): string | null {
  return isLocalHostScope(scope)
    ? null
    : `${hostPrefix(scope)}/projects/${encodeURIComponent(projectLocalId)}/sessions/spawn`;
}

/**
 * Transcript search for one project. Local search streams over SSE from the
 * existing endpoint, so only the peer form exists here.
 */
export function hostTranscriptSearchUrl(
  scope: HostScope,
  projectLocalId: string,
  search: TranscriptSearchQuery,
): string | null {
  if (isLocalHostScope(scope)) {
    return null;
  }
  const params = new URLSearchParams({ query: search.query, limit: String(search.limit) }).toString();
  return `${hostPrefix(scope)}/projects/${encodeURIComponent(projectLocalId)}/search?${params}`;
}
