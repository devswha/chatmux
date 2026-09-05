import assert from 'node:assert/strict';
import test from 'node:test';

import { listSshCandidates, parseSshCandidates } from '@/modules/fleet/services/ssh-candidates.service.js';

function status(backendState: string, peers: Record<string, unknown>): string {
  return JSON.stringify({ BackendState: backendState, Self: { HostName: 'hub', OS: 'linux', TailscaleIPs: ['100.64.0.1'] }, Peer: peers });
}

test('Given tailscale peers, when parsed, then supported online PCs come first and unusable entries are dropped', () => {
  const candidates = parseSshCandidates(status('Running', {
    a: { HostName: 'macbookpro', OS: 'macOS', TailscaleIPs: ['100.64.0.5', 'fd7a::5'], Online: true },
    b: { HostName: 'zeta-box', OS: 'linux', TailscaleIPs: ['100.64.0.9'], Online: true },
    c: { HostName: 'alpha-box', OS: 'linux', TailscaleIPs: ['100.64.0.7'], Online: false },
    d: { HostName: 'funnel-ingress-node', OS: '', TailscaleIPs: ['fd7a::1'], Online: true },
    e: { HostName: 'bad host;rm', OS: 'linux', TailscaleIPs: ['100.64.0.8'], Online: true },
    f: { HostName: 'phone', OS: 'iOS', TailscaleIPs: ['100.64.0.3'], Online: false },
  }));
  assert.deepEqual(candidates, [
    { hostName: 'zeta-box', address: '100.64.0.9', os: 'linux', online: true, supported: true },
    { hostName: 'alpha-box', address: '100.64.0.7', os: 'linux', online: false, supported: true },
    { hostName: 'macbookpro', address: '100.64.0.5', os: 'macOS', online: true, supported: false },
    { hostName: 'phone', address: '100.64.0.3', os: 'iOS', online: false, supported: false },
  ]);
});

test('Given tailscale is stopped or its output is not JSON, when parsed, then no candidates are offered', () => {
  assert.deepEqual(parseSshCandidates(status('Stopped', { a: { HostName: 'box', OS: 'linux', TailscaleIPs: ['100.64.0.9'], Online: true } })), []);
  assert.deepEqual(parseSshCandidates('not json'), []);
});

test('Given no tailscale CLI on the hub, when candidates are listed, then discovery degrades to unavailable with the local user', async () => {
  const payload = await listSshCandidates(async () => { throw new Error('spawn tailscale ENOENT'); }, () => 'alice');
  assert.deepEqual(payload, { available: false, defaultUser: 'alice', candidates: [] });
  const available = await listSshCandidates(async (args) => { assert.deepEqual(args, ['status', '--json']); return status('Running', { a: { HostName: 'box', OS: 'linux', TailscaleIPs: ['100.64.0.9'], Online: true } }); }, () => 'alice');
  assert.equal(available.available, true);
  assert.equal(available.candidates.length, 1);
});

test('candidate suggestions reject non-tailnet addresses, deduplicate and bound the result', () => {
  const peer = (address: string) => ({ HostName: 'box', OS: 'linux', TailscaleIPs: [address], Online: true });
  assert.deepEqual(parseSshCandidates(status('Running', Object.fromEntries(
    ['999.64.0.1', '127.0.0.1', '192.168.1.1', '100.064.0.1', '100.128.0.1'].map((ip) => [ip, peer(ip)]),
  ))), []);
  const peers = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [String(index), peer(`100.64.0.${index + 1}`)]));
  peers.duplicate = peer('100.64.0.1');
  const candidates = parseSshCandidates(status('Running', peers));
  assert.equal(candidates.length, 128);
  assert.equal(new Set(candidates.map(({ address }) => address)).size, 128);
});

test('unavailable status and unsafe suggested usernames fall back to manual entry', async () => {
  for (const raw of ['invalid', status('Stopped', {}), JSON.stringify({ BackendState: 'Running', Peer: [] })]) {
    assert.deepEqual(await listSshCandidates(async () => raw, () => 'alice;command'), {
      available: false, defaultUser: '', candidates: [],
    });
  }
});
