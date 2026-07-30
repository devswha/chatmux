import type { NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import type { TmuxRunner } from './builtin-relay.service.js';
import {
  captureTmuxPane,
  sendTmuxSelectionKeys,
  sendToTmuxPane,
  type TmuxSelectionKey,
} from './tmux-pane-actions.service.js';
import type { VerifiedTmuxActionTarget } from './tmux-fresh-verifier.service.js';

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const GJC_NAVIGATION_HINT_RE = /up\/down navigate\s+enter select/i;
const GJC_CUSTOM_HINT_RE = /enter submit\s+esc back to options/i;
const CODEX_SELECTION_HINT_RE = /tab to add notes.*enter to submit answer.*esc to interrupt/i;
const CODEX_CUSTOM_HINT_RE = /tab or esc to clear notes.*enter to submit answer/i;
const OMP_SELECTION_HINT_RE = /enter select.*↑\/↓ move.*esc cancel/i;
const OMP_CUSTOM_HINT_RE = /enter or ctrl\+q submit.*esc cancel/i;
const CLAUDE_SELECTION_HINT_RE = /enter to select.*↑\/↓ to navigate.*esc to cancel/i;
const CLAUDE_CUSTOM_HINT_RE = /ctrl\+g to edit in vs code/i;
const GJC_OTHER_LABEL = 'Other (type your own)';
const CODEX_OTHER_LABEL = 'None of the above';
const OMP_OTHER_LABEL = 'Other (type your own)';
const CLAUDE_OTHER_LABEL = 'Type something.';
const CLAUDE_CHAT_LABEL = 'Chat about this';

export type TmuxAskKind = 'gjc' | 'codex' | 'omp' | 'claude';
export type TmuxAskQuestion = {
  question: string;
  options: Array<{ label: string }>;
};
export type PendingTmuxAsk = {
  toolId: string;
  questions: TmuxAskQuestion[];
};
export type TmuxAskAction = 'option' | 'other' | 'cancel';

type AskSelection = {
  action: TmuxAskAction;
  delta: number;
  label: string;
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readQuestions(value: unknown): TmuxAskQuestion[] | null {
  const input = parseToolInput(value);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 32) return null;

  const parsed: TmuxAskQuestion[] = [];
  for (const raw of questions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as {
      question?: unknown;
      options?: unknown;
      multi?: unknown;
      multiSelect?: unknown;
    };
    if (item.multi === true || item.multiSelect === true) return null;
    const question = typeof item.question === 'string' ? item.question.trim() : '';
    if (!question || question.length > 2_000 || !Array.isArray(item.options)) return null;
    if (item.options.length === 0 || item.options.length > 32) return null;
    const options: Array<{ label: string }> = [];
    for (const rawOption of item.options) {
      if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) return null;
      const label = typeof (rawOption as { label?: unknown }).label === 'string'
        ? (rawOption as { label: string }).label.trim()
        : '';
      if (!label || label.length > 500) return null;
      options.push({ label });
    }
    parsed.push({ question, options });
  }
  return parsed;
}

/**
 * Finds the newest unanswered single-select AskUserQuestion in transcript
 * history. Exact tool ids prevent an older prompt from authorizing a newer
 * pane action.
 */
export function findPendingTmuxAsk(
  messages: readonly NormalizedMessage[],
  requestedToolId?: string,
): PendingTmuxAsk | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.kind !== 'tool_use' || message.toolName !== 'AskUserQuestion') continue;
    // Once the newest ask is completed or malformed, never fall back to an
    // older unanswered-looking transcript entry.
    if (!message.toolId || message.toolResult) return null;
    if (requestedToolId && message.toolId !== requestedToolId) return null;
    const questions = readQuestions(message.toolInput);
    return questions ? { toolId: message.toolId, questions } : null;
  }
  return null;
}

function validateSelectionInput(question: TmuxAskQuestion, optionIndex: number): string[] | null {
  const labels = question.options.map((option) => option.label.trim());
  if (
    !Number.isInteger(optionIndex)
    || optionIndex < -1
    || optionIndex > labels.length
    || labels.length === 0
    || labels.some((label) => !label)
  ) {
    return null;
  }
  return labels;
}

function questionIsVisible(lines: string[], start: number, question: string): boolean {
  const context = normalizeText(lines.slice(Math.max(0, start - 12), start).join(' '));
  return context.includes(normalizeText(question));
}

type MenuLine = { text: string; selected: boolean };

function parseGjcMenuLine(rawLine: string): MenuLine {
  let text = rawLine.replace(ANSI_RE, '').trim();
  if (text.startsWith('│')) text = text.slice(1);
  if (text.endsWith('│')) text = text.slice(0, -1);
  text = text.trim();
  const selected = text.startsWith('❯');
  if (selected) text = text.slice(1).trim();
  return { text, selected };
}

