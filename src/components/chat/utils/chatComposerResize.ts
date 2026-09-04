export const CHAT_COMPOSER_MIN_HEIGHT = 56;
export const CHAT_COMPOSER_MAX_HEIGHT = 480;
export const CHAT_COMPOSER_MAX_VIEWPORT_RATIO = 0.5;

export function getChatComposerMaxHeight(viewportHeight: number): number {
  const safeViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0
    ? viewportHeight
    : CHAT_COMPOSER_MAX_HEIGHT / CHAT_COMPOSER_MAX_VIEWPORT_RATIO;
  return Math.max(
    CHAT_COMPOSER_MIN_HEIGHT,
    Math.min(CHAT_COMPOSER_MAX_HEIGHT, Math.floor(safeViewportHeight * CHAT_COMPOSER_MAX_VIEWPORT_RATIO)),
  );
}

export function clampChatComposerHeight(height: number, viewportHeight: number): number {
  const safeHeight = Number.isFinite(height) ? height : CHAT_COMPOSER_MIN_HEIGHT;
  return Math.max(
    CHAT_COMPOSER_MIN_HEIGHT,
    Math.min(getChatComposerMaxHeight(viewportHeight), Math.round(safeHeight)),
  );
}

export function getDraggedChatComposerHeight(
  startHeight: number,
  startPointerY: number,
  currentPointerY: number,
  viewportHeight: number,
): number {
  return clampChatComposerHeight(
    startHeight + startPointerY - currentPointerY,
    viewportHeight,
  );
}

export function parseStoredChatComposerHeight(value: string | null): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
