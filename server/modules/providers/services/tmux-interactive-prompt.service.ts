import { createHash } from 'node:crypto';

import { AppError } from '@/shared/utils.js';

import type { TmuxRunner } from './builtin-relay.service.js';
import {
  parseClaudeAskCustomInputScreen,
  parseCodexAskCustomInputScreen,
  parseGjcAskCustomInputScreen,
  parseOmpAskCustomInputScreen,
  type TmuxAskQuestion,
} from './tmux-ask-selection.service.js';
import {
  captureTmuxPane,
  pasteToTmuxPane,
  sendTmuxSelectionKeys,
  sendToTmuxPane,
  type TmuxSelectionKey,
} from './tmux-pane-actions.service.js';
import type { VerifiedTmuxActionTarget } from './tmux-fresh-verifier.service.js';

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const SELECTED_RE = /^[❯›>]\s*/;
const DIVIDER_RE = /^[\s╭╮╰╯├┤┬┴┼─━═╌▔]+$/;
const GJC_HINT_RE = /up\/down navigate\s+enter select\s+esc cancel/i;
const OMP_SINGLE_HINT_RE = /enter select.*↑\/↓ move.*esc cancel/i;
const OMP_MULTI_HINT_RE = /space\/enter toggle.*↑\/↓ move.*esc cancel/i;
const CODEX_ASK_HINT_RE = /tab to add notes.*enter to submit answer.*esc to interrupt/i;
const CLAUDE_ASK_HINT_RE = /enter to select.*↑\/↓ to navigate.*esc to cancel/i;
const CODEX_APPROVAL_HEADER_RE =
  /(?:Would you like to (?:run|make|apply|continue|grant)|Allow Codex to|Approve (?:this )?(?:app )?tool call|Do you trust the contents|Enable full access)/i;
const NUMBERED_OPTION_RE = /^\s*([›>❯])?\s*(\d+)\.\s+(.+)$/;
const CACHE_TTL_MS = 2_500;
const CUSTOM_PROMPT_TTL_MS = 30 * 60_000;

export type TmuxInteractivePromptKind = 'question' | 'approval' | 'plan';

export type TmuxInteractivePromptOption = {
  label: string;
  description?: string;
};

export type TmuxInteractivePrompt = {
  id: string;
  kind: TmuxInteractivePromptKind;
  title: string;
  question: string;
  body: string | null;
  options: TmuxInteractivePromptOption[];
  multiSelect: boolean;
  customOptionNumber: number | null;
  cancelNumber: 0;
};

type PromptProvider = 'gjc' | 'codex' | 'omp' | 'claude';
type PromptResponder =
  | 'gjc-question'
  | 'codex-question'
  | 'omp-question'
  | 'claude-question'
  | 'codex-approval'
  | 'omp-approval'
  | 'claude-approval'
  | 'claude-plan';

type ParsedPrompt = TmuxInteractivePrompt & {
  provider: PromptProvider;
  responder: PromptResponder;
  menuLabels: string[];
  selectedIndex: number;
  checkedOptionIndices: number[];
  customMenuIndex: number | null;
  rejectWithEscapeIndex: number | null;
};

type CachedPrompt = {
  expiresAt: number;
  activity: 'asking_user';
};

const promptCache = new Map<string, CachedPrompt>();
const observedActivityCache = new Set<string>();
const observedPromptContextCache = new Map<string, ParsedPrompt>();
const customPromptCache = new Map<string, { expiresAt: number; prompt: ParsedPrompt }>();

function targetKey(target: Pick<VerifiedTmuxActionTarget, 'tmux' | 'process'>): string {
  return [
    target.tmux.socketPath,
    target.tmux.sessionId,
    target.tmux.windowId,
    target.tmux.paneId,
    target.process.pid,
    target.process.startedAtMs,
  ].join('\0');
}

function cleanLine(rawLine: string): string {
  let line = rawLine.replace(ANSI_RE, '').trim();
  if (line.startsWith('│')) line = line.slice(1).trimStart();
  if (line.endsWith('│')) line = line.slice(0, -1).trimEnd();
  return line.trim();
}

