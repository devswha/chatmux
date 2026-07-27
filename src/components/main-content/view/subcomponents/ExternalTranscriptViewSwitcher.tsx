import { MessageSquare, SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type ExternalTranscriptView = 'conversation' | 'cli';

type ExternalTranscriptViewSwitcherProps = {
  mode: ExternalTranscriptView;
  providerLabel: string;
  tmuxName: string;
  onChange: (mode: ExternalTranscriptView) => void;
};

export default function ExternalTranscriptViewSwitcher({
  mode,
  providerLabel,
  tmuxName,
  onChange,
}: ExternalTranscriptViewSwitcherProps) {
  const { t } = useTranslation('chat');
  return (
    <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-border/50 bg-muted/15 px-3 py-1.5">
      <div
        role="tablist"
        aria-label={t('transcript.viewSwitcherLabel', { provider: providerLabel })}
        className="inline-flex items-center rounded-lg border border-border/60 bg-background/80 p-0.5 shadow-sm"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'conversation'}
          onClick={() => onChange('conversation')}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            mode === 'conversation'
              ? 'bg-muted text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden />
          {t('transcript.conversationTab')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'cli'}
          onClick={() => onChange('cli')}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            mode === 'cli'
              ? 'bg-zinc-900 text-zinc-100 shadow-sm dark:bg-zinc-100 dark:text-zinc-900'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <SquareTerminal className="h-3.5 w-3.5" aria-hidden />
          {t('transcript.cliTab')}
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
        <span className="hidden shrink-0 sm:inline">tmux</span>
        <span className="max-w-32 truncate font-mono sm:max-w-52" title={tmuxName}>{tmuxName}</span>
      </div>
    </div>
  );
}
