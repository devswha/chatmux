import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, MessageSquarePlus } from 'lucide-react';

import { api } from '../../../../utils/api';
import type { TmuxPaneTarget } from '../../../../../shared/tmux';

/**
 * How long a sent-but-unpromoted idle session may sit in "promoting" before
 * the composer fails closed. gjc opens its transcript on the first message,
 * and the 5s live poll then replaces the synthetic idle row with a real LIVE
 * row (this component unmounts) — observed promotion latency is one or two
 * poll cycles, so 45s only fires when something is actually wrong.
 */
export const PROMOTION_TIMEOUT_MS = 45_000;

export type IdleComposerStatus =
  | { kind: 'collapsed' }
  | { kind: 'composing' }
  | { kind: 'sending' }
  | { kind: 'promoting' }
  | { kind: 'error'; text: string };

type SidebarIdleComposerProps = {
  tmuxName: string;
  /** Exact pane and process generation observed with this row. */
  target: TmuxPaneTarget | null;
  /** Test-only: SSR tests cannot drive internal state, so they pin renders per status. */
  initialStatus?: IdleComposerStatus;
};

/**
 * First-message composer for a '대기' (idle, pre-transcript) gjc pane.
 *
 * The tower's /send injects keys into the pane whether or not a transcript
 * exists, and the server's lineage gate already admits idle rows (they are
 * subtree-proven). Sending the first message makes gjc open its transcript;
 * the live poll then promotes the row to LIVE and this component unmounts
 * with its row. Send failures and a promotion that never materializes both
 * fail closed back to an editable composer with an explanation.
 */
export default function SidebarIdleComposer({ tmuxName, target, initialStatus }: SidebarIdleComposerProps) {
  const { t } = useTranslation('sidebar');
  const [status, setStatus] = useState<IdleComposerStatus>(initialStatus ?? { kind: 'collapsed' });
  const [message, setMessage] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Promotion removes the idle row (and this component) — clear the pending
  // fail-closed timer so it cannot fire against unmounted state.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const send = async () => {
    const text = message.trim();
    if (!text || status.kind === 'sending' || status.kind === 'promoting') {
      return;
    }
    if (!target) {
      setStatus({ kind: 'error', text: t('idleComposer.targetReplaced') });
      return;
    }
    setStatus({ kind: 'sending' });
    try {
      const response = await api.liveSessionSend(target.tmux, target.process, text);
      const body = await response.json().catch(() => null);
      const data = (body?.data ?? body ?? {}) as { ok?: boolean; reachable?: boolean; detail?: string };
      if (response.ok && data.ok) {
        setStatus({ kind: 'promoting' });
        timerRef.current = setTimeout(() => {
          setStatus({
            kind: 'error',
            text: t('idleComposer.promotionTimeout'),
          });
        }, PROMOTION_TIMEOUT_MS);
        return;
      }
      const errorText = data.reachable === false
        ? t('idleComposer.towerUnavailable')
        : (typeof (body as { error?: unknown } | null)?.error === 'string' && (body as { error: string }).error)
          || data.detail
          || t('idleComposer.sendFailed');
      setStatus({ kind: 'error', text: errorText });
    } catch {
      setStatus({ kind: 'error', text: t('idleComposer.sendFailed') });
    }
  };

  if (status.kind === 'collapsed') {
    return (
      <div className="px-2 pb-1.5 pl-[1.375rem]">
        <button
          type="button"
          onClick={() => setStatus({ kind: 'composing' })}
          className="flex items-center gap-1 text-[11px] text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-400"
        >
          <MessageSquarePlus className="h-3 w-3" aria-hidden />
          {t('idleComposer.sendFirstMessage')}
        </button>
      </div>
    );
  }

  if (status.kind === 'promoting') {
    return (
      <div className="flex items-center gap-1.5 px-2 pb-1.5 pl-[1.375rem] text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        {t('idleComposer.waitingPromotion')}
      </div>
    );
  }

  const isSending = status.kind === 'sending';
  return (
    <div className="space-y-1 px-2 pb-1.5 pl-[1.375rem]">
      {status.kind === 'error' && (
        <p className="text-[11px] text-red-500">{status.text}</p>
      )}
      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
        placeholder={t('idleComposer.placeholder', { name: tmuxName })}
        rows={2}
        disabled={isSending}
        className="w-full resize-none rounded-md border border-border bg-transparent px-2 py-1.5 text-xs outline-none focus:border-blue-500/60 disabled:opacity-60"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => { setStatus({ kind: 'collapsed' }); }}
          disabled={isSending}
          className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {t('idleComposer.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void send()}
          disabled={isSending || !message.trim()}
          className="rounded-md bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSending ? t('idleComposer.sending') : t('idleComposer.send')}
        </button>
      </div>
    </div>
  );
}