export function parseGjcAskSelectionScreen(
  screen: string,
  question: TmuxAskQuestion,
  optionIndex: number,
): AskSelection | null {
  const labels = validateSelectionInput(question, optionIndex);
  if (!labels) return null;
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/).map(parseGjcMenuLine);
  let hintIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (GJC_NAVIGATION_HINT_RE.test(lines[index].text)) {
      hintIndex = index;
      break;
    }
  }
  if (hintIndex < 0) return null;

  for (
    let start = hintIndex - labels.length;
    start >= Math.max(0, hintIndex - labels.length - 8);
    start -= 1
  ) {
    if (!labels.every((label, offset) => lines[start + offset]?.text === label)) continue;
    if (!lines.slice(Math.max(0, start - 8), start).some((line) =>
      line.text === question.question.trim())) continue;
    if (lines[start + labels.length]?.text !== GJC_OTHER_LABEL) continue;
    const selectedOffset = lines
      .slice(start, Math.min(hintIndex, start + labels.length + 2))
      .findIndex((line) => line.selected);
    if (selectedOffset < 0) return null;
    const selectedIndex = start + selectedOffset;
    if (optionIndex === -1) return { action: 'cancel', delta: 0, label: 'Cancel' };
    if (optionIndex === labels.length) {
      return {
        action: 'other',
        delta: start + labels.length - selectedIndex,
        label: 'Direct input',
      };
    }
    return {
      action: 'option',
      delta: start + optionIndex - selectedIndex,
      label: labels[optionIndex],
    };
  }
  return null;
}

type CodexOptionLine = { number: number; text: string; selected: boolean };

function parseCodexOptionLine(line: string): CodexOptionLine | null {
  const match = line.trim().match(/^([›>❯])?\s*(\d+)\.\s+(.+)$/);
  if (!match) return null;
  return {
    number: Number.parseInt(match[2], 10),
    text: normalizeText(match[3]),
    selected: Boolean(match[1]),
  };
}

function optionMatches(text: string, label: string): boolean {
  const normalizedLabel = normalizeText(label);
  return text === normalizedLabel || text.startsWith(`${normalizedLabel} `);
}

export function parseCodexAskSelectionScreen(
  screen: string,
  question: TmuxAskQuestion,
  optionIndex: number,
): AskSelection | null {
  const labels = validateSelectionInput(question, optionIndex);
  if (!labels) return null;
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/);
  let hintIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (CODEX_SELECTION_HINT_RE.test(lines[index])) {
      hintIndex = index;
      break;
    }
  }
  if (hintIndex < 0) return null;

  const rowCount = labels.length + 1;
  for (let start = Math.max(0, hintIndex - rowCount - 12); start < hintIndex; start += 1) {
    const rows = lines.slice(start, start + rowCount).map(parseCodexOptionLine);
    if (
      rows.some((row) => row === null)
      || !rows.every((row, offset) => row?.number === offset + 1)
      || !labels.every((label, offset) => optionMatches(rows[offset]?.text ?? '', label))
      || !optionMatches(rows[labels.length]?.text ?? '', CODEX_OTHER_LABEL)
      || !questionIsVisible(lines, start, question.question)
    ) {
      continue;
    }
    const selectedIndex = rows.findIndex((row) => row?.selected);
    if (selectedIndex < 0) return null;
    if (optionIndex === -1) return { action: 'cancel', delta: 0, label: 'Cancel' };
    if (optionIndex === labels.length) {
      return { action: 'other', delta: labels.length - selectedIndex, label: 'Direct input' };
    }
    return { action: 'option', delta: optionIndex - selectedIndex, label: labels[optionIndex] };
  }
  return null;
}

function parseOmpMenuLine(rawLine: string): MenuLine {
  let text = rawLine.replace(ANSI_RE, '').trim();
  if (text.startsWith('│')) text = text.slice(1);
  if (text.endsWith('│')) text = text.slice(0, -1);
  text = text.trim();
  const selected = /^[❯›>]/.test(text);
  if (selected) text = text.slice(1).trim();
  text = text.replace(/^[○●◉◯]\s*/, '');
  return { text: normalizeText(text), selected };
}

function ompOptionMatches(text: string, label: string): boolean {
  const normalizedLabel = normalizeText(label);
  return text === normalizedLabel || text === `${normalizedLabel} (Recommended)`;
}

