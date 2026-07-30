import assert from 'node:assert/strict';
import test from 'node:test';

import {
  answerPendingTmuxAskSelection,
  findPendingTmuxAsk,
  parseClaudeAskCustomInputScreen,
  parseClaudeAskSelectionScreen,
  parseCodexAskCustomInputScreen,
  parseCodexAskSelectionScreen,
  parseGjcAskCustomInputScreen,
  parseGjcAskSelectionScreen,
  parseOmpAskCustomInputScreen,
  parseOmpAskSelectionScreen,
  submitPendingTmuxAskCustomResponse,
} from '@/modules/providers/services/tmux-ask-selection.service.js';
import type { TmuxRunner } from '@/modules/providers/services/builtin-relay.service.js';
import { createVerifiedTmuxActionTarget } from '@/modules/providers/services/tmux-fresh-verifier.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

const question = {
  question: '테스트 선택',
  options: [{ label: '승인' }, { label: '계속' }, { label: '거부' }],
};

test('GJC selector parser maps options, direct input, and cancel', () => {
  const screen = [
    ' 테스트 선택',
    '│❯ 승인 │',
    '│  계속 │',
    '│  거부 │',
    '│  Other (type your own) │',
    ' up/down navigate  enter select  esc cancel',
  ].join('\n');
  assert.deepEqual(parseGjcAskSelectionScreen(screen, question, 2), {
    action: 'option',
    delta: 2,
    label: '거부',
  });
  assert.equal(parseGjcAskSelectionScreen(screen, question, 3)?.action, 'other');
  assert.equal(parseGjcAskSelectionScreen(screen, question, -1)?.action, 'cancel');
  assert.equal(
    parseGjcAskSelectionScreen(screen.replace('enter select', 'completed'), question, 0),
    null,
  );
});

test('Codex and OMP selector parsers require the matching active native prompt', () => {
  const codex = `
Question 1/1 (1 unanswered)
테스트 선택
› 1. 승인
  2. 계속
  3. 거부
  4. None of the above
tab to add notes | enter to submit answer | esc to interrupt
`;
  assert.equal(parseCodexAskSelectionScreen(codex, question, 1)?.label, '계속');
  assert.equal(parseCodexAskSelectionScreen(codex, question, 3)?.action, 'other');
  assert.equal(
    parseCodexAskSelectionScreen(codex.replace('테스트 선택', '다른 질문'), question, 0),
    null,
  );

  const omp = `
╭─ Ask ─╮
│ 테스트 선택 │
│ ❯ ○ 승인 (Recommended) │
│   ○ 계속 │
│   ○ 거부 │
│   ○ Other (type your own) │
│ Enter select · n note · ↑/↓ move · Esc cancel │
╰────╯
`;
  assert.equal(parseOmpAskSelectionScreen(omp, question, 2)?.label, '거부');
  assert.equal(parseOmpAskSelectionScreen(omp, question, 3)?.action, 'other');
});

