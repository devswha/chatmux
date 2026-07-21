import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeLiveSessions,
  extractSessionPathsFromLsof,
  findIdleGjcTmuxSessions,
  IDLE_GJC_ID_PREFIX,
  gjcSessionRoots,
  isGjcCommandLine,
  isGjcProcessArgs,
  parsePsArgsTree,
  parseLastModelChange,
  parseTerminalSessionReceipt,
  parseTurnActivity,
  parseLsofPidSessions,
  parseTmuxPanes,
  pickPaneReceipt,
  tmuxHasPanes,
} from '@/modules/providers/services/live-sessions.service.js';

test('tmuxHasPanes detects a running tmux server (>=1 pane line)', () => {
  assert.equal(tmuxHasPanes('alpha\t111\t/workspace/project-alpha\n'), true);
  assert.equal(tmuxHasPanes('   \n\n'), false);
  assert.equal(tmuxHasPanes(''), false);
});

test('parseTmuxPanes splits name<TAB>sid<TAB>pid<TAB>pane_current_command<TAB>cwd (cwd may contain spaces; empty cmd tolerated)', () => {
  const out = parseTmuxPanes(
    'alpha\t$1\t111\tgjc\t/workspace/project-alpha\n' +
    'beta\t$2\t222\tbash\t/workspace/project beta\n' +
    'noc\t$3\t444\t\t/tmp/x\n' +
    '\nbad-line\nnosid\tX9\t333\tgjc\t/tmp\n',
  );
  assert.deepEqual(out, [
    { name: 'alpha', sid: '$1', pid: 111, cmd: 'gjc', cwd: '/workspace/project-alpha' },
    { name: 'beta', sid: '$2', pid: 222, cmd: 'bash', cwd: '/workspace/project beta' },
    // Empty pane_current_command still parses (cmd '') — kind falls back to null.
    { name: 'noc', sid: '$3', pid: 444, cmd: '', cwd: '/tmp/x' },
  ]);
});

test('parseLsofPidSessions pairs uuid with holder pid, path-agnostic (decoy-HOME symlink)', () => {
  const lsof = [
    'p3304033',
    'n/home/test-user/.gjc/agent/sessions/-workspace-project-alpha/2026-07-09T11-22-59-921Z_019f469d-e1d1-7000-a9aa-a942784b0e2b.jsonl',
    'n/home/test-user/.gjc/agent/logs/agent.log',
    'p3436470',
    // decoy-HOME symlink path form still parses:
    'n/home/test-user/.alternate-home/.gjc/agent/sessions/-workspace-project-beta/2026-07-09T11-39-51-634Z_019f46ad-51d2-7000-a5ea-facfd7f23f52.jsonl',
  ].join('\n');
  assert.deepEqual(parseLsofPidSessions(lsof), [
    { id: '019f469d-e1d1-7000-a9aa-a942784b0e2b', pid: 3304033 },
    { id: '019f46ad-51d2-7000-a5ea-facfd7f23f52', pid: 3436470 },
  ]);
});

test('computeLiveSessions maps each live session to its tmux name+id by pid lineage', () => {
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [
      { name: 'pane-alpha', sid: '$1', pid: 1000, cwd: '/workspace/project-alpha' },
      { name: 'pane-beta', sid: '$2', pid: 2000, cwd: '/workspace/project-beta' },
    ],
    sessions: [
      // gjc holder is a descendant of the pane's shell pid (shell 1000 → … → gjc 1500)
      { id: 'p1', pidChain: [1500, 1200, 1000], cwd: '/workspace/project-alpha' },
      { id: 'f1', pidChain: [2500, 2000], cwd: '/workspace/project-beta' },
      { id: 'x1', pidChain: [9999], cwd: '/tmp/unmatched' }, // no pane pid, no cwd → null
      { id: 'n1', pidChain: [], cwd: null },
    ],
  });
  // No pane_current_command supplied → kind falls back to null (existing behaviour preserved).
  assert.deepEqual(result.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'f1', tmuxName: 'pane-beta', tmuxId: '$2', claim: 'lineage', kind: null },
    { id: 'n1', tmuxName: null, tmuxId: null, claim: null, kind: null },
    { id: 'p1', tmuxName: 'pane-alpha', tmuxId: '$1', claim: 'lineage', kind: null },
    { id: 'x1', tmuxName: null, tmuxId: null, claim: null, kind: null },
  ]);
});

