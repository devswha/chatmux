/**
 * Relay-ask derivation for the chat surface.
 *
 * Multi-question asks must use the screen-derived card: their transcript
 * duplicate is suppressed so users cannot mistake inert history rows for the
 * active choices after the native TUI advances to question two. The ask-choice
 * ref bridges transcript-rendered ask cards to the relay composer: the composer
 * registers its choice submitter here, and tapped choices reuse the same
 * validated relay path as typed numbers. Split from the former
 * `ChatInterface.tsx`.
 */

import { useCallback, useMemo, useRef } from 'react';

import { findPendingRelayAsk, findUnansweredRelayAskToolId } from '../utils/pendingRelayAsk';
import type { ChatMessage, ChatInterfaceProps  } from '../types/types';

type RelayAskArgs = {
  isSessionReadOnly: ChatInterfaceProps['isSessionReadOnly'];
  liveSessionKind: ChatInterfaceProps['liveSessionKind'];
  chatMessages: ChatMessage[];
};

export function useChatRelayAsk({
  isSessionReadOnly,
  liveSessionKind,
  chatMessages,
}: RelayAskArgs) {
  const supportsRelayAsk = isSessionReadOnly
    && (liveSessionKind === 'gjc' || liveSessionKind === 'codex' || liveSessionKind === 'omp' || liveSessionKind === 'claude');
  const pendingRelayAsk = useMemo(
    () => supportsRelayAsk ? findPendingRelayAsk(chatMessages) : null,
    [chatMessages, supportsRelayAsk],
  );
  const unansweredRelayAskToolId = useMemo(
    () => supportsRelayAsk ? findUnansweredRelayAskToolId(chatMessages) : null,
    [chatMessages, supportsRelayAsk],
  );
  const suppressedAskToolId = unansweredRelayAskToolId === pendingRelayAsk?.toolId
    ? null
    : unansweredRelayAskToolId;

  const askChoiceSubmitRef = useRef<((choiceNumber: number) => void) | null>(null);
  const handleAskChoiceSelect = useCallback((choiceNumber: number) => {
    askChoiceSubmitRef.current?.(choiceNumber);
  }, []);

  return {
    supportsRelayAsk,
    pendingRelayAsk,
    suppressedAskToolId,
    askChoiceSubmitRef,
    handleAskChoiceSelect,
  };
}
