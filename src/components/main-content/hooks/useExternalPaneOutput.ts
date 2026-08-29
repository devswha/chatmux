/**
 * Read-only pane-output mirror for the transcript CLI tab: one REST read for
 * the rollback path, then the pane stream when available, with a bounded poll
 * as the fallback while the stream is unsubscribed. Split from the former
 * `MainContent.tsx`.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { paneSubscriptionKey } from '../../../../shared/tmux';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { api } from '../../../utils/api';
import type { ServerEvent } from '../../../contexts/WebSocketContext';
import { paneStreamFallbackNeeded, paneStreamFrame } from '../view/externalAttachTargets';

import type { TranscriptCliTarget } from './useTranscriptCliTarget';

export function useExternalPaneOutput(externalOutputTarget: TranscriptCliTarget | null) {
  const { t } = useTranslation('chat');
  const { isConnected, sendMessage, subscribe } = useWebSocket();
  const [externalPaneOutput, setExternalPaneOutput] = useState('');
  const [externalPaneError, setExternalPaneError] = useState('');

  // The polling effect is keyed on a stable identity STRING, not the target
  // object: upstream props re-derive objects freely, and an identity-churned
  // dep would tear the effect down every render — blanking the pane for one
  // fetch round-trip each time (visible flicker). The ref feeds the interval
  // the latest equivalent object without retriggering the effect.
  const externalOutputTargetRef = useRef(externalOutputTarget);
  useEffect(() => {
    externalOutputTargetRef.current = externalOutputTarget;
  });
  const externalOutputTargetKey = externalOutputTarget
    ? paneSubscriptionKey(externalOutputTarget.lane, externalOutputTarget.tmux, externalOutputTarget.process)
    : null;

  useEffect(() => {
    if (!externalOutputTargetKey) {
      setExternalPaneOutput('');
      setExternalPaneError('');
      return undefined;
    }

    let cancelled = false;
    let subscriptionId: string | null = null;
    let streamSubscribed = false;
    let controller: AbortController | null = null;
    const loadOutput = async () => {
      const target = externalOutputTargetRef.current;
      if (!target) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = target.lane === 'live'
          ? await api.liveSessionOutput(target.tmux, target.process, controller.signal)
          : await api.externalCliSessionOutput(target.tmux, target.process, controller.signal);
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (response.ok) {
          setExternalPaneOutput(typeof payload?.data?.output === 'string' ? payload.data.output : '');
          setExternalPaneError('');
        } else {
          // Keep the last frame: the error panel replaces the view, and a
          // transient failure recovering on the next tick should not flash
          // the empty state in between.
          setExternalPaneError(
            payload?.error?.message
              ?? t('transcript.cliLoadFailed'),
          );
        }
      } catch (error) {
        if (!cancelled && !(error instanceof DOMException && error.name === 'AbortError')) {
          setExternalPaneError(t('transcript.cliConnectionFailed'));
        }
      }
    };

    setExternalPaneOutput('');
    setExternalPaneError('');
    // One REST read preserves the rollback path when a stream is unavailable.
    void loadOutput();
    const unsubscribe = subscribe((event: ServerEvent) => {
      const frame = paneStreamFrame(event, externalOutputTargetKey, subscriptionId);
      if (!frame || cancelled) return;
      subscriptionId = frame.subscriptionId;
      streamSubscribed = true;
      if (frame.invalidated) {
        setExternalPaneError(t('transcript.cliLoadFailed'));
      } else if (typeof frame.output === 'string') {
        setExternalPaneOutput(frame.output);
        setExternalPaneError('');
      }
    });
    if (isConnected) {
      const target = externalOutputTargetRef.current;
      if (target) sendMessage({
        type: 'pane.subscribe',
        protocolVersion: 1,
        lane: target.lane,
        tmux: target.tmux,
        process: target.process,
      });
    }
    const fallbackTimer = window.setInterval(() => {
      if (paneStreamFallbackNeeded(isConnected, streamSubscribed)) void loadOutput();
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(fallbackTimer);
      unsubscribe();
      if (subscriptionId) sendMessage({ type: 'pane.unsubscribe', subscriptionId });
      controller?.abort();
    };
  }, [externalOutputTargetKey, isConnected, sendMessage, subscribe, t]);

  return { externalPaneOutput, externalPaneError };
}