test('computeLiveSessions classifies lineage rows by the claimed pane foreground command (interactive vs batch)', () => {
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [
      // foreground command IS gjc → an interactive gjc TUI
      { name: 'interactive-pane', sid: '$1', pid: 1000, cwd: '/w/interactive', cmd: 'gjc' },
      // gjc is a background/batch child under a shell → the pane foreground is bash
      { name: 'batch-pane', sid: '$2', pid: 2000, cwd: '/w/batch', cmd: 'bash' },
    ],
    sessions: [
      { id: 'i1', pidChain: [1500, 1000], cwd: '/w/interactive' },
      { id: 'b1', pidChain: [2500, 2000], cwd: '/w/batch' },
    ],
  });
  assert.deepEqual(result.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'b1', tmuxName: 'batch-pane', tmuxId: '$2', claim: 'lineage', kind: 'batch' },
    { id: 'i1', tmuxName: 'interactive-pane', tmuxId: '$1', claim: 'lineage', kind: 'interactive' },
  ]);
});

test('computeLiveSessions: cwd-label rows and unknown-command lineage rows fall back to kind=null', () => {
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [
      { name: 'pane-alpha', sid: '$1', pid: 1000, cwd: '/w/alpha' },              // lineage, no cmd → null fallback
      { name: 'label-pane', sid: '$9', pid: 9000, cwd: '/w/label', cmd: 'bash' }, // cwd-label pane (gjc not inside)
    ],
    sessions: [
      { id: 'a', pidChain: [1500, 1000], cwd: '/w/alpha' }, // lineage but pane has no cmd
      { id: 'c', pidChain: [7777], cwd: '/w/label' },       // no lineage → unique cwd fallback
    ],
  });
  assert.deepEqual(result.sort((x, y) => x.id.localeCompare(y.id)), [
    { id: 'a', tmuxName: 'pane-alpha', tmuxId: '$1', claim: 'lineage', kind: null },
    { id: 'c', tmuxName: 'label-pane', tmuxId: '$9', claim: 'cwd', kind: null },
  ]);
});

test('computeLiveSessions disambiguates two panes in the same cwd via pid lineage', () => {
  // Two tmux sessions in the SAME cwd: cwd equality is many-to-many, which produced
  // the production bug. Process lineage resolves each gjc session to exactly its own pane,
  // even when a gjc cwd has drifted away from the pane's current path.
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [
      { name: 'pane-alpha', sid: '$1', pid: 1000, cwd: '/workspace/project-shared' },
      { name: 'pane-beta', sid: '$3', pid: 3000, cwd: '/workspace/project-shared' },
    ],
    sessions: [
      { id: '019f469d', pidChain: [1800, 1000], cwd: '/workspace/project-shared/subdir' },
      { id: '019f212c', pidChain: [3800, 3000], cwd: '/workspace/project-shared' },
    ],
  });
  assert.deepEqual(result.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: '019f212c', tmuxName: 'pane-beta', tmuxId: '$3', claim: 'lineage', kind: null },
    { id: '019f469d', tmuxName: 'pane-alpha', tmuxId: '$1', claim: 'lineage', kind: null },
  ]);
});

test('computeLiveSessions never double-labels a pane: cwd fallback skips a lineage-claimed pane (production duplicate-label incident)', () => {
  // 019f469d is lineage-matched to the pane-alpha pane. 019f212c runs in the project-alpha cwd
  // but its shell is NOT the pane's process (nested/other shell) → no lineage hit.
  // The old cwd fallback re-used the pane-alpha pane → "pane-alpha" on two rows. Now the
  // claimed pane is off-limits, so the extra session goes null (title fallback).
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [{ name: 'pane-alpha', sid: '$1', pid: 113501, cwd: '/workspace/project-alpha' }],
    sessions: [
      { id: '019f469d', pidChain: [3304033, 113501], cwd: '/workspace/project-alpha' },
      { id: '019f212c', pidChain: [3901429, 3202543], cwd: '/workspace/project-alpha' },
    ],
  });
  assert.deepEqual(result.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: '019f212c', tmuxName: null, tmuxId: null, claim: null, kind: null },
    { id: '019f469d', tmuxName: 'pane-alpha', tmuxId: '$1', claim: 'lineage', kind: null },
  ]);
});

