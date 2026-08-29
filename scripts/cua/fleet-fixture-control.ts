import { createServer, type Server } from 'node:http';

import type { TmuxFleetNode } from '../../server/modules/providers/tests/support/tmux-e2e-harness.js';
import {
  startFleetServer,
  stopFleetProcesses,
  type FleetProcess,
} from './fleet-process-lifecycle.js';

type ControlledPeer = 'peer-a' | 'peer-b';
type FixtureControlOptions = Readonly<{
  repositoryRoot: string;
  peers: Readonly<Record<ControlledPeer, TmuxFleetNode>>;
  initial: Readonly<Record<ControlledPeer, FleetProcess>>;
  onProcessesChanged: (processes: Readonly<Record<ControlledPeer, FleetProcess | null>>) => void;
}>;

export type FleetFixtureControl = Readonly<{
  url: string;
  processes: () => Readonly<Record<ControlledPeer, FleetProcess | null>>;
  close: () => Promise<void>;
}>;

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function startFleetFixtureControl(options: FixtureControlOptions): Promise<FleetFixtureControl> {
  const current: Record<ControlledPeer, FleetProcess | null> = {
    'peer-a': options.initial['peer-a'],
    'peer-b': options.initial['peer-b'],
  };
  let action = Promise.resolve();
  const publish = () => options.onProcessesChanged({ ...current });
  const server = createServer((request, response) => {
    const match = /^\/(peer-a|peer-b)\/(stop|start)$/u.exec(request.url ?? '');
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'POST' || match?.[1] === undefined || match[2] === undefined) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const peer = match[1] as ControlledPeer;
    const command = match[2];
    action = action.then(async () => {
      if (command === 'stop') {
        const running = current[peer];
        if (running === null) throw new Error(`${peer} is already stopped.`);
        await stopFleetProcesses([running], null);
        current[peer] = null;
      } else {
        if (current[peer] !== null) throw new Error(`${peer} is already running.`);
        const node = { ...options.peers[peer], port: options.initial[peer].port };
        current[peer] = await startFleetServer(
          options.repositoryRoot,
          node,
          'peer',
          { CHATMUX_FLEET_TRANSPORT_MODE: 'ssh-loopback' },
        );
      }
      publish();
    });
    void action.then(
      () => response.end(JSON.stringify({ ok: true, peer, state: command === 'stop' ? 'stopped' : 'running' })),
      (error: unknown) => {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Fleet fixture control did not acquire a loopback port.');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    processes: () => ({ ...current }),
    close: () => closeServer(server),
  };
}
