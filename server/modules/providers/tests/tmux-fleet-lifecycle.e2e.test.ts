import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { startFleetServers, stopFleetProcesses, type FleetProcess } from '../../../../scripts/cua/fleet-process-lifecycle.js';

import { createTmuxFleetE2EHarness } from './support/tmux-fleet-harness.js';
import { createTmuxFleetNode } from './support/tmux-fleet-node.js';
import type { TmuxFleetNode } from './support/tmux-e2e-types.js';

const tmuxE2ESkip = process.platform === 'win32'
  ? 'Production tmux discovery is supported on Unix hosts.'
  : spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0
    && 'The real-tmux E2E harness requires tmux on PATH.';

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function waitForLine(child: ChildProcessWithoutNullStreams, marker: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const line = output.split('\n').find((value) => value.startsWith(marker));
      if (line === undefined) return;
      child.stdout.off('data', onData);
      resolve(line.slice(marker.length));
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`Fleet worker exited before ${marker}: ${code ?? signal}`)));
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Fleet worker failed: ${code ?? signal}`));
    });
    child.once('error', reject);
  });
}

function startFleetWorker(): ChildProcessWithoutNullStreams {
  const harnessUrl = pathToFileURL(path.resolve('server/modules/providers/tests/support/tmux-fleet-harness.ts')).href;
  const lifecycleUrl = pathToFileURL(path.resolve('scripts/cua/fleet-process-lifecycle.ts')).href;
  const source = `
    import { createTmuxFleetE2EHarness } from ${JSON.stringify(harnessUrl)};
    import { startFleetServers, stopFleetProcesses } from ${JSON.stringify(lifecycleUrl)};
    const harness = await createTmuxFleetE2EHarness();
    console.log('HARNESS=' + harness.root);
    await new Promise((resolve) => process.stdin.once('data', resolve));
    const servers = await startFleetServers(${JSON.stringify(path.resolve('.'))}, [harness.hub, harness.peers.a, harness.peers.b]);
    console.log('READY=' + JSON.stringify(servers.map(({ listenerPid, port }) => ({ listenerPid, port }))));
    await new Promise((resolve) => process.stdin.once('data', resolve));
    await stopFleetProcesses(servers, null);
    await harness.dispose();
    console.log('CLEAN');
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: path.resolve('.'), stdio: ['pipe', 'pipe', 'pipe'],
  });
}

test('fleet harness rolls back fulfilled siblings when one concurrent node start fails', {
  skip: tmuxE2ESkip, timeout: 30_000, concurrency: false,
}, async () => {
  // Given: peer B is held until both sibling tmux servers are live, then fails.
  const operatorBefore = spawnSync('tmux', ['list-sessions', '-F', '#{socket_path}\t#{pid}\t#{session_name}'], { encoding: 'utf8' }).stdout;
  const created: TmuxFleetNode[] = [];
  let releaseFailure: (() => void) | undefined;
  const siblingsReady = new Promise<void>((resolve) => { releaseFailure = resolve; });
  const createNode: typeof createTmuxFleetNode = async (options) => {
    if (options.name === 'peer-b') { await siblingsReady; throw new Error('injected peer-b startup failure'); }
    const node = await createTmuxFleetNode(options);
    created.push(node);
    if (created.length === 2) releaseFailure?.();
    return node;
  };
  // When: concurrent harness startup reaches the injected failure.
  await assert.rejects(createTmuxFleetE2EHarness({ createNode }), /injected peer-b startup failure/);
  // Then: the already-live sibling servers, sockets, and roots are gone.
  assert.equal(created.length, 2);
  for (const node of created) {
    assert.equal(processExists(node.tmuxServerPid), false);
    await assert.rejects(stat(node.root));
    await assert.rejects(stat(node.socketPath));
  }
  const operatorAfter = spawnSync('tmux', ['list-sessions', '-F', '#{socket_path}\t#{pid}\t#{session_name}'], { encoding: 'utf8' }).stdout;
  assert.equal(operatorAfter, operatorBefore);
});

test('two synchronized cross-process fleet runs receive exclusive dynamic listeners', {
  skip: tmuxE2ESkip, timeout: 120_000, concurrency: false,
}, async () => {
  // Given: two independent processes have created worktree-local fixture roots.
  const workers = [startFleetWorker(), startFleetWorker()];
  const roots = await Promise.all(workers.map((worker) => waitForLine(worker, 'HARNESS=')));
  assert.equal(new Set(roots).size, 2);
  // When: both processes begin all three server starts concurrently.
  const readiness = workers.map((worker) => waitForLine(worker, 'READY='));
  for (const worker of workers) worker.stdin.write('START\n');
  const manifests = (await Promise.all(readiness)).map((value) => JSON.parse(value) as readonly { listenerPid: number; port: number }[]);
  // Then: all six OS-assigned listeners are exclusive, before exact-event cleanup.
  assert.equal(new Set(manifests.flatMap((manifest) => manifest.map(({ port }) => port))).size, 6);
  assert.equal(manifests.flat().every(({ listenerPid }) => processExists(listenerPid)), true);
  const cleaned = workers.map((worker) => waitForLine(worker, 'CLEAN'));
  const exited = workers.map(waitForExit);
  for (const worker of workers) worker.stdin.end('STOP\n');
  await Promise.all([...cleaned, ...exited]);
  await Promise.all(roots.map((root) => assert.rejects(stat(root))));
});

test('partial concurrent server startup reaps started groups and consumes fixture roots', {
  skip: tmuxE2ESkip, timeout: 90_000, concurrency: false,
}, async () => {
  // Given: two real siblings report healthy before peer B fails.
  const harness = await createTmuxFleetE2EHarness();
  const started: FleetProcess[] = [];
  let releaseFailure: (() => void) | undefined;
  const siblingsReady = new Promise<void>((resolve) => { releaseFailure = resolve; });
  const startServer = async (...args: Parameters<typeof import('../../../../scripts/cua/fleet-process-lifecycle.js').startFleetServer>): Promise<FleetProcess> => {
    const node = args[1];
    if (node.name === 'peer-b') { await siblingsReady; throw new Error('injected server startup failure'); }
    const server = await import('../../../../scripts/cua/fleet-process-lifecycle.js').then(({ startFleetServer }) => startFleetServer(...args));
    started.push(server);
    if (started.length === 2) releaseFailure?.();
    return server;
  };
  // When: transactional fleet startup rejects after the sibling listeners exist.
  let unexpected: readonly FleetProcess[] = [];
  let startupFailure: unknown;
  try {
    unexpected = await startFleetServers(path.resolve('.'), [harness.hub, harness.peers.a, harness.peers.b], { startServer });
  } catch (error) {
    startupFailure = error;
  } finally {
    await stopFleetProcesses(unexpected, null);
  }
  assert.match(String(startupFailure), /injected server startup failure/);
  // Then: all tracked groups/listeners/tmux servers and the complete root are absent.
  for (const server of started) {
    assert.equal(processExists(server.listenerPid), false);
    assert.equal(processExists(server.processGroupPid), false);
  }
  for (const node of [harness.hub, harness.peers.a, harness.peers.b]) assert.equal(processExists(node.tmuxServerPid), false);
  await assert.rejects(stat(harness.root));
});
