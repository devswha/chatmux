import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeLiveSessions,
  dedupeLiveSessionsByLineage,
  extractSessionPathsFromLsof,
  findIdleGjcTmuxSessions,
  IDLE_GJC_ID_PREFIX,
  gjcSessionRoots,
  isGjcCommandLine,
  isGjcProcessArgs,
  parsePsArgsTree,
  parseLastModelChange,
  parseLastSessionPreferences,
  parseTerminalSessionReceipt,
  parseTurnActivity,
  parseLsofPidSessions,
  parseTmuxPanes,
  pickPaneReceipt,
  tmuxHasPanes,
} from '@/modules/providers/services/live-sessions.service.js';

const TMUX_SOCKET_PATH = '/tmp/tmux-1000/default';

function tmux(sessionId: string, windowId: string, paneId: string) {
  return { socketPath: TMUX_SOCKET_PATH, sessionId, windowId, paneId };
}

function processGeneration(pid: number, startedAtMs = 1_700_000_000_000) {
  return { pid, startedAtMs };
}

test('tmuxHasPanes detects a running tmux server (>=1 pane line)', () => {
  assert.equal(tmuxHasPanes('alpha\t111\t/workspace/project-alpha\n'), true);
  assert.equal(tmuxHasPanes('   \n\n'), false);
  assert.equal(tmuxHasPanes(''), false);
});

test('parseTmuxPanes splits exact identity<TAB>name<TAB>pid<TAB>pane_current_command<TAB>cwd (cwd may contain spaces; empty cmd tolerated)', () => {
  const out = parseTmuxPanes(
    '/tmp/tmux-1000/default\t$1\t@111\t%111\talpha\t111\tgjc\t/workspace/project-alpha\n' +
    '/tmp/tmux-1000/default\t$2\t@222\t%222\tbeta\t222\tbash\t/workspace/project beta\n' +
    '/tmp/tmux-1000/default\t$3\t@444\t%444\tnoc\t444\t\t/tmp/x\n' +
    '\nbad-line\n/tmp/tmux-1000/default\tX9\t@333\t%333\tnosid\t333\tgjc\t/tmp\n',
  );
  assert.deepEqual(out, [
    { name: 'alpha', tmux: tmux('$1', '@111', '%111'), pid: 111, cmd: 'gjc', cwd: '/workspace/project-alpha' },
    { name: 'beta', tmux: tmux('$2', '@222', '%222'), pid: 222, cmd: 'bash', cwd: '/workspace/project beta' },
    // Empty pane_current_command still parses (cmd '') — kind falls back to null.
    { name: 'noc', tmux: tmux('$3', '@444', '%444'), pid: 444, cmd: '', cwd: '/tmp/x' },
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
      { name: 'pane-alpha', tmux: tmux('$1', '@1000', '%1000'), pid: 1000, cwd: '/workspace/project-alpha' },
      { name: 'pane-beta', tmux: tmux('$2', '@2000', '%2000'), pid: 2000, cwd: '/workspace/project-beta' },
    ],
    sessions: [
      // gjc holder is a descendant of the pane's shell pid (shell 1000 → … → gjc 1500)
      { id: 'p1', pidChain: [1500, 1200, 1000], cwd: '/workspace/project-alpha', process: processGeneration(1500) },
      { id: 'f1', pidChain: [2500, 2000], cwd: '/workspace/project-beta', process: processGeneration(2500) },
      { id: 'x1', pidChain: [9999], cwd: '/tmp/unmatched', process: processGeneration(9999) }, // no pane pid, no cwd → null
      { id: 'n1', pidChain: [], cwd: null, process: null },
    ],
  });
  // No pane_current_command supplied → kind falls back to null (existing behaviour preserved).
  assert.deepEqual(result.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'f1', tmuxName: 'pane-beta', tmux: tmux('$2', '@2000', '%2000'), process: processGeneration(2500), claim: 'lineage', kind: null },
    { id: 'n1', tmuxName: null, tmux: null, process: null, claim: null, kind: null },
    { id: 'p1', tmuxName: 'pane-alpha', tmux: tmux('$1', '@1000', '%1000'), process: processGeneration(1500), claim: 'lineage', kind: null },
    { id: 'x1', tmuxName: null, tmux: null, process: null, claim: null, kind: null },
  ]);
});

