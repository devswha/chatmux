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
