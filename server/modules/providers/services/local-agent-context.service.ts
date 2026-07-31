import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';

import type { ProviderConnectionIssue } from '../../../../shared/provider-connection.js';

type LocalAgentContext = {
  pid: number;
  startedAtMs: number | null;
  socketPath: string;
};

type CacheEntry = {
  expiresAtMs: number;
  issue: ProviderConnectionIssue | null;
};

const CACHE_MS = 5_000;
const contextCache = new Map<string, CacheEntry>();

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

async function normalizedPath(path: string): Promise<string> {
  return realpath(path).catch(() => path.replace(/\/+$/, ''));
}

/**
 * Rejects cross-user/cross-HOME agent bindings before provider-specific
 * transcript inference. Missing /proc entries are treated as a normal process
 * race; only deterministic ownership/permission evidence becomes a warning.
 */
export async function validateLocalAgentContext(
  context: LocalAgentContext,
): Promise<ProviderConnectionIssue | null> {
  const key = [
    context.pid,
    context.startedAtMs ?? '',
    context.socketPath,
  ].join('\0');
  const now = Date.now();
  const cached = contextCache.get(key);
  if (cached && cached.expiresAtMs > now) return cached.issue;

  let issue: ProviderConnectionIssue | null = null;
  const expectedUid = process.getuid?.();
  if (expectedUid !== undefined) {
    try {
      if ((await stat(`/proc/${context.pid}`)).uid !== expectedUid) {
        issue = 'agent_user_mismatch';
      }
    } catch (error) {
      if (errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM') {
        issue = 'agent_context_unreadable';
      }
    }

    if (!issue) {
      try {
        if ((await stat(context.socketPath)).uid !== expectedUid) {
          issue = 'tmux_socket_owner_mismatch';
        }
      } catch (error) {
        if (errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM') {
          issue = 'agent_context_unreadable';
        }
      }
    }
  }

  if (!issue) {
    try {
      const environment = await readFile(`/proc/${context.pid}/environ`, 'utf8');
      const agentHome = environment
        .split('\0')
        .find((entry) => entry.startsWith('HOME='))
        ?.slice('HOME='.length);
      if (
        agentHome
        && await normalizedPath(agentHome) !== await normalizedPath(homedir())
      ) {
        issue = 'agent_home_mismatch';
      }
    } catch (error) {
      if (errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM') {
        issue = 'agent_context_unreadable';
      }
    }
  }

  contextCache.set(key, { expiresAtMs: now + CACHE_MS, issue });
  if (contextCache.size > 512) {
    contextCache.delete(contextCache.keys().next().value!);
  }
  return issue;
}
