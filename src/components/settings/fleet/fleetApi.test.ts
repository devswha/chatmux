import assert from 'node:assert/strict';
import test from 'node:test';

import { fleetApi, FleetSettingsRequestError } from './fleetApi';

test('Given SSH enrollment input, when it is posted, then only the route contract fields are sent and the result is parsed', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ peerId: 'peer-a', port: 8022 }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await fleetApi.sshEnroll({ sshTarget: 'devswha@192.168.1.50', password: 'secret', label: 'Studio' });

    assert.equal(requestUrl, '/api/fleet/ssh-enroll');
    assert.equal(requestInit?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requestInit?.body)), {
      sshTarget: 'devswha@192.168.1.50', password: 'secret', label: 'Studio',
    });
    assert.deepEqual(result, { peerId: 'peer-a', port: 8022 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Given a closed SSH error response, when enrollment fails, then the machine code is surfaced without sensitive message text', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 'SSH_AUTH_FAILED', message: 'Authentication failed' },
  }), { status: 401, headers: { 'content-type': 'application/json' } });

  try {
    await assert.rejects(
      fleetApi.sshEnroll({ sshTarget: 'devswha@192.168.1.50', password: 'secret' }),
      (error: unknown) => error instanceof FleetSettingsRequestError
        && error.code === 'SSH_AUTH_FAILED'
        && error.message === 'SSH_AUTH_FAILED',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SSH candidate responses are bounded, validated, stripped of extra fields, and preserve cancellation', async () => {
  const originalFetch = globalThis.fetch;
  const candidate = { hostName: 'lab', address: '100.64.0.2', os: 'linux', online: true, supported: true };
  let payload: unknown = { available: true, defaultUser: 'alice', candidates: [{ ...candidate, privateKey: 'secret' }] };
  const controller = new AbortController();
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.signal, controller.signal);
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.deepEqual(await fleetApi.sshCandidates(controller.signal), { available: true, defaultUser: 'alice', candidates: [candidate] });
    for (const bad of [
      { ...candidate, address: '127.0.0.1' }, { ...candidate, address: '100.64.0.2\n' },
      { ...candidate, os: 'secret private diagnostic' }, { ...candidate, supported: false },
      { ...candidate, hostName: 'lab\n' },
    ]) {
      payload = { available: true, defaultUser: 'alice', candidates: [bad] };
      await assert.rejects(fleetApi.sshCandidates(controller.signal), (error) => error instanceof FleetSettingsRequestError && error.code === 'MALFORMED_RESPONSE');
    }
    for (const value of [
      { available: true, defaultUser: 'alice', candidates: Array(129).fill(candidate) },
      { available: true, defaultUser: 'alice', candidates: [candidate, candidate] },
      { available: false, defaultUser: 'alice', candidates: [candidate] },
      { available: true, defaultUser: 'alice\n', candidates: [] },
    ]) {
      payload = value;
      await assert.rejects(fleetApi.sshCandidates(controller.signal), FleetSettingsRequestError);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('remote diagnostics cannot leak through structured platform error details', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: {
    code: 'REMOTE_PLATFORM_UNSUPPORTED', message: 'private message',
    details: { os: 'private-host', arch: 'private-path', password: 'secret' },
  } }), { status: 409 });
  try {
    await assert.rejects(fleetApi.sshEnroll({ sshTarget: 'alice@host', installCli: true }), (error) => {
      assert.ok(error instanceof FleetSettingsRequestError);
      assert.deepEqual(error.details, { os: 'unknown', arch: 'unknown' });
      assert.equal(error.message, 'REMOTE_PLATFORM_UNSUPPORTED');
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});