test('computeLiveSessions falls back to cwd when the lineage misses and the pane is free+unique', () => {
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [{ name: 'pane-alpha', sid: '$4', pid: 5000, cwd: '/workspace/project-alpha' }],
    // holder lineage carries no pane pid (e.g. reparented), but the cwd still matches
    // a single unclaimed pane.
    sessions: [{ id: 'o1', pidChain: [7777, 1], cwd: '/workspace/project-alpha' }],
  });
  // cwd fallback names the row but is LABEL-ONLY: claim 'cwd' (no kill/relay), kind null.
  assert.deepEqual(result, [{ id: 'o1', tmuxName: 'pane-alpha', tmuxId: '$4', claim: 'cwd', kind: null }]);
});

test('computeLiveSessions cwd fallback yields null when multiple unclaimed panes share the cwd', () => {
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [
      { name: 'pane-alpha', sid: '$5', pid: 100, cwd: '/workspace' },
      { name: 'pane-beta', sid: '$6', pid: 200, cwd: '/workspace' },
    ],
    // no lineage hit and the cwd matches two panes → ambiguous → null
    sessions: [{ id: 'a1', pidChain: [999], cwd: '/workspace' }],
  });
  assert.deepEqual(result, [{ id: 'a1', tmuxName: null, tmuxId: null, claim: null, kind: null }]);
});

test('computeLiveSessions merges holder rows by id (worker + main): either reaching the pane names it', () => {
  // One session, two open-file holders (main reaches the pane, worker does not).
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [{ name: 'pane-alpha', sid: '$7', pid: 61685, cwd: '/workspace/project-alpha' }],
    sessions: [
      { id: 's1', pidChain: [3435648, 61685], cwd: '/workspace/project-alpha' },
      { id: 's1', pidChain: [3435700], cwd: null },
    ],
  });
  assert.deepEqual(result, [{ id: 's1', tmuxName: 'pane-alpha', tmuxId: '$7', claim: 'lineage', kind: null }]);
});

test('computeLiveSessions returns empty when no tmux (graceful degradation)', () => {
  assert.deepEqual(
    computeLiveSessions({ tmuxPresent: false, panes: [], sessions: [{ id: 'a', pidChain: [1], cwd: '/x' }] }),
    [],
  );
});

test('extractSessionPathsFromLsof maps session id → transcript path (first path wins)', () => {
  const lsof = [
    'p3304033',
    'n/home/test-user/.gjc/agent/sessions/-workspace-project-alpha/2026-07-09T11-22-59-921Z_019f469d-e1d1-7000-a9aa-a942784b0e2b.jsonl',
    'n/home/test-user/.gjc/agent/logs/agent.log',
    'p999',
    // Same session held by a second process (worker): first path is kept.
    'n/home/test-user/.alternate-home/.gjc/agent/sessions/-workspace-project-alpha/2026-07-09T11-22-59-921Z_019f469d-e1d1-7000-a9aa-a942784b0e2b.jsonl',
  ].join('\n');
  const paths = extractSessionPathsFromLsof(lsof);
  assert.equal(paths.size, 1);
  assert.equal(
    paths.get('019f469d-e1d1-7000-a9aa-a942784b0e2b'),
    '/home/test-user/.gjc/agent/sessions/-workspace-project-alpha/2026-07-09T11-22-59-921Z_019f469d-e1d1-7000-a9aa-a942784b0e2b.jsonl',
  );
});

test('parseLastModelChange returns the LAST model_change in the tail', () => {
  const tail = [
    '{"type":"model_change","id":"a","model":"anthropic/claude-opus-4-8"}',
    '{"type":"message","message":{"role":"user"}}',
    '{"type":"model_change","id":"b","model":"anthropic/claude-fable-5"}',
    '{"type":"message","message":{"role":"assistant"}}',
  ].join('\n');
  assert.equal(parseLastModelChange(tail), 'anthropic/claude-fable-5');
});

test('parseLastModelChange skips a truncated first line and malformed entries', () => {
  const tail = [
    'del","id":"x","model":"anthropic/broken"}', // cut by the tail window
    '{"type":"model_change","model":"openai-codex/gpt-5.5"}',
    'not-json "model_change" garbage',
  ].join('\n');
  assert.equal(parseLastModelChange(tail), 'openai-codex/gpt-5.5');
});