export function parseOmpAskSelectionScreen(
  screen: string,
  question: TmuxAskQuestion,
  optionIndex: number,
): AskSelection | null {
  const labels = validateSelectionInput(question, optionIndex);
  if (!labels) return null;
  const rawLines = screen.replace(ANSI_RE, '').split(/\r?\n/);
  const lines = rawLines.map(parseOmpMenuLine);
  let hintIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (OMP_SELECTION_HINT_RE.test(lines[index].text)) {
      hintIndex = index;
      break;
    }
  }
  if (hintIndex < 0) return null;

  const rowCount = labels.length + 1;
  for (let start = Math.max(0, hintIndex - rowCount - 12); start < hintIndex; start += 1) {
    const rows = lines.slice(start, start + rowCount);
    if (
      !labels.every((label, offset) => ompOptionMatches(rows[offset]?.text ?? '', label))
      || rows[labels.length]?.text !== OMP_OTHER_LABEL
      || !questionIsVisible(rawLines, start, question.question)
    ) {
      continue;
    }
    const selectedIndex = rows.findIndex((row) => row.selected);
    if (selectedIndex < 0) return null;
    if (optionIndex === -1) return { action: 'cancel', delta: 0, label: 'Cancel' };
    if (optionIndex === labels.length) {
      return { action: 'other', delta: labels.length - selectedIndex, label: 'Direct input' };
    }
    return { action: 'option', delta: optionIndex - selectedIndex, label: labels[optionIndex] };
  }
  return null;
}

type ClaudeOptionLine = CodexOptionLine & { lineIndex: number };

function parseClaudeOptionLine(line: string, lineIndex: number): ClaudeOptionLine | null {
  const parsed = parseCodexOptionLine(line);
  return parsed ? { ...parsed, lineIndex } : null;
}

export function parseClaudeAskSelectionScreen(
  screen: string,
  question: TmuxAskQuestion,
  optionIndex: number,
): AskSelection | null {
  const labels = validateSelectionInput(question, optionIndex);
  if (!labels) return null;
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/);
  let hintIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (CLAUDE_SELECTION_HINT_RE.test(lines[index])) {
      hintIndex = index;
      break;
    }
  }
  if (hintIndex < 0) return null;

  const rows: ClaudeOptionLine[] = [];
  for (let index = Math.max(0, hintIndex - 64); index < hintIndex; index += 1) {
    const row = parseClaudeOptionLine(lines[index], index);
    if (row) rows.push(row);
  }
  const rowCount = labels.length + 2;
  for (let start = 0; start <= rows.length - rowCount; start += 1) {
    const candidates = rows.slice(start, start + rowCount);
    if (
      !candidates.every((row, offset) => row.number === offset + 1)
      || !labels.every((label, offset) => optionMatches(candidates[offset].text, label))
      || candidates[labels.length].text !== CLAUDE_OTHER_LABEL
      || candidates[labels.length + 1].text !== CLAUDE_CHAT_LABEL
      || !questionIsVisible(lines, candidates[0].lineIndex, question.question)
    ) {
      continue;
    }
    const selectedIndex = candidates.findIndex((row) => row.selected);
    if (selectedIndex < 0) return null;
    if (optionIndex === -1) return { action: 'cancel', delta: 0, label: 'Cancel' };
    if (optionIndex === labels.length) {
      return {
        action: 'other',
        delta: labels.length - selectedIndex,
        label: 'Direct input',
      };
    }
    return {
      action: 'option',
      delta: optionIndex - selectedIndex,
      label: labels[optionIndex],
    };
  }
  return null;
}

export function parseGjcAskCustomInputScreen(
  screen: string,
  question: TmuxAskQuestion,
): boolean {
  const labels = question.options.map((option) => option.label.trim());
  if (labels.length === 0 || labels.some((label) => !label)) return false;
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/).map(parseGjcMenuLine);
  let hintIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (GJC_CUSTOM_HINT_RE.test(lines[index].text)) {
      hintIndex = index;
      break;
    }
  }
  if (hintIndex < 0) return false;
  for (let otherIndex = hintIndex - 1; otherIndex >= Math.max(0, hintIndex - 12); otherIndex -= 1) {
    if (lines[otherIndex].text !== GJC_OTHER_LABEL || !lines[otherIndex].selected) continue;
    const start = otherIndex - labels.length;
    if (
      start >= 0
      && labels.every((label, offset) => lines[start + offset]?.text === label)
      && lines.slice(Math.max(0, start - 8), start).some((line) =>
        line.text === question.question.trim())
      && lines.slice(otherIndex + 1, hintIndex).some((line) => line.text === '>')
    ) return true;
  }
  return false;
}

export function parseCodexAskCustomInputScreen(
  screen: string,
  question: TmuxAskQuestion,
): boolean {
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/);
  const normalizedScreen = normalizeText(lines.join(' '));
  return lines.some((line) => CODEX_CUSTOM_HINT_RE.test(line))
    && lines.some((line) => /^[›>❯]\s*Add notes\s*$/i.test(line.trim()))
    && normalizedScreen.includes(normalizeText(question.question))
    && normalizedScreen.includes(CODEX_OTHER_LABEL);
}

