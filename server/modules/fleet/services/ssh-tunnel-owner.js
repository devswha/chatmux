// @ts-check
import { spawn } from 'node:child_process';

// The IPC connection is a lifetime handle, not a command or credential channel.
// Own SSH from here so hub death also cleans launches not yet persisted by prepare().
const command = process.argv[2];
if (!process.connected || command === undefined) throw new TypeError('SSH owner requires its hub lifetime connection');

let stopping = false;
let finished = false;
/** @type {NodeJS.Timeout | undefined} */
let deadline;
/** @param {NodeJS.Signals} signal */
function stop(signal) {
  if (stopping || finished) return;
  stopping = true;
  if (process.platform === 'win32') child.kill(signal);
  else process.kill(-process.pid, signal);
  deadline = setTimeout(() => {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-process.pid, 'SIGKILL');
  }, 5_000);
}

for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGHUP'])) {
  process.on(signal, () => stop(signal));
}
process.on('disconnect', () => stop('SIGTERM'));
// No new process group: the hub owns this supervisor's group, including SSH.
const child = spawn(command, process.argv.slice(3), { stdio: 'ignore' });

/** @param {number | null} code @param {NodeJS.Signals | null} signal */
function finish(code, signal) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  if (process.connected) process.disconnect();
  if (signal !== null) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
}
child.once('error', () => finish(1, null));
child.once('exit', finish);
