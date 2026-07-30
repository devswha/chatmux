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
 * Returns only the newest unanswered, single-select transcript question.
 * The server repeats these checks against persisted history and the active
 * native TUI before it sends any selector key.
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
    if (!Array.isArray(questions) || questions.length === 0) return null;
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
