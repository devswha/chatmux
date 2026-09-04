import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CHAT_COMPOSER_MIN_HEIGHT,
  clampChatComposerHeight,
  getChatComposerMaxHeight,
  getDraggedChatComposerHeight,
} from '../../utils/chatComposerResize';

type ChatComposerResizeHandleProps = {
  readonly textareaRef: RefObject<HTMLTextAreaElement>;
  readonly textareaHeight: number | null;
  readonly onHeightChange: (height: number) => void;
  readonly onHeightReset: () => void;
};

type PointerDrag = {
  pointerId: number;
  startHeight: number;
  startY: number;
};

function viewportHeight(): number {
  if (typeof window === 'undefined') {
    return 960;
  }
  return window.visualViewport?.height ?? window.innerHeight;
}

export default function ChatComposerResizeHandle({
  textareaRef,
  textareaHeight,
  onHeightChange,
  onHeightReset,
}: ChatComposerResizeHandleProps) {
  const { t } = useTranslation('chat');
  const dragRef = useRef<PointerDrag | null>(null);
  const label = t('input.resizeHeight', {
    defaultValue: 'Drag to resize the message input. Double-click to reset.',
  });
  const currentHeight = clampChatComposerHeight(
    textareaHeight
      ?? textareaRef.current?.getBoundingClientRect().height
      ?? CHAT_COMPOSER_MIN_HEIGHT,
    viewportHeight(),
  );

  const finishPointerDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    const startHeight = textareaRef.current?.getBoundingClientRect().height ?? currentHeight;
    dragRef.current = {
      pointerId: event.pointerId,
      startHeight,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    onHeightChange(getDraggedChatComposerHeight(
      drag.startHeight,
      drag.startY,
      event.clientY,
      viewportHeight(),
    ));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Home') {
      event.preventDefault();
      onHeightReset();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const delta = event.shiftKey ? 48 : 24;
    onHeightChange(clampChatComposerHeight(
      currentHeight + (event.key === 'ArrowUp' ? delta : -delta),
      viewportHeight(),
    ));
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={CHAT_COMPOSER_MIN_HEIGHT}
      aria-valuemax={getChatComposerMaxHeight(viewportHeight())}
      aria-valuenow={currentHeight}
      tabIndex={0}
      title={label}
      className="group flex h-3 cursor-ns-resize touch-none select-none items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      onDoubleClick={onHeightReset}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      onLostPointerCapture={() => { dragRef.current = null; }}
    >
      <span className="h-1 w-10 rounded-full bg-border transition-colors group-hover:bg-muted-foreground/60 group-focus-visible:bg-primary" />
    </div>
  );
}