test('parseLastModelChange returns null when no model_change is present', () => {
  assert.equal(parseLastModelChange('{"type":"message"}\n{"type":"turn_end"}'), null);
  assert.equal(parseLastModelChange(''), null);
});

// ─── findIdleGjcTmuxSessions (첫 대화 전 gjc pane 감지 + interactive/batch 분류) ───

test('findIdleGjcTmuxSessions: a foreground-gjc pane with no live claim surfaces as interactive', () => {
  // The pane command IS gjc but it has no open transcript → the lsof pipeline
  // misses it entirely; the idle lane must still list the tmux session.
  const result = findIdleGjcTmuxSessions({
    panes: [{ name: 'pane-alpha', sid: '$10', pid: 100, cmd: 'gjc' }],
    procs: [{ pid: 100, ppid: 1, args: '/usr/local/bin/gjc' }],
    excludedNames: new Set(),
  });
  assert.deepEqual(result, [{ name: 'pane-alpha', sid: '$10', kind: 'interactive' }]);
});

test('findIdleGjcTmuxSessions: gjc as a pane DESCENDANT (shell foreground) surfaces as batch', () => {
  const result = findIdleGjcTmuxSessions({
    panes: [{ name: 'pane-beta', sid: '$11', pid: 200, cmd: 'zsh' }],
    procs: [
      { pid: 200, ppid: 1, args: '-zsh' },
      { pid: 201, ppid: 200, args: '/usr/local/bin/gjc' },
    ],
    excludedNames: new Set(),
  });
  assert.deepEqual(result, [{ name: 'pane-beta', sid: '$11', kind: 'batch' }]);
});

test('findIdleGjcTmuxSessions: a surfaced pane with no cmd falls back to kind=null', () => {
  const result = findIdleGjcTmuxSessions({
    panes: [{ name: 'pane-alpha', sid: '$10', pid: 100 }],
    procs: [{ pid: 100, ppid: 1, args: '/usr/local/bin/gjc' }],
    excludedNames: new Set(),
  });
  assert.deepEqual(result, [{ name: 'pane-alpha', sid: '$10', kind: null }]);
});

test('findIdleGjcTmuxSessions: names claimed by a LINEAGE row are excluded (one actionable row per tmux)', () => {
  // Exclusion set is lineage-only by contract: a cwd label must not hide a
  // subtree-proven idle pane (리뷰 반영) — callers pass lineage names here.
  const result = findIdleGjcTmuxSessions({
    panes: [
      { name: 'claimed-pane', sid: '$12', pid: 300, cmd: 'gjc' },
      { name: 'available-pane', sid: '$13', pid: 400, cmd: 'gjc' },
    ],
    procs: [
      { pid: 300, ppid: 1, args: '/usr/local/bin/gjc' },
      { pid: 400, ppid: 1, args: '/usr/local/bin/gjc' },
    ],
    excludedNames: new Set(['claimed-pane']),
  });
  assert.deepEqual(result, [{ name: 'available-pane', sid: '$13', kind: 'interactive' }]);
});

test('findIdleGjcTmuxSessions: non-gjc panes (claude/codex/ssh) never surface here', () => {
  const result = findIdleGjcTmuxSessions({
    panes: [
      { name: 'pane-alpha', sid: '$14', pid: 500, cmd: 'claude' },
      { name: 'pane-beta', sid: '$15', pid: 600, cmd: 'node' },
    ],
    procs: [
      { pid: 500, ppid: 1, args: '/usr/local/bin/claude' },
      { pid: 600, ppid: 1, args: '/usr/bin/node /srv/devserver/index.js' },
      { pid: 601, ppid: 600, args: '/usr/local/bin/codex' },
    ],
    excludedNames: new Set(),
  });
  assert.deepEqual(result, []);
});

