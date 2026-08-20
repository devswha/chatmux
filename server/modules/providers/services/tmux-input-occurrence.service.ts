import { createHash } from 'node:crypto';

import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../shared/tmux.js';

type TmuxInputActivityIdentity = Readonly<{
  provider: string;
  providerSessionId: string | null;
  tmux?: TmuxPaneIdentity;
  process?: TmuxProcessGeneration;
}>;

type ObserverSource = 'screen' | 'transcript';

type OccurrenceState = {
  hasObservedRun: boolean;
  inputActive: boolean;
  runSequence: number;
  sourceState: Record<ObserverSource, 'unknown' | 'running' | 'input'>;
};

const occurrences = new Map<string, OccurrenceState>();

function identityKey({
  provider,
  providerSessionId,
  tmux,
  process,
}: TmuxInputActivityIdentity): string {
  const hash = createHash('sha256')
    .update('chatmux:tmux-input-occurrence:v1\0')
    .update(provider)
    .update('\0')
    .update(providerSessionId ?? '');
  if (providerSessionId) return hash.digest('hex');
  if (!tmux || !process) throw new TypeError('tmux and process are required without a provider session id');
  return hash
    .update('\0')
    .update(tmux.socketPath)
    .update('\0')
    .update(tmux.sessionId)
    .update('\0')
    .update(tmux.windowId)
    .update('\0')
    .update(tmux.paneId)
    .update('\0')
    .update(String(process.pid))
    .update('\0')
    .update(String(process.startedAtMs))
    .digest('hex');
}

/**
 * Assigns a stable key to one RUN -> INPUT occurrence for a provider session
 * (or an unbound tmux process generation). Each observer keeps its own last
 * state: only the first source to observe a new RUN after INPUT advances the
 * sequence, while a lagging second observer joins that occurrence. An INPUT
 * seen before any RUN only establishes a startup baseline.
 */
export function observeTmuxInputActivity(
  identity: TmuxInputActivityIdentity,
  source: ObserverSource,
  inputActive: boolean,
): string | null {
  const key = identityKey(identity);
  let state = occurrences.get(key);
  if (!state) {
    state = {
      hasObservedRun: false,
      inputActive: false,
      runSequence: 0,
      sourceState: { screen: 'unknown', transcript: 'unknown' },
    };
    occurrences.set(key, state);
  }

  if (!inputActive) {
    const priorSourceState = state.sourceState[source];
    if (!state.hasObservedRun) {
      state.hasObservedRun = true;
      state.runSequence += 1;
      state.inputActive = false;
    } else if (priorSourceState === 'input' && state.inputActive) {
      state.runSequence += 1;
      state.inputActive = false;
    }
    state.sourceState[source] = 'running';
    return null;
  }

  state.sourceState[source] = 'input';
  state.inputActive = true;
  return state.hasObservedRun ? `${key}:${state.runSequence}` : null;
}
