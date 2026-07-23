#!/usr/bin/env node

import fs from 'node:fs';

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

loadManagedEnvironment(process.env.CHATMUX_ENV_FILE);

if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '22') {
  console.error(
    `ChatMux server requires Linux x64 with Node.js 22; received ${process.platform} ${process.arch} Node.js ${process.versions.node}.`,
  );
  process.exit(1);
}

await import('../dist-server/server/cli.js');