test('computeLiveSessions classifies lineage rows by the claimed pane foreground command (interactive vs batch)', () => {
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [
      // foreground command IS gjc → an interactive gjc TUI
      { name: 'interactive-pane', tmux: tmux('$1', '@1000', '%1000'), pid: 1000, cwd: '/w/interactive', cmd: 'gjc' },
      // gjc is a background/batch child under a shell → the pane foreground is bash
      { name: 'batch-pane', tmux: tmux('$2', '@2000', '%2000'), pid: 2000, cwd: '/w/batch', cmd: 'bash' },
    ],
    sessions: [
      { id: 'i1', pidChain: [1500, 1000], cwd: '/w/interactive', process: processGeneration(1500) },
      { id: 'b1', pidChain: [2500, 2000], cwd: '/w/batch', process: processGeneration(2500) },
    ],
  });
  assert.deepEqual(result.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'b1', tmuxName: 'batch-pane', tmux: tmux('$2', '@2000', '%2000'), process: processGeneration(2500), claim: 'lineage', kind: 'batch' },
    { id: 'i1', tmuxName: 'interactive-pane', tmux: tmux('$1', '@1000', '%1000'), process: processGeneration(1500), claim: 'lineage', kind: 'interactive' },
  ]);
});

test('computeLiveSessions: cwd-label rows and unknown-command lineage rows fall back to kind=null', () => {
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [
      { name: 'pane-alpha', tmux: tmux('$1', '@1000', '%1000'), pid: 1000, cwd: '/w/alpha' },              // lineage, no cmd → null fallback
      { name: 'label-pane', tmux: tmux('$9', '@9000', '%9000'), pid: 9000, cwd: '/w/label', cmd: 'bash' }, // cwd-label pane (gjc not inside)
    ],
    sessions: [
      { id: 'a', pidChain: [1500, 1000], cwd: '/w/alpha', process: processGeneration(1500) }, // lineage but pane has no cmd
      { id: 'c', pidChain: [7777], cwd: '/w/label', process: processGeneration(7777) },       // no lineage → unique cwd fallback
    ],
  });
  assert.deepEqual(result.sort((x, y) => x.id.localeCompare(y.id)), [
    { id: 'a', tmuxName: 'pane-alpha', tmux: tmux('$1', '@1000', '%1000'), process: processGeneration(1500), claim: 'lineage', kind: null },
    { id: 'c', tmuxName: 'label-pane', tmux: tmux('$9', '@9000', '%9000'), process: null, claim: 'cwd', kind: null },
  ]);
});

test('computeLiveSessions disambiguates two panes in the same cwd via pid lineage', () => {
  // Two tmux sessions in the SAME cwd: cwd equality is many-to-many, which produced
  // the production bug. Process lineage resolves each gjc session to exactly its own pane,
  // even when a gjc cwd has drifted away from the pane's current path.
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [
      { name: 'pane-alpha', tmux: tmux('$1', '@1000', '%1000'), pid: 1000, cwd: '/workspace/project-shared' },
      { name: 'pane-beta', tmux: tmux('$3', '@3000', '%3000'), pid: 3000, cwd: '/workspace/project-shared' },
    ],
    sessions: [
      { id: '019f469d', pidChain: [1800, 1000], cwd: '/workspace/project-shared/subdir', process: processGeneration(1800) },
      { id: '019f212c', pidChain: [3800, 3000], cwd: '/workspace/project-shared', process: processGeneration(3800) },
    ],
  });
  assert.deepEqual(result.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: '019f212c', tmuxName: 'pane-beta', tmux: tmux('$3', '@3000', '%3000'), process: processGeneration(3800), claim: 'lineage', kind: null },
    { id: '019f469d', tmuxName: 'pane-alpha', tmux: tmux('$1', '@1000', '%1000'), process: processGeneration(1800), claim: 'lineage', kind: null },
  ]);
});

