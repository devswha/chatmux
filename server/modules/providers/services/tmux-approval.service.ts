import { AppError } from '@/shared/utils.js';

import type { TmuxRunner } from './builtin-relay.service.js';
import {
  captureTmuxPane,
  sendTmuxSelectionKeys,
  type TmuxSelectionKey,
} from './tmux-pane-actions.service.js';
import type { VerifiedTmuxActionTarget } from './tmux-fresh-verifier.service.js';

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CODEX_APPROVAL_HEADER_RE = /(?:Would you like to (?:run|make|apply|continue|grant)|Allow Codex to|Approve (?:this )?(?:app )?tool call|Do you trust the contents|Enable full access)/i;
const CODEX_OPTION_RE = /^\s*([›>❯])?\s*(\d+)\.\s+(.+)$/;
const CODEX_YES_RE = /^(?:Yes|Run|Apply|Allow|Proceed|Continue)\b/i;
const CODEX_NO_RE = /^(?:No|Reject|Cancel|Deny)\b/i;

export type TmuxApprovalDecision =
  | 'approve-once'
  | 'approve-remember'
  | 'reject'
  | 'cancel';

export type TmuxApprovalPrompt = {
  title: string;
  text: string;
  canRemember: boolean;
  optionCount: number;
};

type ParsedApproval = TmuxApprovalPrompt & {
  selectedIndex: number;
  approveIndex: number;
  rememberIndex: number | null;
  rejectIndex: number;
};

export function parseCodexApprovalScreen(screen: string): ParsedApproval | null {
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/).map((line) => line.trimEnd());
  let headerIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (CODEX_APPROVAL_HEADER_RE.test(lines[index]) && !CODEX_OPTION_RE.test(lines[index])) {
      headerIndex = index;
    }
  }
  if (headerIndex < 0) return null;
  const visibleTail = lines.slice(headerIndex);
  while (visibleTail.length > 0 && !visibleTail.at(-1)?.trim()) visibleTail.pop();
  if (visibleTail.length === 0 || visibleTail.length > 40) return null;

  const rows = visibleTail.flatMap((line) => {
    const match = CODEX_OPTION_RE.exec(line);
    return match ? [{
      selected: Boolean(match[1]),
      number: Number.parseInt(match[2], 10),
      text: match[3].trim(),
    }] : [];
  });
  if (
    rows.length < 2
    || !rows.every((row, index) => row.number === index + 1)
    || rows.filter((row) => row.selected).length !== 1
  ) return null;
  const approveIndex = rows.findIndex((row) => CODEX_YES_RE.test(row.text));
  const rejectIndex = rows.findIndex((row) => CODEX_NO_RE.test(row.text));
  if (approveIndex < 0 || rejectIndex < 0) return null;
  const rememberIndex = rows.findIndex((row) =>
    /don't ask again|always allow|this session|remember|commands that start with/i.test(row.text));
  const text = visibleTail.join('\n').trim().slice(0, 12_000);
  return {
    title: visibleTail[0].trim(),
    text,
    canRemember: rememberIndex >= 0,
    optionCount: rows.length,
    selectedIndex: rows.findIndex((row) => row.selected),
    approveIndex,
    rememberIndex: rememberIndex >= 0 ? rememberIndex : null,
    rejectIndex,
  };
}

export function parseOmpApprovalScreen(screen: string): ParsedApproval | null {
  const lines = screen.replace(ANSI_RE, '').split(/\r?\n/).map((line) => line.trimEnd());
  let headerIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*Allow tool:\s*\S+/i.test(lines[index])) headerIndex = index;
  }
  if (headerIndex < 0) return null;
  const visibleTail = lines.slice(headerIndex);
  while (visibleTail.length > 0 && !visibleTail.at(-1)?.trim()) visibleTail.pop();
  if (visibleTail.length === 0 || visibleTail.length > 40) return null;

  const menuRows = visibleTail.flatMap((line) => {
    const match = line.trim().match(/^([›>❯•])?\s*(Approve|Deny)\s*$/i);
    return match ? [{ selected: Boolean(match[1]), text: match[2].toLowerCase() }] : [];
  });
  if (menuRows.length !== 2 || menuRows.filter((row) => row.selected).length !== 1) return null;
  const approveIndex = menuRows.findIndex((row) => row.text === 'approve');
  const rejectIndex = menuRows.findIndex((row) => row.text === 'deny');
  if (approveIndex < 0 || rejectIndex < 0) return null;
  return {
    title: visibleTail[0].trim(),
    text: visibleTail.join('\n').trim().slice(0, 12_000),
    canRemember: false,
    optionCount: 2,
    selectedIndex: menuRows.findIndex((row) => row.selected),
    approveIndex,
    rememberIndex: null,
    rejectIndex,
  };
}

function publicPrompt(prompt: ParsedApproval): TmuxApprovalPrompt {
  return {
    title: prompt.title,
    text: prompt.text,
    canRemember: prompt.canRemember,
    optionCount: prompt.optionCount,
  };
}

function parseApproval(target: VerifiedTmuxActionTarget, screen: string): ParsedApproval | null {
  if (target.kind === 'codex') return parseCodexApprovalScreen(screen);
  if (target.kind === 'omp') return parseOmpApprovalScreen(screen);
  return null;
}

export async function getTmuxApprovalPrompt(
  target: VerifiedTmuxActionTarget,
  run?: TmuxRunner,
): Promise<TmuxApprovalPrompt | null> {
  if (target.kind !== 'codex' && target.kind !== 'omp') return null;
  const parsed = parseApproval(target, await captureTmuxPane(target, run));
  return parsed ? publicPrompt(parsed) : null;
}

export async function answerTmuxApproval(
  target: VerifiedTmuxActionTarget,
  decision: TmuxApprovalDecision,
  run?: TmuxRunner,
): Promise<void> {
  if (target.kind !== 'codex' && target.kind !== 'omp') {
    throw new AppError('This CLI does not support approval selections.', {
      code: 'TMUX_APPROVAL_UNSUPPORTED',
      statusCode: 400,
    });
  }
  const prompt = parseApproval(target, await captureTmuxPane(target, run));
  if (!prompt) {
    throw new AppError('The approval prompt is no longer visible.', {
      code: 'TMUX_APPROVAL_STALE',
      statusCode: 409,
    });
  }
  if (decision === 'approve-remember' && prompt.rememberIndex === null) {
    throw new AppError('This approval has no remember option.', {
      code: 'TMUX_APPROVAL_DECISION_INVALID',
      statusCode: 400,
    });
  }
  if (decision === 'cancel' || (decision === 'reject' && target.kind === 'codex')) {
    await sendTmuxSelectionKeys(target, ['Escape'], run);
    return;
  }
  const desiredIndex = decision === 'approve-once'
    ? prompt.approveIndex
    : decision === 'approve-remember'
      ? prompt.rememberIndex!
      : prompt.rejectIndex;
  const delta = desiredIndex - prompt.selectedIndex;
  const navigation: TmuxSelectionKey[] = delta > 0
    ? Array.from({ length: delta }, () => 'Down' as const)
    : Array.from({ length: Math.abs(delta) }, () => 'Up' as const);
  await sendTmuxSelectionKeys(target, [...navigation, 'Enter'], run);
}
