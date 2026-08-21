#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const outputRoot = path.resolve(
  process.env.CUA_EVIDENCE_DIR
    ?? path.join(repositoryRoot, '.omo', 'cua', 'tailscale'),
);

async function tailscaleJson(args) {
  const result = await execFileAsync('tailscale', [...args, '--json'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return JSON.parse(result.stdout);
}

async function endpointSummary(baseUrl, endpoint) {
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // The status and content type still provide useful evidence.
    }
    return {
      endpoint,
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type'),
      summary: body ? {
        success: body.success,
        authenticated: body.authenticated,
        authMode: body.authMode,
        hasData: body.data !== undefined,
        errorCode: body.error?.code,
      } : null,
    };
  } catch (error) {
    return {
      endpoint,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

await mkdir(outputRoot, { recursive: true });
const [status, serve] = await Promise.all([
  tailscaleJson(['status']),
  tailscaleJson(['serve', 'status']),
]);
const dnsName = status.Self?.DNSName?.replace(/\.$/, '') ?? null;
const chatmuxEntry = Object.entries(serve.Web ?? {}).find(([host, value]) => (
  host.endsWith(':3001')
  && value?.Handlers?.['/']?.Proxy === 'http://localhost:3001'
));
const baseUrl = dnsName && chatmuxEntry ? `https://${chatmuxEntry[0]}` : null;
const endpoints = baseUrl
  ? await Promise.all([
    endpointSummary(baseUrl, '/health'),
    endpointSummary(baseUrl, '/api/auth/status'),
    endpointSummary(baseUrl, '/api/providers/sessions/live'),
  ])
  : [];
const authStatus = endpoints.find(({ endpoint }) => endpoint === '/api/auth/status');
const evidence = {
  capturedAt: new Date().toISOString(),
  backendState: status.BackendState,
  online: status.Self?.Online === true,
  dnsName,
  serve: chatmuxEntry ? {
    host: chatmuxEntry[0],
    proxy: chatmuxEntry[1].Handlers['/'].Proxy,
  } : null,
  baseUrl,
  endpoints,
  ok: (
    status.BackendState === 'Running'
    && status.Self?.Online === true
    && Boolean(chatmuxEntry)
    && endpoints.length === 3
    && endpoints.every(({ ok }) => ok)
    && authStatus?.summary?.authMode === 'tailscale'
  ),
};
const outputPath = path.join(outputRoot, 'tailscale-https.json');
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ outputPath, ok: evidence.ok, endpoints }, null, 2)}\n`);
if (!evidence.ok) process.exitCode = 1;