test('computeLiveSessions never double-labels a pane: cwd fallback skips a lineage-claimed pane (production duplicate-label incident)', () => {
  // 019f469d is lineage-matched to the pane-alpha pane. 019f212c runs in the project-alpha cwd
  // but its shell is NOT the pane's process (nested/other shell) → no lineage hit.
  // The old cwd fallback re-used the pane-alpha pane → "pane-alpha" on two rows. Now the
  // claimed pane is off-limits, so the extra session goes null (title fallback).
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [{ name: 'pane-alpha', tmux: tmux('$1', '@113501', '%113501'), pid: 113501, cwd: '/workspace/project-alpha' }],
    sessions: [
      { id: '019f469d', pidChain: [3304033, 113501], cwd: '/workspace/project-alpha', process: processGeneration(3304033) },
      { id: '019f212c', pidChain: [3901429, 3202543], cwd: '/workspace/project-alpha', process: processGeneration(3901429) },
    ],
  });
  assert.deepEqual(result.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: '019f212c', tmuxName: null, tmux: null, process: null, claim: null, kind: null },
    { id: '019f469d', tmuxName: 'pane-alpha', tmux: tmux('$1', '@113501', '%113501'), process: processGeneration(3304033), claim: 'lineage', kind: null },
  ]);
});

test('computeLiveSessions: cwd fallback skips a SIBLING pane of an already lineage-claimed tmux session (patina 중복)', () => {
  // One tmux session ($95, "patina") with TWO panes. 019f844a is lineage-matched to
  // pane pid 1000. 019ed9eb is a live holder with no lineage hit whose cwd equals the
  // session cwd; the old fallback attached it to the SIBLING pane (pid 2000, same $95)
  // → two "patina" rows for one tmux session. Now an already-claimed sessionId is off-limits,
  // so the extra session goes null (title fallback) instead of duplicating patina.
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [
      { name: 'patina', tmux: tmux('$95', '@1000', '%1000'), pid: 1000, cwd: '/workspace/chatmux' },
      { name: 'patina', tmux: tmux('$95', '@2000', '%2000'), pid: 2000, cwd: '/workspace/chatmux' },
    ],
    sessions: [
      { id: '019f844a', pidChain: [3304033, 1000], cwd: '/workspace/chatmux', process: processGeneration(3304033) },
      { id: '019ed9eb', pidChain: [9999999], cwd: '/workspace/chatmux', process: processGeneration(9999999) },
    ],
  });
  assert.deepEqual(result.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: '019ed9eb', tmuxName: null, tmux: null, process: null, claim: null, kind: null },
    { id: '019f844a', tmuxName: 'patina', tmux: tmux('$95', '@1000', '%1000'), process: processGeneration(3304033), claim: 'lineage', kind: null },
  ]);
});

test('computeLiveSessions falls back to cwd when the lineage misses and the pane is free+unique', () => {
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [{ name: 'pane-alpha', tmux: tmux('$4', '@5000', '%5000'), pid: 5000, cwd: '/workspace/project-alpha' }],
    // holder lineage carries no pane pid (e.g. reparented), but the cwd still matches
    // a single unclaimed pane.
    sessions: [{ id: 'o1', pidChain: [7777, 1], cwd: '/workspace/project-alpha', process: processGeneration(7777) }],
  });
  // cwd fallback names the row but is LABEL-ONLY: claim 'cwd' (no kill/relay), kind null.
  assert.deepEqual(result, [{ id: 'o1', tmuxName: 'pane-alpha', tmux: tmux('$4', '@5000', '%5000'), process: null, claim: 'cwd', kind: null }]);
});

