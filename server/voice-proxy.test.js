import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

let moduleInstance = 0;

async function startServer(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function startVoiceProxy(baseUrl, { timeoutMs = 75 } = {}) {
  const previousBaseUrl = process.env.VOICE_API_BASE_URL;
  const previousTimeout = process.env.VOICE_TIMEOUT_MS;
  process.env.VOICE_API_BASE_URL = baseUrl;
  process.env.VOICE_TIMEOUT_MS = String(timeoutMs);
  let router;
  try {
    ({ default: router } = await import(`./voice-proxy.js?smoke-test=${moduleInstance++}`));
  } finally {
    if (previousBaseUrl === undefined) delete process.env.VOICE_API_BASE_URL;
    else process.env.VOICE_API_BASE_URL = previousBaseUrl;
    if (previousTimeout === undefined) delete process.env.VOICE_TIMEOUT_MS;
    else process.env.VOICE_TIMEOUT_MS = previousTimeout;
  }

  const app = express();
  app.use(express.json());
  app.use('/api/voice', router);
  return startServer(app);
}

async function postTts(proxy, headers = {}) {
  return fetch(`${proxy.url}/api/voice/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ text: 'smoke test' }),
    redirect: 'manual',
  });
}
async function postTranscribe(proxy, headers = {}) {
  const form = new FormData();
  form.append('audio', new Blob(['audio-body-must-not-leak'], { type: 'audio/webm' }), 'recording.webm');
  return fetch(`${proxy.url}/api/voice/transcribe`, {
    method: 'POST',
    headers,
    body: form,
    redirect: 'manual',
  });
}

test('voice proxy rejects audio uploads above the 25 MB memory limit', async () => {
  let backendRequests = 0;
  const backend = await startServer((_req, res) => {
    backendRequests += 1;
    res.end(JSON.stringify({ text: 'unexpected' }));
  });
  const proxy = await startVoiceProxy(backend.url);

  try {
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array((25 * 1024 * 1024) + 1)]), 'oversize.webm');
    const response = await fetch(`${proxy.url}/api/voice/transcribe`, { method: 'POST', body: form });

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /File too large/);
    assert.equal(backendRequests, 0);
  } finally {
    await proxy.close();
    await backend.close();
  }
});

test('voice proxy times out a stalled backend request', async () => {
  const backend = await startServer(() => {});
  const proxy = await startVoiceProxy(backend.url, { timeoutMs: 50 });

  try {
    const startedAt = Date.now();
    const response = await postTts(proxy);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(response.status, 504);
    assert.match((await response.json()).error, /timed out/);
    assert.ok(elapsedMs < 1500, `timeout took ${elapsedMs}ms`);
  } finally {
    await proxy.close();
    await backend.close();
  }
});

test('voice proxy safely propagates upstream 5xx and connection failures', async () => {
  const backend = await startServer((_req, res) => {
    res.statusCode = 503;
    res.end('backend diagnostic');
  });
  const proxy = await startVoiceProxy(backend.url);
  const unavailable = await startServer((_req, res) => res.end());
  await unavailable.close();
  const unreachableProxy = await startVoiceProxy(unavailable.url);

  try {
    const upstreamResponse = await postTts(proxy);
    assert.equal(upstreamResponse.status, 503);
    assert.deepEqual(await upstreamResponse.json(), { error: 'Voice backend returned status 503.' });

    const connectionResponse = await postTts(unreachableProxy);
    assert.equal(connectionResponse.status, 502);
    assert.deepEqual(await connectionResponse.json(), { error: 'Voice backend unreachable. Check your voice backend.' });
  } finally {
    await proxy.close();
    await unreachableProxy.close();
    await backend.close();
  }
});
test('voice proxy remaps upstream authentication failures without changing other upstream statuses', async () => {
  let status = 401;
  const backend = await startServer((_req, res) => {
    res.statusCode = status;
    res.end('backend diagnostic');
  });
  const proxy = await startVoiceProxy(backend.url);

  try {
    for (const [upstreamStatus, expectedStatus] of [[401, 502], [403, 502], [503, 503]]) {
      status = upstreamStatus;
      const response = await postTts(proxy);
      assert.equal(response.status, expectedStatus);
    }
  } finally {
    await proxy.close();
    await backend.close();
  }
});

test('voice proxy refuses upstream redirects instead of following them', async () => {
  let redirectedTargetRequests = 0;
  const target = await startServer((_req, res) => {
    redirectedTargetRequests += 1;
    res.end('redirect target');
  });
  const backend = await startServer((_req, res) => {
    res.writeHead(302, { Location: target.url });
    res.end();
  });
  const proxy = await startVoiceProxy(backend.url);

  try {
    const response = await postTts(proxy);

    assert.equal(response.status, 302);
    assert.deepEqual(await response.json(), { error: 'Voice backend returned status 302.' });
    assert.equal(redirectedTargetRequests, 0);
  } finally {
    await proxy.close();
    await backend.close();
    await target.close();
  }
});

test('voice proxy rejects link-local and non-HTTP backend URLs', async () => {
  const linkLocalProxy = await startVoiceProxy('http://169.254.169.254');
  const fileProxy = await startVoiceProxy('file:///etc/passwd');

  try {
    for (const proxy of [linkLocalProxy, fileProxy]) {
      const response = await postTts(proxy);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'Invalid voice backend URL.' });
    }
  } finally {
    await linkLocalProxy.close();
    await fileProxy.close();
  }
});

test('voice proxy logs only safe structured upstream failure evidence', async () => {
  const apiKey = 'voice-api-key-must-not-leak';
  const backend = await startServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
    res.statusCode = 500;
    res.end(`backend received ${req.headers.authorization}`);
  });
  const proxy = await startVoiceProxy(backend.url);
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);

  try {
    const ttsResponse = await postTts(proxy, { 'x-voice-api-key': apiKey });
    const transcribeResponse = await postTranscribe(proxy, { 'x-voice-api-key': apiKey });

    assert.equal(ttsResponse.status, 500);
    assert.equal(transcribeResponse.status, 500);
    assert.deepEqual(logs, [
      [{ operation: 'tts', upstreamStatus: 500 }],
      [{ operation: 'transcribe', upstreamStatus: 500 }],
    ]);
    const loggedText = JSON.stringify(logs);
    assert.doesNotMatch(loggedText, new RegExp(apiKey));
    assert.doesNotMatch(loggedText, /audio-body-must-not-leak|authorization|backend received/i);
  } finally {
    console.error = originalConsoleError;
    await proxy.close();
    await backend.close();
  }
});
