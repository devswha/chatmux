/**
 * The interactive prompt a relayed session is currently showing.
 *
 * A prompt lives in the pane running the agent, so it must be read from the
 * machine that owns that pane. The local host keeps its existing pane endpoints;
 * for a peer session the pane identity is not the hub's to interpret — an
 * identical tmux identity may exist locally — so the prompt is read through the
 * host-qualified session route and the peer resolves its own pane.
 */

import { useCallback, useEffect, useState } from 'react';

import { requestHostJson } from '../../../fleet/hostApi/requests';
import {
  hostApprovalUrl,
  hostPromptUrl,
  isLocalHostScope,
  type HostScope,
} from '../../../fleet/hostApi/urls';
import type { TmuxPaneTarget } from '../../../../shared/tmux';
import { api } from '../../../utils/api';

export type RelayInteractivePrompt = {
  id: string;
  kind: 'question' | 'approval' | 'plan';
  title: string;
  question: string;
  body: string | null;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  checkedChoiceNumbers?: number[];
  customOptionNumber: number | null;
  cancelNumber: 0;
};

export type RelayInteractivePromptInput = {
  readonly relayKind: string;
  readonly target: TmuxPaneTarget;
  readonly session: HostScope & { readonly localId: string | null };
};

export type RelayInteractivePromptState = {
  readonly prompt: RelayInteractivePrompt | null;
  /**
   * Hides the answered prompt until the owning host reports the next one. The
   * poll below is the only authority on what is on screen, so a delivered answer
   * clears the card immediately instead of leaving stale choices tappable.
   */
  readonly dismiss: () => void;
};

const POLL_INTERVAL_MS = 1_000;
const PROMPT_PROVIDERS = new Set(['gjc', 'codex', 'omp', 'claude']);

function asPrompt(value: unknown, field: 'prompt' | 'approval' = 'prompt'): RelayInteractivePrompt | null {
  const prompt = (value as { prompt?: unknown; approval?: unknown } | null)?.[field];
  return prompt !== null && typeof prompt === 'object'
    && typeof (prompt as { id?: unknown }).id === 'string'
    && typeof (prompt as { question?: unknown }).question === 'string'
    && Array.isArray((prompt as { options?: unknown }).options)
    ? prompt as RelayInteractivePrompt
    : null;
}

export function useRelayInteractivePrompt(input: RelayInteractivePromptInput): RelayInteractivePromptState {
  const [prompt, setPrompt] = useState<RelayInteractivePrompt | null>(null);
  const { relayKind, target } = input;
  const { hostId, localHostId, localId } = input.session;
  const dismiss = useCallback(() => setPrompt(null), []);

  useEffect(() => {
    if (!PROMPT_PROVIDERS.has(relayKind)) {
      setPrompt(null);
      return undefined;
    }
    const scope: HostScope = { hostId, localHostId };
    const remoteUrl = localId === null ? null : hostPromptUrl(scope, localId);
    const approvalUrl = localId === null ? null : hostApprovalUrl(scope, localId);
    if (!isLocalHostScope(scope) && (remoteUrl === null || approvalUrl === null)) {
      setPrompt(null);
      return undefined;
    }
    let cancelled = false;
    let inFlight = false;
    const read = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        if (remoteUrl !== null && approvalUrl !== null) {
          const [promptResult, approvalResult] = await Promise.all([
            requestHostJson(remoteUrl),
            requestHostJson(approvalUrl),
          ]);
          if (!cancelled) {
            setPrompt(
              (promptResult.ok ? asPrompt(promptResult.value) : null)
              ?? (approvalResult.ok ? asPrompt(approvalResult.value, 'approval') : null),
            );
          }
          return;
        }
        const response = relayKind === 'gjc'
          ? await api.liveSessionInteractivePrompt(target.tmux, target.process)
          : await api.externalCliSessionInteractivePrompt(target.tmux, target.process);
        const body: unknown = await response.json().catch(() => null);
        if (cancelled || !response.ok) return;
        setPrompt(asPrompt((body as { data?: unknown } | null)?.data));
      } catch {
        // Best effort. Free-text relay remains available if the read fails.
      } finally {
        inFlight = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hostId, localHostId, localId, relayKind, target]);

  return { prompt, dismiss };
}