function isDivider(line: string): boolean {
  const value = cleanLine(line);
  return Boolean(value) && DIVIDER_RE.test(value);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function promptId(input: Omit<TmuxInteractivePrompt, 'id' | 'cancelNumber'>, provider: PromptProvider): string {
  return createHash('sha256')
    .update('chatmux:tmux-interactive-prompt:v2\0')
    .update(provider)
    .update('\0')
    .update(input.kind)
    .update('\0')
    .update(normalizeText(input.question))
    .update('\0')
    .update(normalizeText(input.body ?? ''))
    .update('\0')
    .update(input.options.map((option) => normalizeText(option.label)).join('\0'))
    .update(input.multiSelect ? '\0multi' : '\0single')
    .digest('hex')
    .slice(0, 32);
}

function finishPrompt(
  input: Omit<TmuxInteractivePrompt, 'id' | 'cancelNumber'>,
  provider: PromptProvider,
  internal: Omit<ParsedPrompt, keyof TmuxInteractivePrompt | 'provider'>,
): ParsedPrompt {
  return {
    ...input,
    id: promptId(input, provider),
    cancelNumber: 0,
    provider,
    ...internal,
  };
}

function publicPrompt(prompt: ParsedPrompt): TmuxInteractivePrompt {
  return {
    id: prompt.id,
    kind: prompt.kind,
    title: prompt.title,
    question: prompt.question,
    body: prompt.body,
    options: prompt.options,
    multiSelect: prompt.multiSelect,
    customOptionNumber: prompt.customOptionNumber,
    cancelNumber: 0,
  };
}

function findLastIndex(lines: string[], predicate: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index])) return index;
  }
  return -1;
}

function nearestQuestion(lines: string[], beforeIndex: number): string | null {
  for (let index = beforeIndex - 1; index >= Math.max(0, beforeIndex - 14); index -= 1) {
    const line = cleanLine(lines[index]);
    if (
      !line
      || isDivider(line)
      || /^Planning:/i.test(line)
      || /^[←→].*Submit/i.test(line)
      || /^[☐☑✔]\s+\S/.test(line)
      || /^Question \d+\/\d+/i.test(line)
    ) continue;
    return line.replace(/^\(\d+\s+selected\)\s*/i, '').trim();
  }
  return null;
}

type MenuRow = {
  label: string;
  selected: boolean;
  checked: boolean;
  description?: string;
  lineIndex: number;
};

function parseBorderMenu(
  lines: string[],
  startDivider: number,
  endDivider: number,
): MenuRow[] {
  const rows: MenuRow[] = [];
  for (let index = startDivider + 1; index < endDivider; index += 1) {
    let text = cleanLine(lines[index]);
    if (!text || isDivider(text)) continue;
    const selected = SELECTED_RE.test(text);
    text = text.replace(SELECTED_RE, '').trim();
    const checked = /^[☑☒✓]/.test(text);
    text = text.replace(/^[○●◉◯☐☑☒✓]\s*/, '').trim();
    if (!text) continue;
    rows.push({ label: normalizeText(text), selected, checked, lineIndex: index });
  }
  return rows;
}

function findMenuDividers(lines: string[], hintIndex: number): [number, number] | null {
  let endDivider = -1;
  let startDivider = -1;
  for (let index = hintIndex - 1; index >= 0; index -= 1) {
    if (!isDivider(lines[index])) continue;
    if (endDivider < 0) {
      endDivider = index;
    } else {
      startDivider = index;
      break;
    }
  }
  return startDivider >= 0 && endDivider > startDivider
    ? [startDivider, endDivider]
    : null;
}

function parseGjcQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (line) => GJC_HINT_RE.test(cleanLine(line)));
  if (hintIndex < 0) return null;
  const dividers = findMenuDividers(lines, hintIndex);
  if (!dividers) return null;
  const [startDivider, endDivider] = dividers;
  const rows = parseBorderMenu(lines, startDivider, endDivider);
  const selectedIndex = rows.findIndex((row) => row.selected);
  const doneIndex = rows.findIndex((row) => /^(?:✔\s*)?Done selecting$/i.test(row.label));
  const customIndex = rows.findIndex((row) => /^Other(?: \(type your own\))?$/i.test(row.label));
  const optionRows = rows.filter((_, index) => index !== doneIndex && index !== customIndex);
  const multiSelect = optionRows.some((row) => row.checked) || doneIndex >= 0
    || optionRows.some((row) => /^[☐☑☒✓]/.test(cleanLine(lines[row.lineIndex]).replace(SELECTED_RE, '')));
  const question = nearestQuestion(lines, startDivider);
  if (!question || selectedIndex < 0 || optionRows.length === 0 || customIndex < 0) return null;
  const options = optionRows.map((row) => ({ label: row.label }));
  return finishPrompt({
    kind: 'question',
    title: multiSelect ? 'Multiple choice' : 'Question',
    question,
    body: null,
    options,
    multiSelect,
    customOptionNumber: multiSelect ? null : options.length + 1,
  }, 'gjc', {
    responder: 'gjc-question',
    menuLabels: rows.map((row) => row.label),
    selectedIndex,
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []),
    customMenuIndex: customIndex,
    rejectWithEscapeIndex: null,
  });
}

function parseOmpQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (line) => {
    const cleaned = cleanLine(line);
    return OMP_SINGLE_HINT_RE.test(cleaned) || OMP_MULTI_HINT_RE.test(cleaned);
  });
  if (hintIndex < 0) return null;
  const dividers = findMenuDividers(lines, hintIndex);
  if (!dividers) return null;
  const [startDivider, endDivider] = dividers;
  const rows = parseBorderMenu(lines, startDivider, endDivider);
  const selectedIndex = rows.findIndex((row) => row.selected);
  const customIndex = rows.findIndex((row) => /^Other \(type your own\)$/i.test(row.label));
  const optionRows = rows.filter((_, index) => index !== customIndex);
  const multiSelect = OMP_MULTI_HINT_RE.test(cleanLine(lines[hintIndex]));
  const question = nearestQuestion(lines, startDivider);
  if (!question || selectedIndex < 0 || optionRows.length === 0 || customIndex < 0) return null;
  const options = optionRows.map((row) => ({
    label: row.label.replace(/ \(Recommended\)$/i, ''),
  }));
  return finishPrompt({
    kind: 'question',
    title: multiSelect ? 'Multiple choice' : 'Question',
    question,
    body: null,
    options,
    multiSelect,
    customOptionNumber: multiSelect ? null : options.length + 1,
  }, 'omp', {
    responder: 'omp-question',
    menuLabels: rows.map((row) => row.label),
    selectedIndex,
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []),
    customMenuIndex: customIndex,
    rejectWithEscapeIndex: null,
  });
}

type NumberedRow = MenuRow & { number: number };

function parseNumberedRows(lines: string[], start: number, end: number): NumberedRow[] {
  const rows: NumberedRow[] = [];
  for (let index = start; index < end; index += 1) {
    const match = lines[index].replace(ANSI_RE, '').trim().match(NUMBERED_OPTION_RE);
    if (!match) continue;
    let label = match[3].trim();
    const checked = /^\[[xX✓]\]/.test(label);
    label = label.replace(/^\[[ xX✓]\]\s*/, '').trim();
    rows.push({
      number: Number.parseInt(match[2], 10),
      label,
      selected: Boolean(match[1]),
      checked,
      lineIndex: index,
    });
  }
  for (let index = 0; index < rows.length; index += 1) {
    const nextLineIndex = rows[index + 1]?.lineIndex ?? end;
    for (let lineIndex = rows[index].lineIndex + 1; lineIndex < nextLineIndex; lineIndex += 1) {
      const description = cleanLine(lines[lineIndex]);
      if (!description || isDivider(description)) continue;
      rows[index].description = description;
      break;
    }
  }
  return rows;
}

function sequentialRows(rows: NumberedRow[]): boolean {
  return rows.length > 0 && rows.every((row, index) => row.number === index + 1);
}

function parseCodexQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (line) => CODEX_ASK_HINT_RE.test(line));
  if (hintIndex < 0) return null;
  const rows = parseNumberedRows(lines, Math.max(0, hintIndex - 48), hintIndex);
  if (!sequentialRows(rows) || rows.filter((row) => row.selected).length !== 1) return null;
  const customIndex = rows.findIndex((row) => /^None of the above\b/i.test(row.label));
  if (customIndex !== rows.length - 1 || customIndex < 1) return null;
  const question = nearestQuestion(lines, rows[0].lineIndex);
  if (!question) return null;
  const options = rows.slice(0, customIndex).map((row) => {
    const [label, ...descriptionParts] = row.label.split(/\s{2,}/);
    return {
      label,
      ...(descriptionParts.length > 0 ? { description: descriptionParts.join(' ') } : {}),
    };
  });
  return finishPrompt({
    kind: 'question',
    title: 'Question',
    question,
    body: null,
    options,
    multiSelect: false,
    customOptionNumber: options.length + 1,
  }, 'codex', {
    responder: 'codex-question',
    menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [],
    customMenuIndex: customIndex,
    rejectWithEscapeIndex: null,
  });
}

function parseClaudeQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (line) => CLAUDE_ASK_HINT_RE.test(line));
  if (hintIndex < 0) return null;
  const rows = parseNumberedRows(lines, Math.max(0, hintIndex - 64), hintIndex);
  if (!sequentialRows(rows) || rows.filter((row) => row.selected).length !== 1) return null;
  const chatIndex = rows.findIndex((row) => row.label === 'Chat about this');
  const customIndex = rows.findIndex((row) => /^Type something\.?$/i.test(row.label));
  if (chatIndex !== rows.length - 1 || customIndex !== chatIndex - 1 || customIndex < 1) return null;
  const question = nearestQuestion(lines, rows[0].lineIndex);
  if (!question) return null;
  const optionRows = rows.slice(0, customIndex);
  const multiSelect = optionRows.some((row) =>
    /^\s*(?:[›>❯]\s*)?\d+\.\s+\[[ xX✓]\]/.test(lines[row.lineIndex]));
  // Public options exclude the trailing "Type something." / "Chat about this"
  // rows (mirroring the codex parser): validateChoices caps selections at
  // customOptionNumber, so exposing those rows as numbered options would
  // surface phantom choices that are always rejected.
  const options = optionRows.map((row) => ({
    label: row.label,
    ...(row.description ? { description: row.description } : {}),
  }));
  return finishPrompt({
    kind: 'question',
    title: multiSelect ? 'Multiple choice' : 'Question',
    question,
    body: null,
    options,
    multiSelect,
    customOptionNumber: multiSelect ? null : customIndex + 1,
  }, 'claude', {
    responder: 'claude-question',
    menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []),
    customMenuIndex: customIndex,
    rejectWithEscapeIndex: null,
  });
}

function parseCodexApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/);
  const headerIndex = findLastIndex(lines, (line) =>
    CODEX_APPROVAL_HEADER_RE.test(line) && !NUMBERED_OPTION_RE.test(line));
  if (headerIndex < 0) return null;
  const rows = parseNumberedRows(lines, headerIndex + 1, lines.length);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) {
    return null;
  }
  const options = rows.map((row) => ({ label: row.label }));
  const body = lines
    .slice(headerIndex + 1, rows[0].lineIndex)
    .map(cleanLine)
    .filter(Boolean)
    .join('\n')
    .slice(0, 12_000);
  return finishPrompt({
    kind: 'approval',
    title: cleanLine(lines[headerIndex]),
    question: cleanLine(lines[headerIndex]),
    body: body || null,
    options,
    multiSelect: false,
    customOptionNumber: null,
  }, 'codex', {
    responder: 'codex-approval',
    menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [],
    customMenuIndex: null,
    rejectWithEscapeIndex: rows.findIndex((row) => /^(?:No|Reject|Cancel|Deny)\b/i.test(row.label)),
  });
}

function parseOmpApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/);
  const headerIndex = findLastIndex(lines, (line) => /^\s*Allow tool:\s*\S+/i.test(cleanLine(line)));
  if (headerIndex < 0) return null;
  const rows: MenuRow[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const text = cleanLine(lines[index]);
    const match = text.match(/^([›>❯•])?\s*(Approve|Deny)$/i);
    if (!match) continue;
    rows.push({
      label: match[2],
      selected: Boolean(match[1]),
      checked: false,
      lineIndex: index,
    });
  }
  if (rows.length !== 2 || rows.filter((row) => row.selected).length !== 1) return null;
  return finishPrompt({
    kind: 'approval',
    title: cleanLine(lines[headerIndex]),
    question: cleanLine(lines[headerIndex]),
    body: lines.slice(headerIndex + 1, rows[0].lineIndex).map(cleanLine).filter(Boolean).join('\n') || null,
    options: rows.map((row) => ({ label: row.label })),
    multiSelect: false,
    customOptionNumber: null,
  }, 'omp', {
    responder: 'omp-approval',
    menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [],
    customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

function parseClaudeApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/);
  const planIndex = findLastIndex(lines, (line) =>
    /Claude has written up a plan and is ready to execute\. Would you like to proceed\?/i.test(cleanLine(line)));
  if (planIndex >= 0) {
    const rows = parseNumberedRows(lines, planIndex + 1, lines.length);
    if (!sequentialRows(rows) || rows.length < 3 || rows.filter((row) => row.selected).length !== 1) {
      return null;
    }
    const customIndex = rows.findIndex((row) => /^Tell Claude what to change$/i.test(row.label));
    const bodyStart = Math.max(0, findLastIndex(lines.slice(0, planIndex), (line) =>
      /Ready to code\?/i.test(cleanLine(line))));
    return finishPrompt({
      kind: 'plan',
      title: 'Ready to code?',
      question: cleanLine(lines[planIndex]),
      body: lines.slice(bodyStart, planIndex).map(cleanLine).filter((line) => !isDivider(line)).join('\n').slice(0, 12_000) || null,
      options: rows.map((row) => ({ label: row.label })),
      multiSelect: false,
      customOptionNumber: customIndex >= 0 ? customIndex + 1 : null,
    }, 'claude', {
      responder: 'claude-plan',
      menuLabels: rows.map((row) => row.label),
      selectedIndex: rows.findIndex((row) => row.selected),
      checkedOptionIndices: [],
      customMenuIndex: customIndex >= 0 ? customIndex : null,
      rejectWithEscapeIndex: null,
    });
  }

  const requiredIndex = findLastIndex(lines, (line) =>
    /This command requires approval/i.test(cleanLine(line)));
  const questionIndex = findLastIndex(lines, (line) => /^Do you want to proceed\?$/i.test(cleanLine(line)));
  if (requiredIndex < 0 || questionIndex < requiredIndex) return null;
  const rows = parseNumberedRows(lines, questionIndex + 1, lines.length);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) {
    return null;
  }
  const title = nearestQuestion(lines, requiredIndex) ?? 'Command approval';
  return finishPrompt({
    kind: 'approval',
    title,
    question: cleanLine(lines[questionIndex]),
    body: lines.slice(Math.max(0, requiredIndex - 8), requiredIndex).map(cleanLine).filter((line) =>
      line && !isDivider(line)).join('\n').slice(0, 12_000) || null,
    options: rows.map((row) => ({ label: row.label })),
    multiSelect: false,
    customOptionNumber: null,
  }, 'claude', {
    responder: 'claude-approval',
    menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [],
    customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

function promptTailIsActive(prompt: ParsedPrompt, screen: string): boolean {
  const last = screen
    .replace(ANSI_RE, '')
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((line) => line && !isDivider(line))
    .at(-1) ?? '';
  if (prompt.responder === 'gjc-question') return GJC_HINT_RE.test(last);
  if (prompt.responder === 'omp-question') {
    return OMP_SINGLE_HINT_RE.test(last) || OMP_MULTI_HINT_RE.test(last);
  }
  if (prompt.responder === 'codex-question') return CODEX_ASK_HINT_RE.test(last);
  if (prompt.responder === 'claude-question') return CLAUDE_ASK_HINT_RE.test(last);
  if (prompt.responder === 'codex-approval') {
    return /press enter to confirm|esc to cancel|^\d+\.\s+(?:No|Reject|Cancel|Deny)\b/i.test(last);
  }
  if (prompt.responder === 'omp-approval') {
    return /^(?:Approve|Deny)$|esc.*cancel/i.test(last);
  }
  if (prompt.responder === 'claude-approval') {
    return /esc to cancel.*(?:tab|ctrl\+e)|ctrl\+e to explain/i.test(last);
  }
  return /ctrl\+g to edit|shift\+tab to approve with this feedback/i.test(last);
}

export function parseTmuxInteractivePrompt(
  kind: VerifiedTmuxActionTarget['kind'],
  screen: string,
): ParsedPrompt | null {
  const candidates = kind === 'gjc'
    ? [parseGjcQuestion(screen)]
    : kind === 'codex'
      ? [parseCodexQuestion(screen), parseCodexApproval(screen)]
      : kind === 'omp'
        ? [parseOmpQuestion(screen), parseOmpApproval(screen)]
        : kind === 'claude'
          ? [parseClaudeQuestion(screen), parseClaudeApproval(screen)]
          : [];
  return candidates.find((candidate): candidate is ParsedPrompt =>
    candidate !== null && promptTailIsActive(candidate, screen)) ?? null;
}

function cachePrompt(target: VerifiedTmuxActionTarget, prompt: ParsedPrompt | null): void {
  const key = targetKey(target);
  if (!prompt) {
    promptCache.delete(key);
    return;
  }
  promptCache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    activity: 'asking_user',
  });
}