export function parseOmpAskCustomInputScreen(
  screen: string,
  question: TmuxAskQuestion,
): boolean {
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/);
  const normalizedQuestion = normalizeText(question.question);
  return lines.some((line) => OMP_CUSTOM_HINT_RE.test(normalizeText(line)))
    && lines.some((line) => normalizeText(line).includes(`Custom answer: ${normalizedQuestion}`))
    && lines.some((line) => normalizeText(line) === '>');
}

export function parseClaudeAskCustomInputScreen(
  screen: string,
  question: TmuxAskQuestion,
): boolean {
  const selection = parseClaudeAskSelectionScreen(
    screen,
    question,
    question.options.length,
  );
  return selection?.action === 'other'
    && selection.delta === 0
    && CLAUDE_CUSTOM_HINT_RE.test(screen);
}

function parseSelection(
  kind: TmuxAskKind,
  screen: string,
  question: TmuxAskQuestion,
  optionIndex: number,
): AskSelection | null {
  if (kind === 'gjc') return parseGjcAskSelectionScreen(screen, question, optionIndex);
  if (kind === 'codex') return parseCodexAskSelectionScreen(screen, question, optionIndex);
  if (kind === 'omp') return parseOmpAskSelectionScreen(screen, question, optionIndex);
  return parseClaudeAskSelectionScreen(screen, question, optionIndex);
}

function parseCustomInput(
  kind: TmuxAskKind,
  screen: string,
  question: TmuxAskQuestion,
): boolean {
  if (kind === 'gjc') return parseGjcAskCustomInputScreen(screen, question);
  if (kind === 'codex') return parseCodexAskCustomInputScreen(screen, question);
  if (kind === 'omp') return parseOmpAskCustomInputScreen(screen, question);
  return parseClaudeAskCustomInputScreen(screen, question);
}

function stalePromptError(kind: TmuxAskKind): AppError {
  return new AppError(`${kind.toUpperCase()} selection is no longer visible.`, {
    code: 'TMUX_ASK_PROMPT_STALE',
    statusCode: 409,
  });
}

export async function answerPendingTmuxAskSelection(
  target: VerifiedTmuxActionTarget,
  pending: PendingTmuxAsk,
  optionIndex: number,
  run?: TmuxRunner,
): Promise<{ questionIndex: number; action: TmuxAskAction; label: string }> {
  if (
    target.kind !== 'gjc'
    && target.kind !== 'codex'
    && target.kind !== 'omp'
    && target.kind !== 'claude'
  ) {
    throw new AppError('This CLI does not support transcript selections.', {
      code: 'TMUX_ASK_UNSUPPORTED',
      statusCode: 400,
    });
  }
  const screen = await captureTmuxPane(target, run);
  let matched: (AskSelection & { questionIndex: number }) | null = null;
  for (let questionIndex = 0; questionIndex < pending.questions.length; questionIndex += 1) {
    const selection = parseSelection(
      target.kind,
      screen,
      pending.questions[questionIndex],
      optionIndex,
    );
    if (selection) {
      matched = { questionIndex, ...selection };
      break;
    }
  }
  if (!matched) throw stalePromptError(target.kind);

  const navigationKeys: TmuxSelectionKey[] = matched.delta > 0
    ? Array.from({ length: matched.delta }, () => 'Down' as const)
    : Array.from({ length: Math.abs(matched.delta) }, () => 'Up' as const);
  const keys: TmuxSelectionKey[] = matched.action === 'cancel'
    ? ['Escape']
    : matched.action === 'other'
      ? target.kind === 'claude'
        ? navigationKeys
        : [...navigationKeys, target.kind === 'codex' ? 'Tab' : 'Enter']
      : [...navigationKeys, 'Enter'];
  if (keys.length > 0) await sendTmuxSelectionKeys(target, keys, run);
  return {
    questionIndex: matched.questionIndex,
    action: matched.action,
    label: matched.label,
  };
}

export async function submitPendingTmuxAskCustomResponse(
  target: VerifiedTmuxActionTarget,
  pending: PendingTmuxAsk,
  message: string,
  run?: TmuxRunner,
): Promise<{ questionIndex: number }> {
  const value = message.trim();
  if (!value) {
    throw new AppError('message is required.', { code: 'EMPTY_MESSAGE', statusCode: 400 });
  }
  if (
    target.kind !== 'gjc'
    && target.kind !== 'codex'
    && target.kind !== 'omp'
    && target.kind !== 'claude'
  ) {
    throw new AppError('This CLI does not support transcript selections.', {
      code: 'TMUX_ASK_UNSUPPORTED',
      statusCode: 400,
    });
  }
  const screen = await captureTmuxPane(target, run);
  const questionIndex = pending.questions.findIndex((question) =>
    parseCustomInput(target.kind as TmuxAskKind, screen, question));
  if (questionIndex < 0) throw stalePromptError(target.kind);
  await sendToTmuxPane(target, value, run);
  return { questionIndex };
}