test('findIdleGjcTmuxSessions: unsafe tmux names are dropped (kill/relay discipline)', () => {
  const result = findIdleGjcTmuxSessions({
    panes: [
      { name: 'ok.name-1', sid: '$16', pid: 700, cmd: 'gjc' },
      { name: 'bad name;$(x)', sid: '$17', pid: 800, cmd: 'gjc' },
      { name: '-leading-dash', sid: '$18', pid: 900, cmd: 'gjc' },
    ],
    procs: [
      { pid: 700, ppid: 1, args: '/usr/local/bin/gjc' },
      { pid: 800, ppid: 1, args: '/usr/local/bin/gjc' },
      { pid: 900, ppid: 1, args: '/usr/local/bin/gjc' },
    ],
    excludedNames: new Set(),
  });
  assert.deepEqual(result, [{ name: 'ok.name-1', sid: '$16', kind: 'interactive' }]);
});

test('findIdleGjcTmuxSessions: sorted and deduped across multiple panes of one session', () => {
  const result = findIdleGjcTmuxSessions({
    panes: [
      { name: 'zeta', sid: '$20', pid: 1000, cmd: 'gjc' },
      { name: 'alpha', sid: '$21', pid: 1100, cmd: 'gjc' },
      { name: 'zeta', sid: '$20', pid: 1200, cmd: 'gjc' },
    ],
    procs: [
      { pid: 1000, ppid: 1, args: '/usr/local/bin/gjc' },
      { pid: 1100, ppid: 1, args: '/usr/local/bin/gjc' },
      { pid: 1200, ppid: 1, args: '/usr/local/bin/gjc' },
    ],
    excludedNames: new Set(),
  });
  assert.deepEqual(result, [
    { name: 'alpha', sid: '$21', kind: 'interactive' },
    { name: 'zeta', sid: '$20', kind: 'interactive' },
  ]);
});

test('IDLE_GJC_ID_PREFIX cannot collide with transcript uuids (client contract)', () => {
  // The client distinguishes idle rows by this prefix; a real session id is a
  // uuid-ish token and can never start with it.
  assert.equal(IDLE_GJC_ID_PREFIX, 'idle-gjc:');
  assert.ok(!/^[0-9a-fA-F-]+$/.test(IDLE_GJC_ID_PREFIX));
});

// ─── interpreter-agnostic idle/subtree detection (#1 follow-up) ──────────────

test('findIdleGjcTmuxSessions: a bun-launched gjc pane (comm=bun) surfaces as interactive', () => {
  // Real-world shape from #1: pane_current_command reads 'bun', the process
  // argv is `bun …/gjc`. Both the subtree match and the kind classification
  // must be interpreter-agnostic.
  const result = findIdleGjcTmuxSessions({
    panes: [{ name: 'bun-pane', sid: '$30', pid: 2000, cmd: 'bun' }],
    procs: [{ pid: 2000, ppid: 1, args: '/home/u/.bun/bin/bun /home/u/.bun/bin/gjc' }],
    excludedNames: new Set(),
  });
  assert.deepEqual(result, [{ name: 'bun-pane', sid: '$30', kind: 'interactive' }]);
});

test('findIdleGjcTmuxSessions: a stray "gjc" token deeper in argv never qualifies (kill/relay discipline)', () => {
  // `man gjc` / an editor on a file named gjc must not surface an actionable
  // idle row — only argv[0], or argv[1] behind a bun/node interpreter, counts.
  const result = findIdleGjcTmuxSessions({
    panes: [
      { name: 'man-pane', sid: '$31', pid: 2100, cmd: 'man' },
      { name: 'editor-pane', sid: '$32', pid: 2200, cmd: 'vi' },
    ],
    procs: [
      { pid: 2100, ppid: 1, args: 'man gjc' },
      { pid: 2200, ppid: 1, args: 'vi /tmp/notes/gjc' },
    ],
    excludedNames: new Set(),
  });
  assert.deepEqual(result, []);
});

test('isGjcProcessArgs: argv-anchored — native, bun/node entry, package path; rejects lookalikes', () => {
  assert.equal(isGjcProcessArgs('/usr/local/bin/gjc --resume 019f'), true);
  assert.equal(isGjcProcessArgs('/home/u/.bun/bin/bun /home/u/.bun/bin/gjc'), true);
  assert.equal(isGjcProcessArgs('/usr/bin/node /opt/node_modules/@chatmux-code/coding-agent/bin/gjc.js'), true);
  assert.equal(isGjcProcessArgs('man gjc'), false);
  assert.equal(isGjcProcessArgs('vi /tmp/notes/gjc'), false);
  assert.equal(isGjcProcessArgs('/usr/bin/node /srv/devserver/index.js'), false);
  assert.equal(isGjcProcessArgs(''), false);
});

