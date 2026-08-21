#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const outputRoot = path.resolve(
  process.env.CUA_EVIDENCE_DIR
    ?? path.join(repositoryRoot, '.omo', 'cua', 'mcp'),
);

async function findDriver() {
  if (process.env.CUA_DRIVER_PATH) return path.resolve(process.env.CUA_DRIVER_PATH);
  const root = path.join(
    os.homedir(),
    '.codex',
    'plugins',
    'cache',
    'openai-bundled',
    'computer-use',
  );
  const versions = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const version of versions) {
    const candidate = path.join(root, version, 'bin', 'codex-computer-use-linux');
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next cached official bundle.
    }
  }
  throw new Error('No executable Linux Computer Use driver was found.');
}

function createClient(driverPath) {
  const child = spawn(driverPath, ['mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const diagnostics = [];
  let nextId = 1;

  child.stderr.on('data', (chunk) => diagnostics.push(chunk.toString()));
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      diagnostics.push(`non-JSON stdout: ${line}\n`);
      return;
    }
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(new Error(JSON.stringify(message.error)));
    } else {
      request.resolve(message.result);
    }
  });

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  const close = async () => {
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  };
  return { child, close, diagnostics, notify, request };
}

function compactTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function sanitizeEvidence(value, key = '') {
  if (value === null || value === undefined) return value;
  if (['command', 'token', 'password', 'secret'].some((needle) => key.toLowerCase().includes(needle))) {
    return '<redacted>';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeEvidence(entry));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeEvidence(childValue, childKey),
      ]),
    );
  }
  return value;
}

async function persistImages(toolName, result) {
  const paths = [];
  for (const [index, content] of (result?.content ?? []).entries()) {
    if (content?.type !== 'image' || typeof content.data !== 'string') continue;
    const extension = content.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const imagePath = path.join(outputRoot, `${toolName}-${index}.${extension}`);
    await writeFile(imagePath, Buffer.from(content.data, 'base64'));
    paths.push(imagePath);
    content.data = `<saved:${imagePath}>`;
  }
  return paths;
}

await mkdir(outputRoot, { recursive: true });
const driverPath = await findDriver();
const client = createClient(driverPath);

try {
  const initialized = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'chatmux-cua-evidence', version: '1.0.0' },
  });
  client.notify('notifications/initialized');
  const listed = await client.request('tools/list');
  const tools = listed.tools ?? [];
  const requestedNames = (process.env.CUA_TOOLS ?? 'doctor,list_apps')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const argumentsByTool = JSON.parse(process.env.CUA_TOOL_ARGUMENTS ?? '{}');
  const calls = [];
  for (const name of requestedNames) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      calls.push({ name, ok: false, error: 'tool_not_found' });
      continue;
    }
    try {
      const result = await client.request('tools/call', {
        name,
        arguments: argumentsByTool[name] ?? {},
      });
      const images = await persistImages(name, result);
      const compactResult = result?.structuredContent
        ? { isError: result.isError, structuredContent: result.structuredContent }
        : { isError: result?.isError, content: result?.content };
      calls.push({
        name,
        ok: !result?.isError,
        result: sanitizeEvidence(compactResult),
        images,
      });
    } catch (error) {
      calls.push({
        name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const evidence = {
    capturedAt: new Date().toISOString(),
    driverPath,
    initialize: initialized,
    tools: tools.map(compactTool),
    calls,
    diagnostics: client.diagnostics,
  };
  const outputPath = path.join(outputRoot, 'computer-use-mcp.json');
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    outputPath,
    serverInfo: initialized.serverInfo,
    toolCount: tools.length,
    calls: calls.map(({ name, ok, images }) => ({ name, ok, images })),
  }, null, 2)}\n`);
} finally {
  await client.close();
}
