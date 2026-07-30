import type { CSSProperties, ReactNode } from 'react';
import { GripVertical } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { cn } from '../../../../lib/utils';

type SortableSessionRowProps = {
  id: string;
  dragLabel: string;
  disabled?: boolean;
  selected?: boolean;
  content: ReactNode;
  actions?: ReactNode;
  details?: ReactNode;
};

export default function SortableSessionRow({
  id,
  dragLabel,
  disabled = false,
  selected = false,
  content,
  actions,
  details,
}: SortableSessionRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'relative rounded-md transition-colors hover:bg-muted/50',
        selected && 'bg-primary/5',
        isDragging && 'bg-muted/80 opacity-70 shadow-sm',
      )}
    >
      <div className="flex items-start">
        <button
          type="button"
          title={dragLabel}
          aria-label={dragLabel}
          {...attributes}
          {...listeners}
          disabled={disabled}
          className={cn(
            'flex w-7 shrink-0 self-stretch touch-none items-start justify-center rounded pt-2 text-muted-foreground/45 transition-colors',
            'cursor-grab hover:bg-muted hover:text-muted-foreground active:cursor-grabbing',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            disabled && 'cursor-default opacity-30',
          )}
        >
          <GripVertical className="h-3.5 w-3.5" aria-hidden />
        </button>
        {content}
        {actions}
      </div>
      {details}
    </div>
  );
}