export function getCachedTmuxInteractiveActivity(
  target: Pick<VerifiedTmuxActionTarget, 'tmux' | 'process'>,
): 'asking_user' | null {
  const key = targetKey(target);
  if (observedActivityCache.has(key)) return 'asking_user';
  const cached = promptCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    promptCache.delete(key);
    return null;
  }
  return cached.activity;
}

/**
 * Stores the server-side terminal observer's authoritative prompt state.
 * Unlike the short request cache, this remains valid while the captured
 * screen is unchanged and is cleared by the next observed screen transition.
 */
export function setObservedTmuxInteractiveActivity(
  target: Pick<VerifiedTmuxActionTarget, 'tmux' | 'process'>,
  active: boolean,
): boolean {
  const key = targetKey(target);
  const previous = observedActivityCache.has(key);
  if (active) observedActivityCache.add(key);
  else {
    observedActivityCache.delete(key);
    observedPromptContextCache.delete(key);
  }
  return previous !== active;
}

/**
 * Recognizes both a native menu and the provider-specific direct-input screen
 * that may replace it after "Other" is selected outside ChatMux.
 */
export function tmuxScreenHasInteractivePrompt(
  target: Pick<VerifiedTmuxActionTarget, 'tmux' | 'process' | 'kind'>,
  screen: string,
): boolean {
  const key = targetKey(target);
  const parsed = parseTmuxInteractivePrompt(target.kind, screen);
  if (parsed) {
    observedPromptContextCache.set(key, parsed);
    return true;
  }
  const custom = customPromptCache.get(key);
  const context = custom && custom.expiresAt > Date.now()
    ? custom.prompt
    : observedPromptContextCache.get(key);
  return context ? customInputIsActive(context, screen) : false;
}

export async function getTmuxInteractivePrompt(
  target: VerifiedTmuxActionTarget,
  run?: TmuxRunner,
): Promise<TmuxInteractivePrompt | null> {
  const screen = await captureTmuxPane(target, run);
  const parsed = parseTmuxInteractivePrompt(target.kind, screen);
  if (!parsed) {
    const key = targetKey(target);
    const custom = customPromptCache.get(key);
    if (
      custom
      && custom.expiresAt > Date.now()
      && customInputIsActive(custom.prompt, screen)
    ) {
      custom.expiresAt = Date.now() + CUSTOM_PROMPT_TTL_MS;
      cachePrompt(target, custom.prompt);
      return publicPrompt(custom.prompt);
    }
    customPromptCache.delete(key);
  }
  cachePrompt(target, parsed);
  return parsed ? publicPrompt(parsed) : null;
}

function assertPromptId(parsed: ParsedPrompt | null, requestedId: string): ParsedPrompt {
  if (!parsed || parsed.id !== requestedId) {
    throw new AppError('The interactive prompt changed; reopen the session and try again.', {
      code: 'TMUX_INTERACTIVE_PROMPT_STALE',
      statusCode: 409,
    });
  }
  return parsed;
}

