import assert from 'node:assert/strict';
import test from 'node:test';

import {
  answerTmuxInteractivePrompt,
  parseTmuxInteractivePrompt,
} from '@/modules/providers/services/tmux-interactive-prompt.service.js';
import type { TmuxRunner } from '@/modules/providers/services/builtin-relay.service.js';
import { createVerifiedTmuxActionTarget } from '@/modules/providers/services/tmux-fresh-verifier.service.js';

test('parses Codex questions and command approvals from the active TUI', () => {
  const question = parseTmuxInteractivePrompt('codex', `
Question 1/1 (1 unanswered)
Which export format should we use?

› 1. ONNX               Export a portable ONNX model.
  2. TensorRT           Build an NVIDIA TensorRT engine.
  3. RKNN               Build an RKNN model.
  4. None of the above  Optionally, add details in notes (tab).

tab to add notes | enter to submit answer | esc to interrupt
`);
  assert.equal(question?.kind, 'question');
  assert.equal(question?.question, 'Which export format should we use?');
  assert.deepEqual(question?.options.map((option) => option.label), [
    'ONNX',
    'TensorRT',
    'RKNN',
  ]);
  assert.equal(question?.options[0]?.description, 'Export a portable ONNX model.');
  assert.equal(question?.customOptionNumber, 4);

  const approval = parseTmuxInteractivePrompt('codex', `
Would you like to run the following command?

Environment: local
$ curl -I https://example.com

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with curl
  3. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel
`);
  assert.equal(approval?.kind, 'approval');
  assert.equal(approval?.options.length, 3);
  assert.match(approval?.body ?? '', /curl -I/);
});

test('parses Claude questions, command approvals, and plan approval without transcript data', () => {
  const question = parseTmuxInteractivePrompt('claude', `
☐ Dataset

Which evaluation dataset should we use?

❯ 1. LM-O
     Occlusion benchmark.
  2. YCB-V
     Household objects.
  3. T-LESS
     Texture-less objects.
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`);
  assert.equal(question?.kind, 'question');
  assert.equal(question?.question, 'Which evaluation dataset should we use?');
  assert.deepEqual(question?.options.map((option) => option.label), [
    'LM-O',
    'YCB-V',
    'T-LESS',
  ]);
  assert.equal(question?.customOptionNumber, 4);

  const approval = parseTmuxInteractivePrompt('claude', `
Bash command

  curl -I https://example.com
  Fetch HTTP headers.

This command requires approval

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don’t ask again for: curl *
  3. No

Esc to cancel · Tab to amend · ctrl+e to explain
`);
  assert.equal(approval?.kind, 'approval');
  assert.deepEqual(approval?.options.map((option) => option.label), [
    'Yes',
    'Yes, and don’t ask again for: curl *',
    'No',
  ]);

  const plan = parseTmuxInteractivePrompt('claude', `
Ready to code?

Here is Claude's plan:
Add a heading to the README file.

Claude has written up a plan and is ready to execute. Would you like to proceed?

❯ 1. Yes, auto-accept edits
  2. Yes, manually approve edits
  3. No, refine with Ultraplan on Claude Code on the web
  4. Tell Claude what to change
     shift+tab to approve with this feedback
`);
  assert.equal(plan?.kind, 'plan');
  assert.equal(plan?.customOptionNumber, 4);
  assert.match(plan?.body ?? '', /README/);
});

test('parses GJC and OMP single and multi-select menus', () => {
  const gjcSingle = parseTmuxInteractivePrompt('gjc', `
Which backend should we use?
╭─────────────────────────╮
│❯ CUDA                   │
│  CPU                    │
│  Other (type your own)  │
╰─────────────────────────╯
up/down navigate  enter select  esc cancel
`);
  assert.equal(gjcSingle?.multiSelect, false);
  assert.deepEqual(gjcSingle?.options.map((option) => option.label), ['CUDA', 'CPU']);

  const gjcMulti = parseTmuxInteractivePrompt('gjc', `
(1 selected) Which checks should run?
╭─────────────────────────╮
│❯ ☑ Lint                 │
│  ☐ Tests                │
│  ☐ Build                │
│  ✔ Done selecting       │
│  Other (type your own)  │
╰─────────────────────────╯
up/down navigate  enter select  esc cancel
`);
  assert.equal(gjcMulti?.multiSelect, true);
  assert.deepEqual(gjcMulti?.options.map((option) => option.label), ['Lint', 'Tests', 'Build']);

  const ompSingle = parseTmuxInteractivePrompt('omp', `
╭─ Ask ───────────────────╮
│ Which target?           │
├─────────────────────────┤
│❯ ○ Jetson Orin         │
│  ○ RK3588               │
│  ○ Other (type your own)│
├─────────────────────────┤
│ Enter select · n note · ↑/↓ move · Esc cancel
╰─────────────────────────╯
`);
  assert.equal(ompSingle?.multiSelect, false);
  assert.deepEqual(ompSingle?.options.map((option) => option.label), ['Jetson Orin', 'RK3588']);

  const ompMulti = parseTmuxInteractivePrompt('omp', `
╭─ Ask ───────────────────╮
│ Which checks?           │
├─────────────────────────┤
│❯ ☐ Lint                │
│  ☐ Tests                │
│  ☐ Other (type your own)│
├─────────────────────────┤
│ Space/Enter toggle · n note · ↑/↓ move · Tab/←/→ · Esc cancel
╰─────────────────────────╯
`);
  assert.equal(ompMulti?.multiSelect, true);
  assert.deepEqual(ompMulti?.options.map((option) => option.label), ['Lint', 'Tests']);

  const ompApproval = parseTmuxInteractivePrompt('omp', `
╭─ Permission ────────────╮
│ Allow tool: bash        │
│ curl -I example.com     │
│❯ Approve               │
│  Deny                  │
╰─────────────────────────╯
`);
  assert.equal(ompApproval?.kind, 'approval');
  assert.deepEqual(ompApproval?.options.map((option) => option.label), ['Approve', 'Deny']);
});

