import assert from 'node:assert/strict';
import test from 'node:test';

import i18next, { type i18n as I18n } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { FleetPeerState } from '../../../../../shared/fleet';
import enChat from '../../../../i18n/locales/en/chat.json';
import { FleetHostCatalogContext } from '../../../../fleet/discovery/FleetHostCatalogContext';
import type { FleetHostCatalog, FleetHostEntry } from '../../../../fleet/discovery/hostCatalog';
import type { ExternalTerminalTarget } from '../../../../types/app';
import { buildTranscriptCliAttachTarget } from '../externalAttachTargets';

import PendingRelayView from './PendingRelayView';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER_A = '22222222-2222-4222-8222-222222222222';
const PEER_B = '33333333-3333-4333-8333-333333333333';
const tmux = { socketPath: '/tmp/collision.sock', sessionId: '$1', windowId: '@1', paneId: '%1' };
const process = { pid: 41, startedAtMs: 8_000 };
const target: ExternalTerminalTarget = {
  hostId: PEER_A, hostLabel: 'Peer A', localId: 'collision-pane', lane: 'external',
  tmuxName: 'collision', tmux, process, kind: 'Codex', cliKind: 'codex', project: null,
};

function entry(hostId: string, label: string, state: FleetPeerState): FleetHostEntry {
  return {
    descriptor: {
      hostId, displayLabel: label, state, protocolVersion: 'fleet/1',
      capabilities: ['terminal.attach', 'terminal.input', 'prompt.respond'],
    },
    sync: state === 'syncing' ? 'syncing' : 'synced', epoch: `epoch-${hostId}`, revision: 4,
    rows: {
      projects: [], sessions: [], panes: [{
        localId: 'collision-pane', lane: 'external', tmuxName: 'collision', tmux, process,
        kind: 'codex', providerSessionId: null, activity: 'idle', presence: 'present',
      }],
    },
    truncated: false,
  };
}
function catalog(state: FleetPeerState): FleetHostCatalog {
  return {
    localHostId: LOCAL,
    hosts: new Map([
      [PEER_A, entry(PEER_A, 'Peer A', state)],
      [PEER_B, entry(PEER_B, 'Peer B', 'online')],
    ]),
  };
}
async function translations(): Promise<I18n> {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en', fallbackLng: false, resources: { en: { chat: enChat } },
    ns: ['chat'], defaultNS: 'chat', interpolation: { escapeValue: false },
  });
  return instance;
}
function surface(i18n: I18n, hosts: FleetHostCatalog) {
  return (
    <I18nextProvider i18n={i18n}>
      <FleetHostCatalogContext.Provider value={{ catalog: hosts, hasRemoteHosts: true, refresh: () => undefined }}>
        <PendingRelayView
          externalTerminal={target}
          externalTranscriptView="conversation"
          setExternalTranscriptView={() => undefined}
          externalPaneOutput=""
          isMobile={false}
          onMenuClick={() => undefined}
          onExternalTerminalClose={() => undefined}
        />
      </FleetHostCatalogContext.Provider>
    </I18nextProvider>
  );
}
async function mount(hosts: FleetHostCatalog): Promise<Readonly<{ readonly renderer: ReactTestRenderer; readonly i18n: I18n }>> {
  const i18n = await translations();
  let renderer: ReactTestRenderer | null = null;
  await act(async () => { renderer = TestRenderer.create(surface(i18n, hosts)); });
  if (renderer === null) throw new TypeError('pending relay did not mount');
  return { renderer, i18n };
}

test('Given colliding controller and peer panes, when pending peer A opens CLI, then every attach remains exactly peer A', async (t) => {
  const harness = await mount(catalog('online'));
  t.after(() => harness.renderer.unmount());

  const attachTarget = buildTranscriptCliAttachTarget(target);

  assert.deepEqual(attachTarget, {
    targetClass: 'remote-agent',
    target: { kind: 'pane', hostId: PEER_A, localId: 'collision-pane', lane: 'external', tmux, process },
  });
  assert.equal(JSON.stringify(attachTarget).includes(LOCAL), false);
  assert.equal(JSON.stringify(attachTarget).includes(PEER_B), false);
  assert.equal(harness.renderer.root.findByType('fieldset').props.disabled, false);
});

test('Given an attached pending peer, when its host goes offline, then native disablement lands before another attach can render', async (t) => {
  const harness = await mount(catalog('online'));
  t.after(() => harness.renderer.unmount());

  await act(async () => { harness.renderer.update(surface(harness.i18n, catalog('offline'))); });

  const fieldset = harness.renderer.root.findByType('fieldset');
  assert.equal(fieldset.props.disabled, true);
  const statusText = harness.renderer.root.findByProps({ role: 'alert' })
    .findAllByType('span')
    .flatMap((node) => node.children)
    .join(' ');
  assert.match(statusText, /Peer A.*offline/i);
});
