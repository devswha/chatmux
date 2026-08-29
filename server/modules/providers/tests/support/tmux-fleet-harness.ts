import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  FleetCollisionFixture,
  TmuxFleetE2EHarness,
  TmuxFleetHarnessOptions,
  TmuxFleetNode,
} from './tmux-e2e-types.js';
import { createTmuxFleetNode, FLEET_TMUX_NODE_HOST_IDS } from './tmux-fleet-node.js';
import { assertTmuxAvailable, TmuxHarnessContractError } from './tmux-harness-utils.js';

export { FLEET_TMUX_NODE_HOST_IDS };
export const FLEET_TMUX_COLLISION = {
  providerSessionId: '019f0000-0000-7000-8000-000000000201', nativeSessionId: '019f0000-0000-7000-8000-000000000201',
  appSessionId: '019f0000-0000-7000-8000-000000000201', tmuxSessionName: 'fleet-collision',
  displayLabel: 'Fleet collision fixture', tmux: { sessionId: '$1', windowId: '@1', paneId: '%1' },
} as const satisfies Omit<FleetCollisionFixture, 'projectPath'>;

async function disposeNodes(nodes: readonly TmuxFleetNode[], root: string): Promise<void> {
  const settled = await Promise.allSettled(nodes.map((node) => node.dispose()));
  await rm(root, { recursive: true, force: true });
  const failures = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'Fleet node cleanup failed.');
}

export async function createTmuxFleetE2EHarness(
  options: TmuxFleetHarnessOptions = {},
): Promise<TmuxFleetE2EHarness> {
  await assertTmuxAvailable();
  const root = await mkdtemp(path.join(tmpdir(), 'chatmux-tmux-fleet-e2e-'));
  const workspace = path.join(root, 'project');
  const createNode = options.createNode ?? createTmuxFleetNode;
  const starts = [
    createNode({ fleetRoot: root, name: 'hub', port: options.hub ?? 0, workspace }),
    createNode({ fleetRoot: root, name: 'peer-a', port: options.peerA ?? 0, workspace }),
    createNode({ fleetRoot: root, name: 'peer-b', port: options.peerB ?? 0, workspace }),
  ] as const;
  const settled = await Promise.allSettled(starts);
  const nodes = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    try { await disposeNodes(nodes, root); } catch (cleanupError) {
      throw new AggregateError([failure.reason, cleanupError], 'Fleet startup and rollback failed.');
    }
    throw failure.reason;
  }
  const [hubResult, peerAResult, peerBResult] = settled;
  if (hubResult?.status !== 'fulfilled' || peerAResult?.status !== 'fulfilled' || peerBResult?.status !== 'fulfilled') {
    await disposeNodes(nodes, root);
    throw new TmuxHarnessContractError('Fleet fixture did not create all nodes.');
  }
  const hub = hubResult.value;
  const peerA = peerAResult.value;
  const peerB = peerBResult.value;
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await disposeNodes(nodes, root);
  };
  const collision: FleetCollisionFixture = { projectPath: workspace, ...FLEET_TMUX_COLLISION };
  return {
    root, workspace, hub, peers: { a: peerA, b: peerB }, collision, dispose,
    startCollisionPeers: async () => {
      const agents = await Promise.all([
        peerA.startFakeCodexWithTranscript(collision.tmuxSessionName, collision.providerSessionId),
        peerB.startFakeCodexWithTranscript(collision.tmuxSessionName, collision.providerSessionId),
      ]);
      await Promise.all(agents.map((agent) => agent.waitUntilReady()));
      await Promise.all([peerA.tmuxIdentity(collision.tmuxSessionName), peerB.tmuxIdentity(collision.tmuxSessionName)]);
      return agents;
    },
  };
}
