type StoppableLifecycle = Readonly<{ readonly stop: () => Promise<void> }>;

type FleetRuntimeLifecycles = Readonly<{
  readonly hub: StoppableLifecycle;
  readonly peer: StoppableLifecycle;
}>;

export function fleetRuntimeEnabled(value: string | undefined): boolean {
  return value !== '0';
}

export async function stopFleetRuntimeServices(lifecycles: FleetRuntimeLifecycles): Promise<void> {
  await lifecycles.hub.stop();
  await lifecycles.peer.stop();
}