test('computeLiveSessions cwd fallback yields null when multiple unclaimed panes share the cwd', () => {
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [
      { name: 'pane-alpha', tmux: tmux('$5', '@100', '%100'), pid: 100, cwd: '/workspace' },
      { name: 'pane-beta', tmux: tmux('$6', '@200', '%200'), pid: 200, cwd: '/workspace' },
    ],
    // no lineage hit and the cwd matches two panes → ambiguous → null
    sessions: [{ id: 'a1', pidChain: [999], cwd: '/workspace', process: processGeneration(999) }],
  });
  assert.deepEqual(result, [{ id: 'a1', tmuxName: null, tmux: null, process: null, claim: null, kind: null }]);
});

test('computeLiveSessions merges holder rows by id (worker + main): either reaching the pane names it', () => {
  // One session, two open-file holders (main reaches the pane, worker does not).
  const result = computeLiveSessions({
    tmuxPresent: true,
    panes: [{ name: 'pane-alpha', tmux: tmux('$7', '@61685', '%61685'), pid: 61685, cwd: '/workspace/project-alpha' }],
    sessions: [
      { id: 's1', pidChain: [3435648, 61685], cwd: '/workspace/project-alpha', process: processGeneration(3435648) },
      { id: 's1', pidChain: [3435700], cwd: null, process: processGeneration(3435700) },
    ],
  });
  assert.deepEqual(result, [{ id: 's1', tmuxName: 'pane-alpha', tmux: tmux('$7', '@61685', '%61685'), process: processGeneration(3435648), claim: 'lineage', kind: null }]);
});

