import type { ChatMessage } from '../types/types';

export type PendingRelayAsk = {
  toolId: string;
  maxChoiceNumber: number;
};

function parseInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}


/**
 * Identifies the newest unanswered AskUserQuestion tool call even when its
 * multi-question shape cannot be answered from transcript data alone.
 */
export function findUnansweredRelayAskToolId(messages: readonly ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message.isToolUse || message.toolName !== 'AskUserQuestion') continue;
    return typeof message.toolId === 'string' && message.toolId && !message.toolResult
      ? message.toolId
      : null;
  }
  return null;
}
/**
 * Returns only the newest unanswered, single-select transcript question, and
 * only when the ask carries exactly one question. Multi-question asks lose
 * the active-question identity in this summary, so they stay on the
 * screen-derived interactive prompt, which always shows the question the
 * native TUI is currently asking. The server repeats these checks against
 * persisted history and the active native TUI before it sends any selector
 * key.
 */
export function findPendingRelayAsk(messages: readonly ChatMessage[]): PendingRelayAsk | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message.isToolUse || message.toolName !== 'AskUserQuestion') continue;
    if (typeof message.toolId !== 'string' || !message.toolId || message.toolResult) return null;
    const input = parseInput(message.toolInput);
    const questions = input && typeof input === 'object' && !Array.isArray(input)
      ? (input as { questions?: unknown }).questions
      : null;
    if (!Array.isArray(questions) || questions.length !== 1) return null;
    let maxChoiceNumber = 0;
    for (const rawQuestion of questions) {
      if (!rawQuestion || typeof rawQuestion !== 'object' || Array.isArray(rawQuestion)) return null;
      const question = rawQuestion as {
        question?: unknown;
        options?: unknown;
        multi?: unknown;
        multiSelect?: unknown;
      };
      if (
        typeof question.question !== 'string'
        || !question.question.trim()
        || question.multi === true
        || question.multiSelect === true
        || !Array.isArray(question.options)
        || question.options.length === 0
      ) return null;
      maxChoiceNumber = Math.max(maxChoiceNumber, question.options.length + 1);
    }
    return { toolId: message.toolId, maxChoiceNumber };
  }
  return null;
}
