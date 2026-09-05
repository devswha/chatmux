import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ListFilter } from 'lucide-react';

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
  const filterRef = useRef<HTMLSelectElement>(null);
  const [focusedControl, setFocusedControl] = useState<'filter' | 'next' | null>(null);
  useLayoutEffect(() => {
    if (!hasNext && focusedControl === 'next') filterRef.current?.focus();
  }, [hasNext, focusedControl]);
  // An idle list does not need an attention toolbar. Keep an active filter
  // available after its last match clears, and retain keyboard focus until blur.
  if (filter === 'all' && !Object.values(counts).some((count) => count > 0) && focusedControl === null) return null;

  return (
    <div
      className="flex items-center gap-1 px-2 pt-1"
      data-attention-toolbar
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedControl(null);
      }}
    >
      <span id={scopeId} className="sr-only">{t('attention.scope')}</span>
      <label className="relative min-w-0 flex-1">
        <ListFilter className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <select
          ref={filterRef}
          data-attention-filter-select
          value={filter}
          aria-label={t('attention.filterLabel')}
          aria-describedby={scopeId}
          onFocus={() => setFocusedControl('filter')}
          onChange={(event) => onFilter(event.target.value as SessionAttentionFilter)}
          className="min-h-11 w-full rounded-md border-0 bg-background py-1 pl-7 pr-2 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
        >
          {(['all', 'input', 'failure', 'connection'] as const).map((value) => (
            <option key={value} value={value}>
              {t(`attention.${value}`)}{value !== 'all' && ` (${counts[value]})`}
            </option>
          ))}
        </select>
      </label>
      {(hasNext || focusedControl === 'next') && (
        <button
          type="button"
          data-attention-next
          aria-disabled={!hasNext}
          aria-label={t(filter === 'all' ? 'attention.nextAttention' : 'attention.nextMatch')}
          title={t(filter === 'all' ? 'attention.nextAttention' : 'attention.nextMatch')}
          aria-describedby={scopeId}
          onFocus={() => setFocusedControl('next')}
          onClick={() => { if (hasNext) onNext(); }}
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8 md:min-w-8"
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
