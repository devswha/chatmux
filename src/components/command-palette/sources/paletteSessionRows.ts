/**
 * Session rows the command palette offers for the selected project.
 *
 * The palette merges two sources: the project's session roster and the
 * transcript-search matches. Both are addressed by a bare local session id, and
 * that id only identifies a session inside one installation — so the row carries
 * the route to its *owning* host. Without it, opening a peer's search hit would
 * navigate to the hub's own session that happens to share the id.
 *
 * A peer's roster is not the hub's to fetch either: the hub's project route
 * would answer with its own sessions under the same project id. Peer rows
 * therefore come from the host catalog the discovery stream already publishes.
 */

import type { FleetHostSessionRow } from '../../../fleet/discovery/hostRows';
import { sessionRef } from '../../../fleet/references';
import { sessionRoutePath } from '../../../fleet/sessionRoute';

import type { SessionMessageMatch } from './useSessionMessageSearch';
import type { SessionResult } from './useSessionsSource';

export type PaletteSessionRow = {
  readonly id: string;
  readonly label: string;
  readonly provider: string | undefined;
  readonly snippet: string | undefined;
  /** Deep link to this session on the host that owns it. */
  readonly route: string;
};

export type PaletteSessionRowsInput = {
  /** Host owning the selected project, or null for a legacy local-only project. */
  readonly hostId: string | null;
  readonly localHostId: string | null;
  /** Roster fetched from the local project route; empty for a peer project. */
  readonly localSessions: readonly SessionResult[];
  /** Roster rows published by the owning peer for this project. */
  readonly peerSessions: readonly FleetHostSessionRow[];
  readonly matches: readonly SessionMessageMatch[];
};

type Draft = {
  label: string;
  provider: string | undefined;
  snippet: string | undefined;
};

function isLocal(input: PaletteSessionRowsInput): boolean {
  return input.hostId === null || input.hostId === input.localHostId;
}

/**
 * Route for a session under the selected project's host. A local project keeps
 * the legacy `/session/:id` link; a peer session is host-qualified.
 */
function routeFor(input: PaletteSessionRowsInput, localId: string): string {
  return isLocal(input) && input.hostId === null
    ? `/session/${encodeURIComponent(localId)}`
    : sessionRoutePath(sessionRef(input.hostId ?? '', localId), input.localHostId);
}

export function buildPaletteSessionRows(
  input: PaletteSessionRowsInput,
): readonly PaletteSessionRow[] {
  const drafts = new Map<string, Draft>();
  const roster = isLocal(input)
    ? input.localSessions.map((session) => ({ id: session.id, label: session.label, provider: session.provider }))
    : input.peerSessions.map((row) => ({ id: row.localId, label: row.summary || row.localId, provider: row.provider }));
  for (const entry of roster) {
    drafts.set(entry.id, { label: entry.label, provider: entry.provider, snippet: undefined });
  }
  for (const match of input.matches) {
    const existing = drafts.get(match.sessionId);
    if (existing === undefined) {
      drafts.set(match.sessionId, { label: match.label, provider: match.provider, snippet: match.snippet });
      continue;
    }
    existing.snippet = match.snippet;
  }
  return [...drafts].map(([id, draft]) => ({
    id,
    label: draft.label,
    provider: draft.provider,
    snippet: draft.snippet,
    route: routeFor(input, id),
  }));
}
