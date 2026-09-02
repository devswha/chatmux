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

export type LiveTmuxSpawnBlock = { readonly tmuxName: string };

export type LiveTmuxSpawnGuardResult =
  | { readonly kind: 'blocked'; readonly tmuxName: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'discovery_unavailable' };

const CLEAR_RESULT = { kind: 'clear' } as const;
const DISCOVERY_UNAVAILABLE_RESULT = { kind: 'discovery_unavailable' } as const;

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
 * Distinguishes a clear fresh scan from unavailable discovery so callers can
 * fail closed only when resuming a provider-native session could create a
 * duplicate writer.
 */
export async function findLiveTmuxSpawnBlock(
  provider: LLMProvider | string,
  providerSessionId: string | null | undefined,
): Promise<LiveTmuxSpawnGuardResult> {
  if (!providerSessionId || !GUARDED_PROVIDERS.has(provider)) return CLEAR_RESULT;
  try {
    const detailed = await getExternalCliSessionsDetailedFresh();
    if (!detailed.ok) return DISCOVERY_UNAVAILABLE_RESULT;
    const owner = findLiveTmuxPaneForSession(provider, providerSessionId, detailed.sessions);
    return owner ? { kind: 'blocked', tmuxName: owner.tmuxName } : CLEAR_RESULT;
  } catch {
    return DISCOVERY_UNAVAILABLE_RESULT;
  }
}
