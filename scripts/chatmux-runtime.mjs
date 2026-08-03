#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadManagedEnvironment(configPath) {
  if (!configPath) return;
  let content;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(separator + 1);
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
    }
    process.env[key] = value;
  }
}

export async function runChatmuxRuntime({
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  cliArgs = process.argv.slice(2),
  configPath = process.env.CHATMUX_ENV_FILE,
  importCli = () => import('../dist-server/server/cli.js'),
} = {}) {
  loadManagedEnvironment(configPath);

  if (platform !== 'linux' || arch !== 'x64' || nodeVersion.split('.')[0] !== '22') {
    throw new Error(
      `ChatMux server requires Linux x64 with Node.js 22; received ${platform} ${arch} Node.js ${nodeVersion}.`,
    );
  }

  const cli = await importCli();
  if (typeof cli.runChatmuxCli !== 'function') {
    throw new Error('ChatMux CLI entrypoint is unavailable.');
  }
  await cli.runChatmuxCli(cliArgs);
}

function isMainEntry(argvPath) {
  if (!argvPath) return false;
  const resolvedArgv = path.resolve(argvPath);
  const modulePath = fileURLToPath(import.meta.url);
  if (resolvedArgv === modulePath) return true;
  try {
    return fs.realpathSync(resolvedArgv) === fs.realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isMainEntry(process.argv[1])) {
  runChatmuxRuntime().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