test('parsePsArgsTree parses pid,ppid + space-containing args and tolerates the header', () => {
  const rows = parsePsArgsTree([
    '    PID    PPID COMMAND',
    '    100       1 /usr/local/bin/gjc --resume 019f',
    '    200     100 bun /home/u/.bun/bin/gjc',
    'garbage line',
  ].join('\n'));
  assert.deepEqual(rows, [
    { pid: 100, ppid: 1, args: '/usr/local/bin/gjc --resume 019f' },
    { pid: 200, ppid: 100, args: 'bun /home/u/.bun/bin/gjc' },
  ]);
});

test('pickPaneReceipt picks the newest receipt matching the pane cwd', () => {
  const receipts = [
    { sessionId: 'old-1', cwd: '/ws', sessionFile: '/t/old.jsonl', mtimeMs: 1_000 },
    { sessionId: 'new-1', cwd: '/ws', sessionFile: '/t/new.jsonl', mtimeMs: 5_000 },
    { sessionId: 'foreign', cwd: '/elsewhere', sessionFile: '/t/f.jsonl', mtimeMs: 9_000 },
  ];
  assert.equal(
    pickPaneReceipt({ paneCwd: '/ws', paneStartMs: null, receipts })?.sessionId,
    'new-1',
  );
});

test('pickPaneReceipt rejects receipts older than the pane process (stale headless run)', () => {
  // A finished headless gjc left this receipt BEFORE the pane existed — it must
  // never capture the new pane.
  const stale = [{ sessionId: 'stale', cwd: '/ws', sessionFile: '/t/s.jsonl', mtimeMs: 1_000 }];
  assert.equal(pickPaneReceipt({ paneCwd: '/ws', paneStartMs: 2_000, receipts: stale }), null);
  // …but the pane-start floor admits receipts written after the pane came up.
  const fresh = [{ sessionId: 'live', cwd: '/ws', sessionFile: '/t/l.jsonl', mtimeMs: 3_000 }];
  assert.equal(
    pickPaneReceipt({ paneCwd: '/ws', paneStartMs: 2_000, receipts: fresh })?.sessionId,
    'live',
  );
});

test('pickPaneReceipt requires a session id and an existing transcript path', () => {
  assert.equal(
    pickPaneReceipt({
      paneCwd: '/ws',
      paneStartMs: null,
      receipts: [
        { sessionId: '', cwd: '/ws', sessionFile: '/t/x.jsonl', mtimeMs: 1 },
        { sessionId: 'no-file', cwd: '/ws', sessionFile: null, mtimeMs: 2 },
      ],
    }),
    null,
  );
});

test('pickPaneReceipt tolerates a null receipt cwd (older gjc builds) but never a mismatch', () => {
  const receipts = [{ sessionId: 'null-cwd', cwd: null, sessionFile: '/t/n.jsonl', mtimeMs: 4 }];
  assert.equal(pickPaneReceipt({ paneCwd: '/ws', paneStartMs: null, receipts })?.sessionId, 'null-cwd');
});

test('parseTerminalSessionReceipt maps gjc 0.11 tmux receipt to its transcript id', () => {
  assert.deepEqual(
    parseTerminalSessionReceipt(
      '/workspace/project\n/home/user/.gjc/agent/sessions/v2-scope/2026-07-17T17-28-17_019f711f-31f5-7000-9e7e-31f808b9ba71.jsonl\n',
      1234,
    ),
    {
      sessionId: '019f711f-31f5-7000-9e7e-31f808b9ba71',
      cwd: '/workspace/project',
      sessionFile: '/home/user/.gjc/agent/sessions/v2-scope/2026-07-17T17-28-17_019f711f-31f5-7000-9e7e-31f808b9ba71.jsonl',
      mtimeMs: 1234,
    },
  );
  assert.equal(parseTerminalSessionReceipt('/workspace/project\n/not-a-session.txt\n', 1234), null);
});

// ─── parseTurnActivity (턴 진행 중 판정 — RUN/LIVE 배지) ─────────────────────

const turnLine = (role: string, stopReason?: string) =>
  JSON.stringify({ type: 'message', id: 'x', message: { role, content: [], ...(stopReason ? { stopReason } : {}) } });

