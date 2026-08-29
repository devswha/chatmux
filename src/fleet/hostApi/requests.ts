/**
 * Boundary for host-qualified JSON requests.
 *
 * Every response — success envelope, controlled fleet failure, or transport
 * error — is parsed here exactly once into a typed result, so callers branch on
 * a closed value instead of re-reading HTTP shapes.
 *
 * `outcome` is the side-effect verdict the fleet contract requires: a mutation
 * whose request was dispatched but whose answer never arrived is `unknown`, and
 * an unknown outcome must be reconciled against host state before the user may
 * act again. It is never retried automatically.
 */

import { authenticatedFetch } from '../../utils/api';

export type HostRequestOutcome = 'none' | 'unknown';

export type HostRequestFailure = {
  readonly code: string;
  readonly message: string;
  readonly outcome: HostRequestOutcome;
};

export type HostResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: HostRequestFailure };

export type ProviderCommand = {
  readonly name: string;
  readonly description: string;
  readonly scope: string;
};

export type ProviderInventory = {
  readonly provider: string;
  readonly commands: readonly ProviderCommand[];
};

export type TranscriptSearchMatch = {
  readonly sessionId: string;
  readonly label: string;
  readonly snippet: string;
  readonly provider: string;
};

const TRANSPORT_FAILURE = 'HOST_REQUEST_FAILED';

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mutating(init: RequestInit | undefined): boolean {
  const method = init?.method ?? 'GET';
  return method !== 'GET' && method !== 'HEAD';
}

function failureFrom(body: unknown, fallback: string, outcome: HostRequestOutcome): HostRequestFailure {
  const error = record(record(body)?.error);
  const code = text(error?.code);
  const message = text(error?.message);
  return code === null
    ? { code: TRANSPORT_FAILURE, message: message ?? fallback, outcome }
    : { code, message: message ?? fallback, outcome: code === 'HOST_COMMAND_OUTCOME_UNKNOWN' ? 'unknown' : outcome };
}

/**
 * Runs one host-qualified request. A dispatched mutation that fails in transport
 * has an unknown outcome: the request may have been applied on the owning host,
 * so the caller must reconcile rather than assume either result.
 */
export async function requestHostJson(url: string, init?: RequestInit): Promise<HostResult<unknown>> {
  const dispatchOutcome: HostRequestOutcome = mutating(init) ? 'unknown' : 'none';
  let response: Response;
  try {
    response = await authenticatedFetch(url, init);
  } catch (error) {
    return {
      ok: false,
      failure: {
        code: TRANSPORT_FAILURE,
        message: error instanceof Error ? error.message : 'Host request failed.',
        outcome: dispatchOutcome,
      },
    };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, failure: failureFrom(body, `Host request failed (${response.status}).`, dispatchOutcome) };
  }
  const envelope = record(body);
  return { ok: true, value: envelope !== null && 'data' in envelope ? envelope.data : body };
}

/** Peer-authoritative provider commands and skills for one session. */
export function parseProviderInventory(value: unknown): ProviderInventory | null {
  const payload = record(value);
  const provider = text(payload?.provider);
  if (payload === null || provider === null || !Array.isArray(payload.commands)) {
    return null;
  }
  const commands: ProviderCommand[] = [];
  for (const candidate of payload.commands) {
    const entry = record(candidate);
    const name = text(entry?.name);
    if (name === null) continue;
    commands.push({
      name,
      description: typeof entry?.description === 'string' ? entry.description : '',
      scope: typeof entry?.scope === 'string' ? entry.scope : 'project',
    });
  }
  return { provider, commands };
}

/** Host-home relative directory suggestions. Absolute host paths never appear. */
export function parseDirSuggestions(value: unknown): readonly string[] {
  const payload = record(value);
  return Array.isArray(payload?.suggestions)
    ? payload.suggestions.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

export function parseTranscriptSearch(value: unknown, projectLocalId: string): readonly TranscriptSearchMatch[] {
  const payload = record(value);
  if (!Array.isArray(payload?.results)) {
    return [];
  }
  const matches: TranscriptSearchMatch[] = [];
  for (const candidate of payload.results) {
    const result = record(candidate);
    // A result for another project is not this project's transcript, even when
    // both hosts use the same project id.
    if (result === null || result.projectId !== projectLocalId || !Array.isArray(result.sessions)) continue;
    for (const sessionCandidate of result.sessions) {
      const session = record(sessionCandidate);
      const sessionId = text(session?.sessionId);
      if (session === null || sessionId === null) continue;
      const snippets = Array.isArray(session.matches) ? session.matches.map((entry) => text(record(entry)?.snippet)) : [];
      matches.push({
        sessionId,
        label: text(session.sessionSummary) ?? sessionId,
        snippet: snippets.find((snippet): snippet is string => snippet !== null) ?? '',
        provider: text(session.provider) ?? 'gjc',
      });
    }
  }
  return matches;
}