function navigationKeys(delta: number): TmuxSelectionKey[] {
  return delta > 0
    ? Array.from({ length: delta }, () => 'Down' as const)
    : Array.from({ length: Math.abs(delta) }, () => 'Up' as const);
}

function validateChoices(prompt: ParsedPrompt, choices: readonly number[]): number[] {
  if (
    choices.length === 0
    || choices.length > prompt.options.length
    || choices.some((choice) => !Number.isInteger(choice))
  ) {
    throw new AppError('A valid displayed choice number is required.', {
      code: 'TMUX_INTERACTIVE_CHOICE_INVALID',
      statusCode: 400,
    });
  }
  if (choices.length === 1 && choices[0] === 0) return [0];
  if (choices.includes(0)) {
    throw new AppError('Cancel (0) cannot be combined with another choice.', {
      code: 'TMUX_INTERACTIVE_CHOICE_INVALID',
      statusCode: 400,
    });
  }
  const maximum = prompt.customOptionNumber ?? prompt.options.length;
  if (choices.some((choice) => choice < 1 || choice > maximum)) {
    throw new AppError('A choice number is outside the displayed range.', {
      code: 'TMUX_INTERACTIVE_CHOICE_INVALID',
      statusCode: 400,
    });
  }
  const unique = [...new Set(choices)];
  if (!prompt.multiSelect && unique.length !== 1) {
    throw new AppError('This prompt accepts one choice.', {
      code: 'TMUX_INTERACTIVE_CHOICE_INVALID',
      statusCode: 400,
    });
  }
  return unique;
}

async function answerMultiSelect(
  target: VerifiedTmuxActionTarget,
  prompt: ParsedPrompt,
  choices: number[],
  run?: TmuxRunner,
): Promise<void> {
  if (choices.length === 0) {
    throw new AppError('Select at least one option.', {
      code: 'TMUX_INTERACTIVE_CHOICE_INVALID',
      statusCode: 400,
    });
  }
  const desired = new Set(choices.map((choice) => choice - 1));
  const checked = new Set(prompt.checkedOptionIndices);
  const toggleIndices = prompt.options.flatMap((_, index) =>
    desired.has(index) !== checked.has(index) ? [index] : []);
  let cursor = prompt.selectedIndex;
  const keys: TmuxSelectionKey[] = [];
  for (const optionIndex of toggleIndices) {
    keys.push(...navigationKeys(optionIndex - cursor));
    keys.push(prompt.responder === 'omp-question' ? 'Space' : 'Enter');
    cursor = optionIndex;
  }
  if (prompt.responder === 'gjc-question') {
    keys.push(...navigationKeys(prompt.options.length - cursor), 'Enter');
  } else if (prompt.responder === 'omp-question') {
    keys.push('Tab', 'Enter');
  } else if (prompt.responder === 'claude-question') {
    // Verified against Claude Code 2.1.220: Enter toggles the focused option,
    // Right opens the Submit tab, and Enter confirms the reviewed answers.
    keys.push('Right', 'Enter');
  } else {
    throw new AppError('This CLI does not support multiple selections.', {
      code: 'TMUX_INTERACTIVE_CHOICE_UNSUPPORTED',
      statusCode: 400,
    });
  }
  await sendTmuxSelectionKeys(target, keys, run);
}

