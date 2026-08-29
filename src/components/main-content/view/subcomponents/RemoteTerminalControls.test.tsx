import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { ExternalTerminalTarget } from '../../../../types/app';
import type { RemoteTargetState } from '../../../../fleet/terminal/remoteTargetState';

import RemoteTerminalControls from './RemoteTerminalControls';

const target: ExternalTerminalTarget = {
  hostId: '22222222-2222-4222-8222-222222222222', hostLabel: 'Peer A',
  localId: 'collision-pane', lane: 'external', tmuxName: 'agent',
  tmux: { socketPath: '/tmp/peer.sock', sessionId: '$1', windowId: '@1', paneId: '%1' },
  process: { pid: 41, startedAtMs: 8_000 }, kind: 'Codex', cliKind: 'codex', project: null,
};
const ready: RemoteTargetState = {
  remote: true, ready: true, hostLabel: 'Peer A', state: 'online',
  canAttach: true, canInput: true, canRespond: true, canTerminate: true,
};

function render(state: RemoteTargetState): string {
  return renderToStaticMarkup(
    <RemoteTerminalControls target={target} state={state} onOutcomeUnknown={() => undefined} />,
  );
}

test('Given a ready remote pane, when controls render, then interrupt, escape, process, pane, and session semantics are separately labelled', () => {
  const html = render(ready);
  for (const label of [
    'Interrupt process on Peer A', 'Send Escape to Peer A', 'Stop agent process on Peer A',
    'Kill tmux pane on Peer A', 'Kill tmux session on Peer A',
  ]) assert.match(html, new RegExp(`aria-label="${label}"`));
});

test('Given a stale remote pane, when controls render, then every mutation is natively disabled', () => {
  const html = render({
    ...ready, ready: false, state: 'stale', canAttach: false, canInput: false, canRespond: false, canTerminate: false,
  });
  assert.equal((html.match(/disabled=""/g) ?? []).length, 5);
});
