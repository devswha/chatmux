import { createHash } from 'node:crypto';

import type { ExternalCliSession } from '@/modules/providers/index.js';

const IDENTITY_VERSION = 'completion-target/v1';
const APP_ALIAS_PREFIX = 'ct_';
const EXTERNAL_PROVIDERS = new Set(['claude', 'codex', 'opencode', 'omp', 'omo']);

export type CompletionAppIdentity = Readonly<{
  provider: string;
  sessionId: string;
}>;

export type CompletionExternalGenerationIdentity = Readonly<{
  provider: 'claude' | 'codex' | 'opencode' | 'omp';
  socketPath: string;
  sessionId: string;
  windowId: string;
  paneId: string;
  agentPid: number;
  startedAtMs: number;
}>;
export type CompletionPaneEvidenceIdentity = Readonly<{
  socketPath: string;
  sessionId: string;
  windowId: string;
  paneId: string;
}>;

function assertScalarValue(value: string, name: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : Number.NaN;
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${name} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${name} contains an unpaired surrogate`);
    }
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  assertScalarValue(value, name);
}

function identityDigest(domain: string, fields: readonly string[]): string {
  assertString(domain, 'domain');
  const hash = createHash('sha256');
  for (const field of [IDENTITY_VERSION, domain, ...fields]) {
    assertString(field, 'identity field');
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function identityKey(domain: string, fields: readonly string[]): string {
  return `${IDENTITY_VERSION}:${domain}:${identityDigest(domain, fields)}`;
}

/** Provider-qualified app-session identity. Inputs are intentionally not normalized. */
export function completionAppIdentityKey(identity: CompletionAppIdentity): string {
  assertString(identity.provider, 'provider');
  assertString(identity.sessionId, 'sessionId');
  return identityKey('app', [identity.provider, identity.sessionId]);
}

/** Browser-safe opaque alias derived from the full app identity digest. */
export function completionAppAlias(identity: CompletionAppIdentity): string {
  return `${APP_ALIAS_PREFIX}${identityDigest('app', [identity.provider, identity.sessionId])}`;
}

/** Exact tmux process-generation identity. Inputs are intentionally not normalized. */
function assertExternalGenerationIdentity(identity: CompletionExternalGenerationIdentity): void {
  if (!EXTERNAL_PROVIDERS.has(identity.provider)) {
    throw new TypeError('provider must be a supported external CLI provider');
  }
  for (const [name, value] of Object.entries(identity)) {
    if (typeof value === 'string') assertString(value, name);
  }
  for (const [name, value] of Object.entries({
    socketPath: identity.socketPath,
    sessionId: identity.sessionId,
    windowId: identity.windowId,
    paneId: identity.paneId,
  })) {
    if (!value.trim()) throw new TypeError(`${name} must be nonblank`);
  }
  if (!Number.isSafeInteger(identity.agentPid) || identity.agentPid <= 0) {
    throw new TypeError('agentPid must be a positive safe integer');
  }
  if (!Number.isFinite(identity.startedAtMs) || identity.startedAtMs <= 0) {
    throw new TypeError('startedAtMs must be a positive finite number');
  }
}

function externalGenerationFields(identity: CompletionExternalGenerationIdentity): string[] {
  assertExternalGenerationIdentity(identity);
  return [
    identity.provider,
    identity.socketPath,
    identity.sessionId,
    identity.windowId,
    identity.paneId,
    String(identity.agentPid),
    String(identity.startedAtMs),
  ];
}
function paneEvidenceFields(identity: CompletionPaneEvidenceIdentity): string[] {
  for (const [name, value] of Object.entries(identity)) {
    assertString(value, name);
    if (!value.trim()) throw new TypeError(`${name} must be nonblank`);
  }
  return [identity.socketPath, identity.sessionId, identity.windowId, identity.paneId];
}

/** Opaque exact pane identity used only as durable scan evidence; it excludes process generation data. */
export function completionExternalGenerationPaneEvidenceKey(identity: CompletionPaneEvidenceIdentity): string {
  return identityKey('pane_evidence', paneEvidenceFields(identity));
}


export function completionExternalGenerationIdentityKey(identity: CompletionExternalGenerationIdentity): string {
  return identityKey('external_generation', externalGenerationFields(identity));
}

export function completionExternalGenerationAlias(identity: CompletionExternalGenerationIdentity): string {
  return `${APP_ALIAS_PREFIX}${identityDigest('external_generation', externalGenerationFields(identity))}`;
}

/** Returns null only for unsupported external providers; malformed supported
 * generation data is rejected with the original validation diagnostic. */
export function completionExternalGenerationIdentityFromSession(
  session: ExternalCliSession,
): CompletionExternalGenerationIdentity | null {
  if (!EXTERNAL_PROVIDERS.has(session.kind)) return null;
  if (!session.tmux) throw new TypeError('supported external session is missing tmux generation data');
  const identity = {
    provider: session.kind as CompletionExternalGenerationIdentity['provider'],
    socketPath: session.tmux.socketPath,
    sessionId: session.tmux.sessionId,
    windowId: session.tmux.windowId,
    paneId: session.tmux.paneId,
    agentPid: session.agentPid,
    startedAtMs: session.startedAtMs,
  };
  assertExternalGenerationIdentity(identity as CompletionExternalGenerationIdentity);
  return identity as CompletionExternalGenerationIdentity;
}

export const completionTargetIdentity = {
  appAlias: completionAppAlias,
  appIdentityKey: completionAppIdentityKey,
  externalGenerationAlias: completionExternalGenerationAlias,
  externalGenerationIdentityFromSession: completionExternalGenerationIdentityFromSession,
  externalGenerationIdentityKey: completionExternalGenerationIdentityKey,
  externalGenerationPaneEvidenceKey: completionExternalGenerationPaneEvidenceKey,
};
