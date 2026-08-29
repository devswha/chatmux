import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

import { recordHostCommand } from '@/modules/providers/services/host-command-metrics.service.js';

function runCommand(command: string, cmdArgs: readonly string[], timeoutMs = 4_000): Promise<string> {
  recordHostCommand(command, cmdArgs);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...cmdArgs], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`${command} timed out`));
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', (error) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}

/** Parses the portable `ps -o lstart=` fallback format. */
export function parseProcessStartTime(output: string): number | null {
  const parsed = Date.parse(output.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Process start time used as a tmux pane/agent generation identity. The
 * identity crosses the fleet catalog wire, whose schema requires safe
 * integers, so the fractional `/proc` mtime precision is truncated once here
 * instead of at every producer, matcher, and verifier downstream.
 */
export async function processStartMs(pid: number): Promise<number | null> {
  try {
    return Math.trunc((await stat(`/proc/${pid}`)).mtimeMs);
  } catch {
    try {
      return parseProcessStartTime(await runCommand('ps', ['-p', String(pid), '-o', 'lstart=']));
    } catch {
      return null;
    }
  }
}