test('parseTurnActivity: the LAST turn-relevant record decides (실측 gjc 스키마)', () => {
  // assistant stop = turn finished
  assert.equal(parseTurnActivity([turnLine('user'), turnLine('assistant', 'toolUse'), turnLine('assistant', 'stop')].join('\n')), false);
  // assistant error = turn finished
  assert.equal(parseTurnActivity([turnLine('user'), turnLine('assistant', 'error')].join('\n')), false);
  // trailing user message = turn requested, in progress
  assert.equal(parseTurnActivity([turnLine('assistant', 'stop'), turnLine('user')].join('\n')), true);
  // trailing toolUse = mid tool loop
  assert.equal(parseTurnActivity([turnLine('user'), turnLine('assistant', 'toolUse')].join('\n')), true);
  // trailing toolResult = mid tool loop
  assert.equal(parseTurnActivity([turnLine('assistant', 'toolUse'), turnLine('toolResult')].join('\n')), true);
});

test('parseTurnActivity: non-message and foreign lines are skipped, partial lines tolerated', () => {
  const tail = [
    turnLine('user'),
    JSON.stringify({ type: 'model_change', model: 'claude-fable-5' }),
    JSON.stringify({ type: 'custom', message: 'not-a-turn-record' }),
    '{"type":"message","message":{"role":"assist', // mid-write partial
  ].join('\n');
  assert.equal(parseTurnActivity(tail), true, 'falls through to the last complete user record');
});

test('parseTurnActivity: no turn-relevant record in the window returns null (fail-safe LIVE)', () => {
  assert.equal(parseTurnActivity(''), null);
  assert.equal(parseTurnActivity(JSON.stringify({ type: 'session' })), null);
  assert.equal(parseTurnActivity(JSON.stringify({ type: 'message', message: { role: 'system' } })), null);
});

test('isGjcCommandLine matches gjc as a native binary AND under bun/node interpreters (comm-agnostic)', () => {
  // NUL-joined argv, exactly as /proc/<pid>/cmdline reads. Built via join('\0')
  // because a '\0' literal followed by a digit ('\0019f…') parses as an octal
  // escape and is rejected by tsc/eslint.
  const cmdline = (...argv: string[]) => argv.join('\0');
  // native binary: comm would read "gjc"
  assert.equal(isGjcCommandLine(cmdline('/usr/local/bin/gjc', '--resume', '019f6f27', '')), true);
  // bun launcher — real-world case where comm reads "bun" (the regression this fixes)
  assert.equal(isGjcCommandLine(cmdline('/home/u/.bun/bin/bun', '/home/u/.bun/bin/gjc', '--resume', '019f6f27')), true);
  // node launching the packaged entry (basename is gjc.js — matched via the package path)
  assert.equal(isGjcCommandLine(cmdline('/usr/bin/node', '/opt/node_modules/@chatmux-code/coding-agent/bin/gjc.js', 'start')), true);
  // NOT gjc: the app server and its native watcher must never be mistaken for a session holder
  assert.equal(isGjcCommandLine(cmdline('/usr/bin/node', '/home/u/.chatmux/current/scripts/chatmux-runtime.mjs', 'start')), false);
  assert.equal(isGjcCommandLine(cmdline('/home/u/.chatmux/current/dist-native/chatmux-core', 'watch', '--root', '/home/u/.gjc/agent/sessions')), false);
  assert.equal(isGjcCommandLine(''), false);
});

test('gjcSessionRoots honours GJC_LIVE_SESSION_DIR and otherwise defaults to <tmp>/gjc-live-sessions', () => {
  const original = process.env.GJC_LIVE_SESSION_DIR;
  try {
    process.env.GJC_LIVE_SESSION_DIR = '/custom/live';
    const roots = gjcSessionRoots();
    assert.equal(roots.length, 2);
    assert.ok(roots[0].endsWith('/.gjc/agent/sessions'));
    assert.equal(roots[1], '/custom/live');
    delete process.env.GJC_LIVE_SESSION_DIR;
    assert.ok(gjcSessionRoots()[1].endsWith('/gjc-live-sessions'));
  } finally {
    if (original === undefined) {
      delete process.env.GJC_LIVE_SESSION_DIR;
    } else {
      process.env.GJC_LIVE_SESSION_DIR = original;
    }
  }
});
