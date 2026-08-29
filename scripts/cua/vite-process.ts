import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { FleetProcessError, waitForOutput } from './fleet-process-lifecycle.js';

export async function startVite(
  repositoryRoot: string,
  port: number,
  serverPort: number,
  logPath: string,
): Promise<ChildProcess> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a' });
  const viteCli = path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: repositoryRoot,
    detached: true,
    env: { ...process.env, HOST: '127.0.0.1', SERVER_PORT: String(serverPort), VITE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const pid = child.pid;
  if (pid === undefined) throw new FleetProcessError('Vite process has no PID', logPath);
  await waitForOutput(child, /Local:/, logPath);
  const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new FleetProcessError(`Vite returned ${response.status}`, logPath);
  return child;
}