test('parses Claude multi-select questions', () => {
  const prompt = parseTmuxInteractivePrompt('claude', `
☐ Checks

Which checks should run?

❯ 1. [ ] Lint
  2. [x] Tests
  3. [ ] Build
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`);
  assert.equal(prompt?.kind, 'question');
  assert.equal(prompt?.multiSelect, true);
  assert.deepEqual(prompt?.options.map((option) => option.label), ['Lint', 'Tests', 'Build']);
});

test('does not mistake ordinary transcript text for an active prompt', () => {
  assert.equal(
    parseTmuxInteractivePrompt('claude', 'No response requested. The task is complete.'),
    null,
  );
  assert.equal(
    parseTmuxInteractivePrompt('codex', 'You approved the command and it finished.'),
    null,
  );
  assert.equal(parseTmuxInteractivePrompt('codex', `
Would you like to run the following command?
› 1. Yes, proceed
  2. No, and tell Codex what to do differently
Press enter to confirm or esc to cancel

• Command completed successfully.
› Ask Codex to do something
`), null);
});

test('multi-select answers toggle only changed options and submit through provider-native keys', async () => {
  const screen = `
╭─ Ask ───────────────────╮
│ Which checks?           │
├─────────────────────────┤
│❯ ☐ Lint                │
│  ☐ Tests                │
│  ☐ Build                │
│  ☐ Other (type your own)│
├─────────────────────────┤
│ Space/Enter toggle · n note · ↑/↓ move · Tab/←/→ · Esc cancel
╰─────────────────────────╯
`;
  const prompt = parseTmuxInteractivePrompt('omp', screen);
  assert.ok(prompt);
  const calls: string[][] = [];
  const run: TmuxRunner = async (args) => {
    calls.push(args);
    if (args.includes('capture-pane')) return { code: 0, output: screen };
    if (args.includes('display-message')) return { code: 0, output: '$7\t@8\t%9\n' };
    return { code: 0, output: '' };
  };
  const target = createVerifiedTmuxActionTarget(
    {
      socketPath: '/tmp/chatmux-interactive-test.sock',
      sessionId: '$7',
      windowId: '@8',
      paneId: '%9',
    },
    { pid: 42, startedAtMs: 1234 },
    'omp',
    null,
  );

  await answerTmuxInteractivePrompt(target, prompt.id, [1, 3], run);
  assert.deepEqual(
    calls.filter((args) => args.includes('send-keys')).map((args) => args.at(-1)),
    ['Space', 'Down', 'Down', 'Space', 'Tab', 'Enter'],
  );
});

test('prompt id remains stable while the native cursor and checked state change', () => {
  const first = parseTmuxInteractivePrompt('gjc', `
(1 selected) Which checks should run?
╭─────────────────────────╮
│❯ ☑ Lint                 │
│  ☐ Tests                │
│  ✔ Done selecting       │
│  Other (type your own)  │
╰─────────────────────────╯
up/down navigate  enter select  esc cancel
`);
  const second = parseTmuxInteractivePrompt('gjc', `
(1 selected) Which checks should run?
╭─────────────────────────╮
│  ☑ Lint                 │
│❯ ☐ Tests                │
│  ✔ Done selecting       │
│  Other (type your own)  │
╰─────────────────────────╯
up/down navigate  enter select  esc cancel
`);
  assert.ok(first);
  assert.equal(first.id, second?.id);
});

test('Claude multi-select answers are rejected without injecting keys until the toggle sequence is verified', async () => {
  const screen = `
☐ Checks

Which checks should run?

❯ 1. [ ] Lint
  2. [x] Tests
  3. [ ] Build
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
  const prompt = parseTmuxInteractivePrompt('claude', screen);
  assert.ok(prompt);
  const calls: string[][] = [];
  const run: TmuxRunner = async (args) => {
    calls.push(args);
    if (args.includes('capture-pane')) return { code: 0, output: screen };
    if (args.includes('display-message')) return { code: 0, output: '$7\t@8\t%9\n' };
    return { code: 0, output: '' };
  };
  const target = createVerifiedTmuxActionTarget(
    {
      socketPath: '/tmp/chatmux-interactive-test.sock',
      sessionId: '$7',
      windowId: '@8',
      paneId: '%9',
    },
    { pid: 42, startedAtMs: 1234 },
    'claude',
    null,
  );

  await assert.rejects(
    answerTmuxInteractivePrompt(target, prompt.id, [1, 3], run),
    (error: { code?: string }) => error.code === 'TMUX_INTERACTIVE_CHOICE_UNSUPPORTED',
  );
  assert.equal(calls.some((args) => args.includes('send-keys')), false);
});