export async function answerTmuxInteractivePrompt(
  target: VerifiedTmuxActionTarget,
  requestedId: string,
  requestedChoices: readonly number[],
  run?: TmuxRunner,
): Promise<{ action: 'selected' | 'other' | 'cancel' }> {
  const prompt = assertPromptId(
    parseTmuxInteractivePrompt(target.kind, await captureTmuxPane(target, run)),
    requestedId,
  );
  const choices = validateChoices(prompt, requestedChoices);
  if (choices.length === 1 && choices[0] === 0) {
    await sendTmuxSelectionKeys(target, ['Escape'], run);
    promptCache.delete(targetKey(target));
    customPromptCache.delete(targetKey(target));
    return { action: 'cancel' };
  }
  if (prompt.multiSelect) {
    await answerMultiSelect(target, prompt, choices, run);
    promptCache.delete(targetKey(target));
    customPromptCache.delete(targetKey(target));
    return { action: 'selected' };
  }

  const optionIndex = choices[0] - 1;
  const isCustom = prompt.customOptionNumber === choices[0];
  if (isCustom) {
    if (prompt.customMenuIndex === null) {
      throw new AppError('This prompt has no direct-input option.', {
        code: 'TMUX_INTERACTIVE_CHOICE_INVALID',
        statusCode: 400,
      });
    }
    const keys = prompt.responder === 'codex-question'
      ? [...navigationKeys(prompt.customMenuIndex - prompt.selectedIndex), 'Tab' as const]
      : prompt.responder === 'claude-question' || prompt.responder === 'claude-plan'
        ? navigationKeys(prompt.customMenuIndex - prompt.selectedIndex)
        : [...navigationKeys(prompt.customMenuIndex - prompt.selectedIndex), 'Enter' as const];
    if (keys.length > 0) await sendTmuxSelectionKeys(target, keys, run);
    customPromptCache.set(targetKey(target), {
      expiresAt: Date.now() + CUSTOM_PROMPT_TTL_MS,
      prompt,
    });
    cachePrompt(target, prompt);
    return { action: 'other' };
  }
  if (
    prompt.rejectWithEscapeIndex !== null
    && optionIndex === prompt.rejectWithEscapeIndex
  ) {
    await sendTmuxSelectionKeys(target, ['Escape'], run);
  } else {
    await sendTmuxSelectionKeys(
      target,
      [...navigationKeys(optionIndex - prompt.selectedIndex), 'Enter'],
      run,
    );
  }
  promptCache.delete(targetKey(target));
  customPromptCache.delete(targetKey(target));
  return { action: 'selected' };
}

function questionForCustom(prompt: ParsedPrompt): TmuxAskQuestion {
  const options = prompt.customMenuIndex === null
    ? prompt.options
    : prompt.options.slice(0, prompt.customMenuIndex);
  return {
    question: prompt.question,
    options: options.map((option) => ({ label: option.label })),
  };
}

function customInputIsActive(prompt: ParsedPrompt, screen: string): boolean {
  const question = questionForCustom(prompt);
  if (prompt.responder === 'gjc-question') return parseGjcAskCustomInputScreen(screen, question);
  if (prompt.responder === 'codex-question') return parseCodexAskCustomInputScreen(screen, question);
  if (prompt.responder === 'omp-question') return parseOmpAskCustomInputScreen(screen, question);
  if (prompt.responder === 'claude-question') return parseClaudeAskCustomInputScreen(screen, question);
  if (prompt.responder === 'claude-plan') {
    return prompt.selectedIndex === prompt.customMenuIndex
      && screen.includes(prompt.question)
      && screen.includes('Tell Claude what to change')
      && /shift\+tab to approve with this feedback/i.test(screen);
  }
  return false;
}

export async function submitTmuxInteractiveCustomResponse(
  target: VerifiedTmuxActionTarget,
  requestedId: string,
  message: string,
  run?: TmuxRunner,
): Promise<void> {
  const value = message.trim();
  if (!value) {
    throw new AppError('message is required.', { code: 'EMPTY_MESSAGE', statusCode: 400 });
  }
  const screen = await captureTmuxPane(target, run);
  const key = targetKey(target);
  const cached = customPromptCache.get(key);
  const current = parseTmuxInteractivePrompt(target.kind, screen);
  const prompt = assertPromptId(
    current
    ?? (cached && cached.expiresAt > Date.now()
      ? cached.prompt
      : null),
    requestedId,
  );
  if (!customInputIsActive(prompt, screen)) {
    throw new AppError('The direct-input prompt is no longer active.', {
      code: 'TMUX_INTERACTIVE_PROMPT_STALE',
      statusCode: 409,
    });
  }
  if (prompt.responder === 'claude-plan') {
    await pasteToTmuxPane(target, value, run);
    await sendTmuxSelectionKeys(target, ['BTab'], run);
  } else {
    await sendToTmuxPane(target, value, run);
  }
  promptCache.delete(targetKey(target));
  customPromptCache.delete(targetKey(target));
}
