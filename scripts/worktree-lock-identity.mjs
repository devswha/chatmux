import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function errorCode(error) {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

async function platformStartTime(pid) {
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTime = fields[19];
    if (startTime === undefined) throw new TypeError(`Process ${pid} has no start identity.`);
    return startTime;
  }
  if (process.platform === 'win32') {
    const script = `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    return String(stdout).trim();
  }
  const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  return String(stdout).trim();
}

export async function readProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('Process identity PID is invalid.');
  try {
    const startTime = await platformStartTime(pid);
    return startTime.length === 0 ? null : { pid, startTime };
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ESRCH' || errorCode(error) === 1) return null;
    if (error instanceof Error && 'code' in error && error.code === 1) return null;
    throw error;
  }
}

export async function processIdentityAlive(identity) {
  const current = await readProcessIdentity(identity.pid);
  return current !== null && current.startTime === identity.startTime;
}

export function processGroupAlive(processGroupId) {
  if (processGroupId === null) return false;
  try {
    process.kill(process.platform === 'win32' ? processGroupId : -processGroupId, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === 'EPERM') return true;
    if (errorCode(error) === 'ESRCH' || errorCode(error) === 'EINVAL') return false;
    throw error;
  }
}
