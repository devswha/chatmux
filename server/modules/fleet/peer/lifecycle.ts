import type { EventEmitter } from 'node:events';

import type { FleetCapability } from '../../../../shared/fleet.js';

export type FleetPeerRuntime = Readonly<{
  readonly capabilities: readonly FleetCapability[];
  readonly start: () => void;
  readonly stop: () => Promise<void>;
}>;

type FleetPeerLifecycleOptions = Readonly<{
  readonly enabled: boolean;
  readonly server: Pick<EventEmitter, 'listenerCount'>;
  readonly createRuntime?: () => Promise<FleetPeerRuntime>;
}>;

export class FleetPeerLifecycleError extends Error {
  readonly name = 'FleetPeerLifecycleError';
  constructor(message: string) { super(message); }
}

export function createFleetPeerLifecycle(options: FleetPeerLifecycleOptions): Readonly<{
  readonly capabilities: readonly FleetCapability[];
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}> {
  let runtime: FleetPeerRuntime | undefined;
  let startPromise: Promise<void> | undefined;
  let stopping = false;
  let started = false;
  const capabilities: FleetCapability[] = [];

  const start = (): Promise<void> => {
    if (!options.enabled || startPromise !== undefined) return startPromise ?? Promise.resolve();
    startPromise = (async () => {
      if (options.createRuntime === undefined) {
        throw new FleetPeerLifecycleError('enabled fleet lifecycle requires a runtime factory');
      }
      const created = await options.createRuntime();
      runtime = created;
      capabilities.splice(0, capabilities.length, ...created.capabilities);
      if (stopping) {
        await created.stop();
        return;
      }
      created.start();
      started = true;
    })();
    return startPromise;
  };

  const stop = async (): Promise<void> => {
    if (!options.enabled || stopping) return;
    stopping = true;
    await startPromise?.then(() => undefined, () => undefined);
    if (runtime !== undefined && started) await runtime.stop();
  };

  return { capabilities, start, stop };
}
