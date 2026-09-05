import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle, DialogTrigger } from '../../../../shared/view/ui';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import type { ChatMessage } from '../../types/types';
import {
  buildConversationExcerpt, excerptCandidates, EXCERPT_CHARACTER_LIMIT, EXCERPT_MESSAGE_LIMIT,
  type ExcerptMessage,
} from '../../utils/conversationExcerpt';

/** Mounted with a host/project/provider/session key so switching targets discards the excerpt. */
export default function ConversationExcerptControl({ messages }: { messages: readonly ChatMessage[] }) {
  const { t } = useTranslation('chat');
  const titleId = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<ExcerptMessage[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [copying, setCopying] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);

  const changeOpen = (next: boolean) => {
    generation.current += 1;
    setOpen(next);
    setCandidates(next ? excerptCandidates(messages) : []);
    setSelected(new Set());
    setPreview(null);
    setFeedback('');
    setCopying(false);
  };
  const review = () => {
    const text = buildConversationExcerpt(candidates, selected, {
      title: t('excerpt.heading'), user: t('excerpt.user'), assistant: t('excerpt.assistant'),
    });
    if (text === null) { setFeedback(t('excerpt.tooLarge')); return; }
    setPreview(text);
    setFeedback('');
  };
  const copy = async () => {
    if (copying || !preview?.trim() || preview.length > EXCERPT_CHARACTER_LIMIT) return;
    const attempt = generation.current;
    setCopying(true);
    const success = await copyTextToClipboard(preview);
    if (generation.current !== attempt) return;
    setCopying(false);
    setFeedback(t(success ? 'excerpt.copied' : 'excerpt.copyFailed'));
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <div className="flex justify-end">
        <DialogTrigger className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Copy className="h-3.5 w-3.5" aria-hidden />{t('excerpt.open')}
        </DialogTrigger>
      </div>
      <DialogContent
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="flex max-h-[90dvh] w-[calc(100vw-1rem)] max-w-2xl flex-col overflow-hidden p-4 sm:p-5"
      >
        <DialogTitle id={titleId} className="not-sr-only text-lg font-semibold">{t('excerpt.open')}</DialogTitle>
        <p id={descriptionId} className="my-2 text-sm text-muted-foreground">{t('excerpt.description')}</p>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {preview === null ? (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-xs text-muted-foreground">{t('excerpt.available', { count: EXCERPT_MESSAGE_LIMIT })}</legend>
              {candidates.length === 0 && <p className="text-sm">{t('excerpt.empty')}</p>}
              {candidates.map((message) => (
                <label key={message.key} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-accent">
                  <input type="checkbox" checked={selected.has(message.key)} className="mt-1 shrink-0"
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(message.key); else next.delete(message.key);
                      setSelected(next); setFeedback('');
                    }} />
                  <span className="min-w-0 text-sm">
                    <span className="block text-xs font-medium text-muted-foreground">{t(`excerpt.${message.role}`)}</span>
                    <span className="block whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.text.slice(0, 240)}{message.text.length > 240 ? '…' : ''}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            <label className="block text-sm font-medium">
              {t('excerpt.preview')}
              <textarea value={preview} disabled={copying} maxLength={EXCERPT_CHARACTER_LIMIT}
                onChange={(event) => { setPreview(event.target.value); setFeedback(''); }}
                className="mt-2 block h-[40dvh] min-h-24 w-full resize-y rounded-md border bg-background p-3 font-mono text-sm font-normal" />
            </label>
          )}
        </div>
        <p role="status" aria-live="polite" className="min-h-6 py-1 text-sm text-muted-foreground">{feedback}</p>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={() => changeOpen(false)}>{t('excerpt.close')}</Button>
          {preview === null ? (
            <Button type="button" disabled={selected.size === 0} onClick={review}>{t('excerpt.review', { count: selected.size })}</Button>
          ) : (
            <>
              <Button type="button" variant="outline" disabled={copying} onClick={() => { setPreview(null); setFeedback(''); }}>{t('excerpt.back')}</Button>
              <Button type="button" disabled={copying || !preview.trim()} onClick={() => void copy()}>{t('excerpt.copy')}</Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
