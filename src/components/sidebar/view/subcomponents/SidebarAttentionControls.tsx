import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import type { SessionAttentionFilter } from '../../utils/sessionAttention';

type Props = {
  filter: SessionAttentionFilter;
  counts: Record<Exclude<SessionAttentionFilter, 'all'>, number>;
  hasNext: boolean;
  onFilter: (filter: SessionAttentionFilter) => void;
  onNext: () => void;
};

export default function SidebarAttentionControls({ filter, counts, hasNext, onFilter, onNext }: Props) {
  const { t } = useTranslation('sidebar');
  const scopeId = useId();
  return (
    <div className="space-y-1 border-b border-border/60 px-2 py-2">
      <p id={scopeId} className="text-[11px] text-muted-foreground">{t('attention.scope')}</p>
      <div role="group" aria-label={t('attention.filterLabel')} aria-describedby={scopeId} className="flex flex-wrap gap-1">
        {(['all', 'input', 'failure', 'connection'] as const).map((value) => (
          <button
            key={value}
            type="button"
            data-attention-filter={value}
            aria-pressed={filter === value}
            onClick={() => onFilter(value)}
            className={cn(
              'min-h-11 rounded-md border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              filter === value ? 'border-primary/30 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {t(`attention.${value}`)}{value !== 'all' && ` (${counts[value]})`}
          </button>
        ))}
      </div>
      <button
        type="button"
        data-attention-next
        disabled={!hasNext}
        aria-describedby={scopeId}
        onClick={onNext}
        className="flex min-h-11 w-full items-center justify-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ArrowDown className="h-3.5 w-3.5" aria-hidden />
        {t(filter === 'all' ? 'attention.nextAttention' : 'attention.nextMatch')}
      </button>
    </div>
  );
}
