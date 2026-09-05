import type { ChatMessage } from '../types/types';

export const EXCERPT_MESSAGE_LIMIT = 100;
export const EXCERPT_CHARACTER_LIMIT = 100_000;

export type ExcerptMessage = {
  key: number;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
};

/** Only the visible conversation text is eligible; never expand tools or history. */
export function excerptCandidates(messages: readonly ChatMessage[]): ExcerptMessage[] {
  return messages.flatMap((message, key): ExcerptMessage[] => {
    if ((message.type !== 'user' && message.type !== 'assistant') || message.isThinking
      || message.isToolUse || message.isTaskNotification || typeof message.content !== 'string'
      || !message.content.trim()) return [];
    const date = new Date(message.timestamp);
    return [{
      key,
      role: message.type,
      text: message.content,
      timestamp: Number.isFinite(date.getTime()) ? date.toISOString() : null,
    }];
  }).slice(-EXCERPT_MESSAGE_LIMIT);
}

/** Callers supply translated, fixed labels; arbitrary target metadata is not serialized. */
export function buildConversationExcerpt(
  candidates: readonly ExcerptMessage[],
  selected: ReadonlySet<number>,
  labels: { title: string; user: string; assistant: string },
): string | null {
  const messages = candidates.filter((message) => selected.has(message.key));
  if (messages.length === 0) return null;
  let size = labels.title.length + 2;
  const parts = [labels.title];
  for (const message of messages) {
    const heading = `${labels[message.role]}${message.timestamp ? ` · ${message.timestamp}` : ''}`;
    size += heading.length + message.text.length + 4;
    if (size > EXCERPT_CHARACTER_LIMIT) return null;
    parts.push(`${heading}\n${message.text}`);
  }
  return parts.join('\n\n');
}
