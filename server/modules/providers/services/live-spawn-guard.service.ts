import {
  getExternalCliSessionsDetailedFresh,
  type ExternalCliSession,
  type ExternalLocalCliKind,
} from '@/modules/providers/services/external-cli-sessions.service.js';
import type { LLMProvider } from '@/shared/types.js';

/**
 * Providers whose transcripts are indexed as ordinary sessions even while a
 * CLI is attached to them in a tmux pane. For these, `chat.send` spawning a
 * headless resume would put a SECOND writer on the same transcript: the user
 * sees a reply, the live agent never sees the message, and the JSONL
 * interleaves two processes (#44).
 *
 * gjc is deliberately absent: its live sessions are reached through the SDK
 * connect lane (`connectGjcSdkSession`), which attaches to the running agent
 * instead of forking a new one, so the duplicate-writer failure cannot occur.
 */
const GUARDED_PROVIDERS: ReadonlySet<string> = new Set<ExternalLocalCliKind>([
  'claude', 'codex', 'cursor', 'opencode', 'omp', 'omo',
]);

export type LiveTmuxSpawnBlock = { tmuxName: string };

/** Pure matcher, exported for tests. */
export function findLiveTmuxPaneForSession(
  provider: LLMProvider | string,
  providerSessionId: string,
  sessions: readonly ExternalCliSession[],
): LiveTmuxSpawnBlock | null {
  if (!GUARDED_PROVIDERS.has(provider)) return null;
  const owner = sessions.find((session) => (
    session.kind === provider && session.providerSessionId === providerSessionId
  ));
  return owner ? { tmuxName: owner.tmuxName } : null;
}

/**
 * Returns the live tmux owner of a provider-native session id, or null when
 * spawning is safe. Fail-open on unavailable or failed discovery evidence:
 * a false block would break the core chat path outright, while a false allow
 * merely restores the pre-guard behavior — and when tmux is not running at
 * all, no pane can own the transcript anyway.
 */
export async function findLiveTmuxSpawnBlock(
  provider: LLMProvider | string,
  providerSessionId: string | null | undefined,
): Promise<LiveTmuxSpawnBlock | null> {
  if (!providerSessionId || !GUARDED_PROVIDERS.has(provider)) return null;
  try {
    const detailed = await getExternalCliSessionsDetailedFresh();
    if (!detailed.ok) return null;
    return findLiveTmuxPaneForSession(provider, providerSessionId, detailed.sessions);
  } catch {
    return null;
  }
}
