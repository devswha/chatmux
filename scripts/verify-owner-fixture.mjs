import { closeSync, openSync, rmSync, watch, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [root, id] = process.argv.slice(2);
if (root === undefined || id === undefined) throw new TypeError('fixture root and id are required');
const releaseName = `release-${id}`;
const released = new Promise((resolve, reject) => {
  const watcher = watch(root, (_event, filename) => {
    if (filename !== releaseName) return;
    clearTimeout(timeout); watcher.close(); resolve();
  });
  const timeout = setTimeout(() => { watcher.close(); reject(new TypeError(`fixture ${id} release timed out`)); }, 10_000);
  watcher.once('error', (error) => { clearTimeout(timeout); reject(error); });
});
const activePath = path.join(root, 'active');
let signaled = false;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.once(signal, () => {
    if (signaled) return;
    signaled = true;
    rmSync(activePath, { force: true });
    writeFileSync(path.join(root, `signaled-${id}`), signal);
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}
const descriptor = openSync(activePath, 'wx');
closeSync(descriptor);
await writeFile(path.join(root, `started-${id}`), id);
try { await released; } finally { await rm(activePath, { force: true }); }
await writeFile(path.join(root, `finished-${id}`), id);
