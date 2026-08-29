export type FleetHubRuntime = Readonly<{
  readonly start: () => void;
  readonly stop: () => void;
}>;

type FleetHubLifecycleOptions = Readonly<{
  readonly enabled: boolean;
  readonly createRuntime: () => Promise<FleetHubRuntime>;
}>;

export function createFleetHubLifecycle(options: FleetHubLifecycleOptions): Readonly<{
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}> {
  let runtime: FleetHubRuntime | undefined;
  let startPromise: Promise<void> | undefined;
  let stopping = false;

  const start = (): Promise<void> => {
    if (!options.enabled || startPromise !== undefined) return startPromise ?? Promise.resolve();
    startPromise = options.createRuntime().then((created) => {
      runtime = created;
      if (stopping) { created.stop(); return; }
      created.start();
    });
    return startPromise;
  };

  const stop = async (): Promise<void> => {
    if (!options.enabled || stopping) return;
    stopping = true;
    await startPromise?.then(() => undefined, () => undefined);
    runtime?.stop();
  };

  return { start, stop };
}
