import { ArrowUpIcon, Check, ChevronDown, ImageIcon, MessageSquareIcon, XIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import {
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTools,
} from '../../../../shared/view/ui';

import type { ChatComposerProps } from './chatComposerTypes';
import TokenUsageSummary from './TokenUsageSummary';

type EffortSelectorProps = Pick<
  ChatComposerProps,
  'availableEffortOptions' | 'effort' | 'onSelectEffort'
>;

function EffortSelector({ availableEffortOptions, effort, onSelectEffort }: EffortSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [position, setPosition] = useState<{ readonly left: number; readonly top: number; readonly maxHeight: number } | null>(null);
  const options = useMemo(() => [{ value: 'default' }, ...availableEffortOptions], [availableEffortOptions]);
  const selectedLabel = effort === 'default' ? 'Default' : effort;
  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: rect.left, top: rect.top - 8, maxHeight: Math.max(96, rect.top - 16) });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node
        && !anchorRef.current?.contains(event.target)
        && !menuRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    updatePosition();
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isOpen, updatePosition]);

  if (availableEffortOptions.length === 0) return null;
  return (
    <div ref={anchorRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => { updatePosition(); setIsOpen((current) => !current); }}
        className="flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-all duration-200 hover:bg-muted"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Select reasoning effort"
        title="Select reasoning effort"
      >
        <span className="hidden text-[11px] text-muted-foreground sm:inline">Effort</span>
        <span className="max-w-16 truncate capitalize sm:max-w-20">{selectedLabel}</span>
        <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && position && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[100] min-w-36 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg"
          style={{ left: position.left, top: position.top, maxHeight: position.maxHeight, transform: 'translateY(-100%)' }}
          role="menu"
        >
          {options.map((option) => {
            const isSelected = option.value === effort;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => { onSelectEffort(option.value); setIsOpen(false); }}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs capitalize transition-colors ${isSelected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'}`}
              >
                <span className="flex h-3 w-3 items-center justify-center">
                  {isSelected && <Check className="h-3 w-3 text-primary" />}
                </span>
                <span>{option.value === 'default' ? 'Default' : option.value}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

type ChatComposerControlsProps = Pick<ChatComposerProps,
  | 'availableEffortOptions' | 'effort' | 'hasInput' | 'input' | 'isLoading'
  | 'onAbortSession' | 'onClearInput' | 'onModeSwitch' | 'onSelectEffort'
  | 'onShowTokenUsage' | 'onSubmit' | 'onToggleCommandMenu' | 'openImagePicker'
  | 'permissionMode' | 'queuedDraft' | 'sendByCtrlEnter' | 'slashCommandsCount' | 'tokenBudget'
>;

export default function ChatComposerControls(props: ChatComposerControlsProps) {
  const { t } = useTranslation('chat');
  const canQueueDraft = props.isLoading && Boolean(props.input.trim());
  const hasQueuedDraft = Boolean(props.queuedDraft);
  const submitHint = canQueueDraft
    ? hasQueuedDraft
      ? t('input.hintText.updateQueued', { defaultValue: 'Enter to update queued message' })
      : t('input.hintText.queue', { defaultValue: 'Enter to queue your next message' })
    : props.sendByCtrlEnter ? t('input.hintText.ctrlEnter') : t('input.hintText.enter');
  const submitAriaLabel = canQueueDraft
    ? hasQueuedDraft
      ? t('input.queue.update', { defaultValue: 'Update queued message' })
      : t('input.queue.sendNext', { defaultValue: 'Queue next message' })
    : props.isLoading ? t('input.stop') : t('input.send');

  return (
    <PromptInputFooter className="gap-1">
      <PromptInputTools className="shrink-0">
        <PromptInputButton tooltip={{ content: t('input.attachImages') }} onClick={props.openImagePicker} aria-label={t('input.attachImages')}>
          <ImageIcon />
        </PromptInputButton>
        <button
          type="button"
          onClick={props.onModeSwitch}
          className={`inline-flex h-8 items-center rounded-lg border px-2 text-xs font-medium transition-all duration-200 sm:px-2.5 ${
            props.permissionMode === 'default'
              ? 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted'
              : props.permissionMode === 'acceptEdits'
                ? 'border-green-300/60 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-600/40 dark:bg-green-900/15 dark:text-green-300 dark:hover:bg-green-900/25'
                : props.permissionMode === 'auto'
                  ? 'border-blue-300/60 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-600/40 dark:bg-blue-900/15 dark:text-blue-300 dark:hover:bg-blue-900/25'
                  : props.permissionMode === 'bypassPermissions'
                    ? 'border-orange-300/60 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-600/40 dark:bg-orange-900/15 dark:text-orange-300 dark:hover:bg-orange-900/25'
                    : 'border-primary/20 bg-primary/5 text-primary hover:bg-primary/10'
          }`}
          title={t('input.clickToChangeMode')}
        >
          <div className="flex items-center gap-1.5">
            <div className={`h-2.5 w-2.5 rounded-full sm:h-1.5 sm:w-1.5 ${
              props.permissionMode === 'default'
                ? 'bg-muted-foreground'
                : props.permissionMode === 'acceptEdits'
                  ? 'bg-green-500'
                  : props.permissionMode === 'auto'
                    ? 'bg-blue-500'
                    : props.permissionMode === 'bypassPermissions'
                      ? 'bg-orange-500'
                      : 'bg-primary'
            }`} />
            <span className="hidden whitespace-nowrap sm:inline">
              {props.permissionMode === 'default' && t('codex.modes.default')}
              {props.permissionMode === 'acceptEdits' && t('codex.modes.acceptEdits')}
              {props.permissionMode === 'auto' && t('codex.modes.auto')}
              {props.permissionMode === 'bypassPermissions' && t('codex.modes.bypassPermissions')}
              {props.permissionMode === 'plan' && t('codex.modes.plan')}
            </span>
          </div>
        </button>
        <EffortSelector availableEffortOptions={props.availableEffortOptions} effort={props.effort} onSelectEffort={props.onSelectEffort} />
        <TokenUsageSummary usage={props.tokenBudget} onClick={props.onShowTokenUsage} />
        <PromptInputButton tooltip={{ content: t('input.showAllCommands') }} onClick={props.onToggleCommandMenu} aria-label={t('input.showAllCommands')} className="relative">
          <MessageSquareIcon />
          {props.slashCommandsCount > 0 && <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">{props.slashCommandsCount}</span>}
        </PromptInputButton>
        {props.hasInput && <PromptInputButton tooltip={{ content: t('input.clearInput', { defaultValue: 'Clear input' }) }} onClick={props.onClearInput} className="hidden sm:flex"><XIcon /></PromptInputButton>}
      </PromptInputTools>
      <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
        <div className={`hidden min-w-0 text-right text-xs leading-4 text-muted-foreground/50 transition-opacity duration-200 lg:block ${props.input.trim() && !canQueueDraft ? 'opacity-0' : 'opacity-100'}`}>{submitHint}</div>
        <PromptInputSubmit
          onClick={canQueueDraft ? (event: MouseEvent<HTMLButtonElement>) => { event.preventDefault(); props.onSubmit(event); } : props.isLoading ? props.onAbortSession : undefined}
          disabled={props.isLoading ? false : !props.input.trim()}
          aria-label={submitAriaLabel}
          title={submitAriaLabel}
          className="h-9 w-9"
        >
          {canQueueDraft ? <ArrowUpIcon className="h-4 w-4" /> : undefined}
        </PromptInputSubmit>
      </div>
    </PromptInputFooter>
  );
}
