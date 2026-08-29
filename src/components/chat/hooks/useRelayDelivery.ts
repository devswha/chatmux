/**
 * Delivery for the relay composer: one send path and one interrupt path.
 *
 * Every answer — typed text, a typed choice number, a tapped choice, a custom
 * continuation — leaves through the single `send` below, so validation and status
 * reporting cannot diverge between them. `routeRelayAnswer` decides which question
 * the answer belongs to; this hook only carries it to the verified tmux target and
 * reports what the transport said.
 */

import { useCallback, useRef, useState } from 'react';

import type { TmuxPaneTarget } from '../../../../shared/tmux';
import { useFleetHostCatalog } from '../../../fleet/discovery/FleetHostCatalogContext';
import { useFleetHost } from '../../../fleet/FleetSessionRoute';
import type { PendingRelayAsk } from '../utils/pendingRelayAsk';
import { routeRelayAnswer, type RelayAnswerRoute } from '../utils/relayAnswer';
import {
  dispatchRelay,
  interruptRelay,
  type RelayTransportTarget,
} from '../utils/relayTransport';
import type { RelayDeliveryStatus } from '../view/subcomponents/RelayStatusLine';

import type { RelayInteractivePrompt } from './useRelayInteractivePrompt';

export type RelayDeliveryInput = {
  readonly relayKind: string;
  readonly target: TmuxPaneTarget;
  readonly transcriptSessionId: string | null;
  readonly prompt: RelayInteractivePrompt | null;
  readonly dismissPrompt: () => void;
  readonly ask: PendingRelayAsk | null;
  readonly canInterrupt: boolean;
  /** Copy for each outcome, so this hook stays free of translation lookups. */
  readonly text: RelayDeliveryText;
};

export type RelayDeliveryText = {
  readonly selectionNumberRequired: (max: number) => string;
  readonly multiSelectionNumberRequired: string;
  readonly towerUnavailable: string;
  readonly sendFailed: string;
  readonly queued: string;
  readonly delivered: string;
  readonly selectionDelivered: string;
  readonly customInputReady: string;
  readonly interruptSent: string;
  readonly interruptFailed: string;
};

type RelayResponse = {
  readonly ok?: boolean;
  readonly reachable?: boolean;
  readonly queued?: boolean;
  readonly detail?: string;
  readonly action?: 'option' | 'other' | 'cancel';
};

const IDLE: RelayDeliveryStatus = { kind: 'idle' };

function invalidText(input: RelayDeliveryInput, route: Extract<RelayAnswerRoute, { kind: 'invalid' }>): string {
  return route.multiSelect
    ? input.text.multiSelectionNumberRequired
    : input.text.selectionNumberRequired(route.max);
}

type RoutedRelayDeliveryInput = Omit<RelayDeliveryInput, 'target'> & Readonly<{
  readonly target: RelayTransportTarget;
}>;