test('Claude selector parser maps transcript options without exposing Chat about this', () => {
  const claude = `
 ☐ Test

테스트 선택

❯ 1. 승인
     Approve once.
  2. 계속
     Continue safely.
  3. 거부
     Reject the request.
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
  assert.deepEqual(parseClaudeAskSelectionScreen(claude, question, 2), {
    action: 'option',
    delta: 2,
    label: '거부',
  });
  assert.deepEqual(parseClaudeAskSelectionScreen(claude, question, 3), {
    action: 'other',
    delta: 3,
    label: 'Direct input',
  });
  assert.equal(parseClaudeAskSelectionScreen(claude, question, -1)?.action, 'cancel');
  assert.equal(
    parseClaudeAskSelectionScreen(claude.replace('테스트 선택', '다른 질문'), question, 0),
    null,
  );
});

test('custom answer parsers fail closed unless the provider-specific input is active', () => {
  assert.equal(parseGjcAskCustomInputScreen(`
테스트 선택
│  승인 │
│  계속 │
│  거부 │
│❯ Other (type your own) │
>
enter submit  esc back to options  ctrl+g external editor
`, question), true);
  assert.equal(parseCodexAskCustomInputScreen(`
테스트 선택
4. None of the above
› Add notes
tab or esc to clear notes | enter to submit answer
`, question), true);
  assert.equal(parseOmpAskCustomInputScreen(`
Custom answer: 테스트 선택
>
enter or ctrl+q submit  esc cancel
`, question), true);
  assert.equal(parseOmpAskCustomInputScreen(`
Custom answer: 다른 질문
>
enter or ctrl+q submit  esc cancel
`, question), false);
  assert.equal(parseClaudeAskCustomInputScreen(`
테스트 선택
  1. 승인
  2. 계속
  3. 거부
❯ 4. Type something.
  5. Chat about this
Enter to select · ↑/↓ to navigate · ctrl+g to edit in VS Code · Esc to cancel
`, question), true);
  assert.equal(parseClaudeAskCustomInputScreen(`
테스트 선택
❯ 1. 승인
  2. 계속
  3. 거부
  4. Type something.
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`, question), false);
});

test('pending transcript ask accepts only the newest unanswered single-select tool id', () => {
  const base = {
    id: 'message-1',
    sessionId: 'session-1',
    timestamp: '2026-07-31T00:00:00.000Z',
    provider: 'codex',
    kind: 'tool_use',
    toolName: 'AskUserQuestion',
    toolId: 'ask-1',
    toolInput: { questions: [question] },
  } satisfies NormalizedMessage;

  assert.deepEqual(findPendingTmuxAsk([base], 'ask-1'), {
    toolId: 'ask-1',
    questions: [question],
  });
  assert.equal(findPendingTmuxAsk([base], 'old-id'), null);
  assert.equal(findPendingTmuxAsk([{ ...base, toolResult: { content: 'done' } }], 'ask-1'), null);
  assert.equal(findPendingTmuxAsk([{
    ...base,
    toolInput: { questions: [{ ...question, multiSelect: true }] },
  }], 'ask-1'), null);
});

test('Claude direct input navigates to the editable row without submitting it', async () => {
  const screen = `
테스트 선택
❯ 1. 승인
  2. 계속
  3. 거부
  4. Type something.
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`;
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const outputs = [
    screen,
    '$7\t@8\t%9\n',
    '',
    '',
    '',
  ];
  const run: TmuxRunner = async (args, stdin) => {
    calls.push({ args, ...(stdin === undefined ? {} : { stdin }) });
    return { code: 0, output: outputs.shift() ?? '' };
  };
  const target = createVerifiedTmuxActionTarget(
    {
      socketPath: '/tmp/chatmux-test.sock',
      sessionId: '$7',
      windowId: '@8',
      paneId: '%9',
    },
    { pid: 42, startedAtMs: 1234 },
    'claude',
    'test',
    'claude-session',
  );
  const pending = { toolId: 'ask-1', questions: [question] };

  assert.deepEqual(await answerPendingTmuxAskSelection(target, pending, 3, run), {
    questionIndex: 0,
    action: 'other',
    label: 'Direct input',
  });
  const sentKeys = calls
    .filter(({ args }) => args.includes('send-keys'))
    .map(({ args }) => args.at(-1));
  assert.deepEqual(sentKeys, ['Down', 'Down', 'Down']);

  const customScreen = screen
    .replace('❯ 1. 승인', '  1. 승인')
    .replace('  4. Type something.', '❯ 4. Type something.')
    .replace('Esc to cancel', 'ctrl+g to edit in VS Code · Esc to cancel');
  calls.length = 0;
  outputs.push(customScreen, '$7\t@8\t%9\n', '', '', '');
  assert.deepEqual(
    await submitPendingTmuxAskCustomResponse(target, pending, '직접 입력 답변', run),
    { questionIndex: 0 },
  );
  assert.equal(calls.find(({ args }) => args.includes('load-buffer'))?.stdin, '직접 입력 답변');
  assert.equal(calls.at(-1)?.args.at(-1), 'Enter');
});
