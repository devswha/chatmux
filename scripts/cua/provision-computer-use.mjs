#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const version = 'v0.4.9';
const asset = 'computer-use-linux-x86_64-unknown-linux-gnu';
const expectedSha256 = '6432e86ee6480f31f508f22dbe860d6987859997ee476ca36324a38e2eb4df48';
const source = `https://github.com/agent-sh/computer-use-linux/releases/download/${version}/${asset}`;
const outputDirectory = path.resolve(process.env.CUA_TOOL_DIR ?? path.join(os.tmpdir(), 'chatmux-computer-use'));
const outputPath = path.join(outputDirectory, 'computer-use-linux');
const evidenceDirectory = path.resolve(process.env.CUA_EVIDENCE_DIR ?? outputDirectory);

await Promise.all([mkdir(outputDirectory, { recursive: true }), mkdir(evidenceDirectory, { recursive: true })]);
const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
if (!response.ok) throw new Error(`Computer Use download failed with HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const actualSha256 = createHash('sha256').update(bytes).digest('hex');
if (actualSha256 !== expectedSha256) {
  throw new Error(`Computer Use checksum mismatch: ${actualSha256}`);
}
await writeFile(outputPath, bytes, { mode: 0o755 });
await chmod(outputPath, 0o755);
const receipt = {
  source,
  upstream: 'https://github.com/agent-sh/computer-use-linux',
  version,
  asset,
  expectedSha256,
  actualSha256,
  bytes: (await readFile(outputPath)).length,
  executable: outputPath,
};
await writeFile(
  path.join(evidenceDirectory, 'computer-use-provision.json'),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
process.stdout.write(`${outputPath}\n`);