export function useRelayDelivery(input: RelayDeliveryInput) {
  const fleetHost = useFleetHost();
  const { catalog } = useFleetHostCatalog();
  const hostId = fleetHost.activeSession?.hostId;
  const remotePane = hostId && hostId !== fleetHost.localHostId
    ? catalog.hosts.get(hostId)?.rows.panes.find((pane) => (
      pane.process !== null
      && pane.presence === 'present'
      && pane.tmux.socketPath === input.target.tmux.socketPath
      && pane.tmux.sessionId === input.target.tmux.sessionId
      && pane.tmux.windowId === input.target.tmux.windowId
      && pane.tmux.paneId === input.target.tmux.paneId
      && pane.process.pid === input.target.process.pid
      && pane.process.startedAtMs === input.target.process.startedAtMs
    ))
    : undefined;
  const routedInput: RoutedRelayDeliveryInput = remotePane?.process && hostId
    ? { ...input, target: { ...input.target, hostId, localId: remotePane.localId, lane: remotePane.lane } }
    : input;
  const [status, setStatus] = useState<RelayDeliveryStatus>(IDLE);
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [customAskToolId, setCustomAskToolId] = useState<string | null>(null);
  const [customPromptId, setCustomPromptId] = useState<string | null>(null);
  const { ask, prompt } = input;
  const awaitingAskCustom = ask !== null && customAskToolId === ask.toolId;
  const awaitingPromptCustom = prompt !== null && customPromptId === prompt.id;
  // The transport target and copy are read at call time, so `send`/`interrupt`
  // keep a stable identity across renders and the choice-submitter bridge is not
  // reinstalled on every keystroke.
  const inputRef = useRef<RoutedRelayDeliveryInput>(routedInput);
  inputRef.current = routedInput;
  const sendingRef = useRef(false);

  /** @returns whether the draft was consumed and should be cleared. */
  const send = useCallback(async (draft: string, override?: string): Promise<boolean> => {
    const current = inputRef.current;
    const message = (override ?? draft).trim();
    if (message.length === 0 || sendingRef.current) {
      return false;
    }
    const route = routeRelayAnswer({
      message,
      prompt: current.prompt === null
        ? null
        : {
          optionCount: current.prompt.options.length,
          customOptionNumber: current.prompt.customOptionNumber,
          multiSelect: current.prompt.multiSelect,
        },
      awaitingPromptCustom: current.prompt !== null && customPromptId === current.prompt.id,
      ask: current.ask === null ? null : { maxChoiceNumber: current.ask.maxChoiceNumber },
      awaitingAskCustom: current.ask !== null && customAskToolId === current.ask.toolId,
    });
    if (route.kind === 'invalid') {
      setStatus({ kind: 'error', text: invalidText(current, route) });
      return false;
    }
    sendingRef.current = true;
    setStatus({ kind: 'sending' });
    try {
      const response = await dispatchRelay({
        relayKind: current.relayKind,
        target: current.target,
        transcriptSessionId: current.transcriptSessionId,
        promptId: current.prompt?.id ?? '',
        askToolId: current.ask?.toolId ?? '',
      }, route, message);
      const body = await response.json().catch(() => null);
      const data = (body?.data ?? body ?? {}) as RelayResponse;
      const apiError = typeof body?.error?.message === 'string'
        ? body.error.message
        : typeof body?.message === 'string' ? body.message : null;
      // ok === false covers "tower reachable but refused" — the server wraps a
      // tower non-2xx in HTTP 200, so without it a failed relay reported success
      // and silently discarded the draft.
      if (!response.ok || data.reachable === false || data.ok === false) {
        setStatus({
          kind: 'error',
          text: data.reachable === false ? current.text.towerUnavailable : data.detail || apiError || current.text.sendFailed,
        });
        return false;
      }
      if (route.kind === 'interactive-choices' && data.action === 'other') {
        setCustomPromptId(current.prompt?.id ?? null);
        setStatus({ kind: 'ok', text: current.text.customInputReady });
      } else if (route.kind === 'interactive-choices' || route.kind === 'interactive-custom') {
        current.dismissPrompt();
        setCustomPromptId(null);
        setStatus({ kind: 'ok', text: current.text.selectionDelivered });
      } else if (route.kind === 'ask-choice' && data.action === 'other') {
        setCustomAskToolId(current.ask?.toolId ?? null);
        setStatus({ kind: 'ok', text: current.text.customInputReady });
      } else {
        setCustomAskToolId(null);
        setStatus(data.queued ? { kind: 'queued', text: current.text.queued } : { kind: 'ok', text: current.text.delivered });
      }
      // A tapped choice must not discard an unrelated typed draft.
      return override === undefined;
    } catch {
      setStatus({ kind: 'error', text: current.text.sendFailed });
      return false;
    } finally {
      sendingRef.current = false;
    }
  }, [customAskToolId, customPromptId]);

  const interrupt = useCallback(async () => {
    const current = inputRef.current;
    if (!current.canInterrupt || isInterrupting) {
      return;
    }
    setIsInterrupting(true);
    try {
      const response = await interruptRelay({ relayKind: current.relayKind, target: current.target });
      const body = await response.json().catch(() => null);
      const data = (body?.data ?? body ?? {}) as RelayResponse;
      setStatus(!response.ok || data.ok === false
        ? { kind: 'error', text: current.text.interruptFailed }
        : { kind: 'ok', text: current.text.interruptSent });
    } catch {
      setStatus({ kind: 'error', text: current.text.interruptFailed });
    } finally {
      setIsInterrupting(false);
    }
  }, [isInterrupting]);

  return {
    status,
    isInterrupting,
    awaitingCustomInput: awaitingAskCustom || awaitingPromptCustom,
    send,
    interrupt,
    forgetAsk: setCustomAskToolId,
    forgetPrompt: setCustomPromptId,
  };
}
