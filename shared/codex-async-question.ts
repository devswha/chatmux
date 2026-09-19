export const CODEX_ASYNC_QUESTION_KIND = 'codex-async-question' as const;

export type CodexAsyncQuestionMarker = {
  kind: typeof CODEX_ASYNC_QUESTION_KIND;
  messageId?: string;
};

export function isCodexAsyncQuestionInput(value: unknown): boolean {
  let input = value;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      return false;
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const marker = (input as { _chatmux?: unknown })._chatmux;
  return Boolean(
    marker
    && typeof marker === 'object'
    && !Array.isArray(marker)
    && (marker as { kind?: unknown }).kind === CODEX_ASYNC_QUESTION_KIND,
  );
}
