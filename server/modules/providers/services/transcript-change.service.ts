import type { LLMProvider } from '@/shared/types.js';

export type TranscriptChange = Readonly<{
  provider: LLMProvider;
  providerSessionId: string | null;
  changedAtMs: number;
}>;

type Listener = (change: TranscriptChange) => void;

const SESSION_VERSION_MAX_ENTRIES = 2_048;
const providerVersions = new Map<LLMProvider, number>();
const sessionVersions = new Map<string, number>();
const listeners = new Set<Listener>();

function sessionKey(provider: LLMProvider, providerSessionId: string): string {
  return `${provider}\0${providerSessionId}`;
}

/**
 * Marks provider transcript evidence dirty. Normal watcher updates carry an
 * exact native session id; provider-wide invalidation is reserved for watcher
 * or synchronization failures where exact attribution is unavailable.
 */
export function markTranscriptChanged(
  provider: LLMProvider,
  providerSessionId: string | null = null,
  changedAtMs = Date.now(),
): void {
  if (providerSessionId) {
    const key = sessionKey(provider, providerSessionId);
    const nextVersion = (sessionVersions.get(key) ?? 0) + 1;
    // Delete-then-set keeps insertion order as recency so the bound below
    // evicts the least recently changed session, not an active one.
    sessionVersions.delete(key);
    sessionVersions.set(key, nextVersion);
    if (sessionVersions.size > SESSION_VERSION_MAX_ENTRIES) {
      const oldest: string = sessionVersions.keys().next().value!;
      sessionVersions.delete(oldest);
      // An evicted session would restart at version 0 and could resurrect a
      // stale cached resolution; bumping its provider version keeps every
      // combined version string fresh.
      const oldestProvider = oldest.slice(0, oldest.indexOf('\0')) as LLMProvider;
      providerVersions.set(oldestProvider, (providerVersions.get(oldestProvider) ?? 0) + 1);
    }
  } else {
    providerVersions.set(provider, (providerVersions.get(provider) ?? 0) + 1);
  }
  const change = Object.freeze({ provider, providerSessionId, changedAtMs });
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      // One optional consumer must never suppress watcher/synchronizer work.
    }
  }
}

export function transcriptChangeVersion(
  provider: LLMProvider,
  providerSessionId: string,
): string {
  return `${providerVersions.get(provider) ?? 0}:${sessionVersions.get(sessionKey(provider, providerSessionId)) ?? 0}`;
}

export function onTranscriptChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