test('computeLiveSessions returns empty when no tmux (graceful degradation)', () => {
  assert.deepEqual(
    computeLiveSessions({ tmuxPresent: false, panes: [], sessions: [{ id: 'a', pidChain: [1], cwd: '/x', process: processGeneration(1) }] }),
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

test('parseLastSessionPreferences returns the latest model and reasoning effort', () => {
  const tail = [
    '{"type":"session","model":"anthropic/claude-fable-5","thinkingLevel":"high"}',
    '{"type":"thinking_level_change","thinkingLevel":"medium"}',
    '{"type":"model_change","model":"openai-codex/gpt-5.6-sol"}',
    '{"type":"thinking_level_change","thinkingLevel":"xhigh"}',
  ].join('\n');
  assert.deepEqual(parseLastSessionPreferences(tail), {
    model: 'openai-codex/gpt-5.6-sol',
    effort: 'xhigh',
  });
});

test('parseLastSessionPreferences resolves inherited effort from the active model chain', () => {
  const tail = [
    '{"type":"thinking_level_change","thinkingLevel":"inherit"}',
    '{"type":"configured_model_chain","entries":["anthropic/claude-fable-5:high"]}',
    '{"type":"model_change","model":"anthropic/claude-fable-5"}',
  ].join('\n');
  assert.deepEqual(parseLastSessionPreferences(tail), {
    model: 'anthropic/claude-fable-5',
    effort: 'high',
  });
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
    panes: [{ name: 'pane-alpha', tmux: tmux('$10', '@100', '%100'), pid: 100, cmd: 'gjc' }],
    procs: [{ pid: 100, ppid: 1, args: '/usr/local/bin/gjc' }],
    excludedPaneIds: new Set(),
  });
  assert.deepEqual(result, [{ name: 'pane-alpha', tmux: tmux('$10', '@100', '%100'), agentPid: 100, kind: 'interactive' }]);
});

test('findIdleGjcTmuxSessions: gjc as a pane DESCENDANT (shell foreground) surfaces as batch', () => {
  const result = findIdleGjcTmuxSessions({
    panes: [{ name: 'pane-beta', tmux: tmux('$11', '@200', '%200'), pid: 200, cmd: 'zsh' }],
    procs: [
      { pid: 200, ppid: 1, args: '-zsh' },
      { pid: 201, ppid: 200, args: '/usr/local/bin/gjc' },
    ],
    excludedPaneIds: new Set(),
  });
  assert.deepEqual(result, [{ name: 'pane-beta', tmux: tmux('$11', '@200', '%200'), agentPid: 201, kind: 'batch' }]);
});

test('findIdleGjcTmuxSessions: a surfaced pane with no cmd falls back to kind=null', () => {
  const result = findIdleGjcTmuxSessions({
    panes: [{ name: 'pane-alpha', tmux: tmux('$10', '@100', '%100'), pid: 100 }],
    procs: [{ pid: 100, ppid: 1, args: '/usr/local/bin/gjc' }],
    excludedPaneIds: new Set(),
  });
  assert.deepEqual(result, [{ name: 'pane-alpha', tmux: tmux('$10', '@100', '%100'), agentPid: 100, kind: null }]);
});

test('findIdleGjcTmuxSessions: panes claimed by a LINEAGE row are excluded (one actionable row per pane)', () => {
  // Exclusion is lineage-only by exact pane identity: a cwd label must not hide a
  // subtree-proven idle pane.
  const result = findIdleGjcTmuxSessions({
    panes: [
      { name: 'claimed-pane', tmux: tmux('$12', '@300', '%300'), pid: 300, cmd: 'gjc' },
      { name: 'available-pane', tmux: tmux('$13', '@400', '%400'), pid: 400, cmd: 'gjc' },
    ],
    procs: [
      { pid: 300, ppid: 1, args: '/usr/local/bin/gjc' },
      { pid: 400, ppid: 1, args: '/usr/local/bin/gjc' },
    ],
    excludedPaneIds: new Set(['%300']),
  });
  assert.deepEqual(result, [{ name: 'available-pane', tmux: tmux('$13', '@400', '%400'), agentPid: 400, kind: 'interactive' }]);
});

test('findIdleGjcTmuxSessions: non-gjc panes (claude/codex/ssh) never surface here', () => {
  const result = findIdleGjcTmuxSessions({
    panes: [
      { name: 'pane-alpha', tmux: tmux('$14', '@500', '%500'), pid: 500, cmd: 'claude' },
      { name: 'pane-beta', tmux: tmux('$15', '@600', '%600'), pid: 600, cmd: 'node' },
    ],
    procs: [
      { pid: 500, ppid: 1, args: '/usr/local/bin/claude' },
      { pid: 600, ppid: 1, args: '/usr/bin/node /srv/devserver/index.js' },
      { pid: 601, ppid: 600, args: '/usr/local/bin/codex' },
    ],
    excludedPaneIds: new Set(),
  });
  assert.deepEqual(result, []);
});

test('findIdleGjcTmuxSessions treats names as labels and preserves exact pane ids', () => {
  const result = findIdleGjcTmuxSessions({
    panes: [
      { name: 'ok.name-1', tmux: tmux('$16', '@700', '%700'), pid: 700, cmd: 'gjc' },
      { name: 'label;$(not-a-shell)', tmux: tmux('$17', '@800', '%800'), pid: 800, cmd: 'gjc' },
      { name: '-leading-dash', tmux: tmux('$18', '@900', '%900'), pid: 900, cmd: 'gjc' },
    ],
    procs: [
      { pid: 700, ppid: 1, args: '/usr/local/bin/gjc' },
      { pid: 800, ppid: 1, args: '/usr/local/bin/gjc' },
      { pid: 900, ppid: 1, args: '/usr/local/bin/gjc' },
    ],
    excludedPaneIds: new Set(),
  });
  assert.equal(result.length, 3);
  assert.deepEqual(
    new Set(result.map(({ tmux: pane }) => pane.paneId)),
    new Set(['%700', '%800', '%900']),
  );
});

test('findIdleGjcTmuxSessions: sorted and preserves distinct panes in one session', () => {
  const result = findIdleGjcTmuxSessions({
    panes: [
      { name: 'zeta', tmux: tmux('$20', '@1000', '%1000'), pid: 1000, cmd: 'gjc' },
      { name: 'alpha', tmux: tmux('$21', '@1100', '%1100'), pid: 1100, cmd: 'gjc' },
      { name: 'zeta', tmux: tmux('$20', '@1200', '%1200'), pid: 1200, cmd: 'gjc' },
    ],
    procs: [
      { pid: 1000, ppid: 1, args: '/usr/local/bin/gjc' },
      { pid: 1100, ppid: 1, args: '/usr/local/bin/gjc' },
      { pid: 1200, ppid: 1, args: '/usr/local/bin/gjc' },
    ],
    excludedPaneIds: new Set(),
  });
  assert.deepEqual(result, [
    { name: 'alpha', tmux: tmux('$21', '@1100', '%1100'), agentPid: 1100, kind: 'interactive' },
    { name: 'zeta', tmux: tmux('$20', '@1000', '%1000'), agentPid: 1000, kind: 'interactive' },
    { name: 'zeta', tmux: tmux('$20', '@1200', '%1200'), agentPid: 1200, kind: 'interactive' },
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
    panes: [{ name: 'bun-pane', tmux: tmux('$30', '@2000', '%2000'), pid: 2000, cmd: 'bun' }],
    procs: [{ pid: 2000, ppid: 1, args: '/home/u/.bun/bin/bun /home/u/.bun/bin/gjc' }],
    excludedPaneIds: new Set(),
  });
  assert.deepEqual(result, [{ name: 'bun-pane', tmux: tmux('$30', '@2000', '%2000'), agentPid: 2000, kind: 'interactive' }]);
});

test('findIdleGjcTmuxSessions: a stray "gjc" token deeper in argv never qualifies (kill/relay discipline)', () => {
  // `man gjc` / an editor on a file named gjc must not surface an actionable
  // idle row — only argv[0], or argv[1] behind a bun/node interpreter, counts.
  const result = findIdleGjcTmuxSessions({
    panes: [
      { name: 'man-pane', tmux: tmux('$31', '@2100', '%2100'), pid: 2100, cmd: 'man' },
      { name: 'editor-pane', tmux: tmux('$32', '@2200', '%2200'), pid: 2200, cmd: 'vi' },
    ],
    procs: [
      { pid: 2100, ppid: 1, args: 'man gjc' },
      { pid: 2200, ppid: 1, args: 'vi /tmp/notes/gjc' },
    ],
    excludedPaneIds: new Set(),
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

test('dedupeLiveSessionsByLineage drops a cwd row shadowed by a lineage row for the same pane identity (patina 중복, cross-lane)', () => {
  const rows = [
    { id: 'a-cwd', tmuxName: 'patina', tmux: tmux('$95', '@95', '%950'), claim: 'cwd' as const, kind: null },
    { id: 'b-lineage', tmuxName: 'patina', tmux: tmux('$95', '@95', '%950'), claim: 'lineage' as const, kind: 'interactive' as const },
    { id: 'c-cwd-solo', tmuxName: 'solo', tmux: tmux('$7', '@7', '%70'), claim: 'cwd' as const, kind: null },
    { id: 'd-null', tmuxName: null, tmux: null, claim: null, kind: null },
  ];
  const result = dedupeLiveSessionsByLineage(rows).map((row) => row.id).sort();
  // a-cwd dropped (lineage covers the pane); c-cwd-solo and d-null remain.
  assert.deepEqual(result, ['b-lineage', 'c-cwd-solo', 'd-null']);
});

test('dedupeLiveSessionsByLineage keeps multiple lineage rows sharing one pane identity (main+worker)', () => {
  const rows = [
    { id: 'main', tmuxName: 'omg', tmux: tmux('$1', '@1', '%1'), claim: 'lineage' as const, kind: 'interactive' as const },
    { id: 'worker', tmuxName: 'omg', tmux: tmux('$1', '@1', '%1'), claim: 'lineage' as const, kind: 'batch' as const },
  ];
  assert.equal(dedupeLiveSessionsByLineage(rows).length, 2);
});
