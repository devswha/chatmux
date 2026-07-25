export type HostCommandCounters = Readonly<Record<string, number>>;

const counters = new Map<string, number>();

function keyFor(command: string, argv: readonly string[]): string {
  if (command === 'read') return `read ${argv[0] ?? 'unknown'}`;
  if (command === 'lsof') return 'lsof';
  const discriminator = argv.find((argument) => argument.length > 0);
  return discriminator ? `${command} ${discriminator}` : command;
}

/** Records host-process and host-file reads without retaining argument values. */
export function recordHostCommand(command: string, argv: readonly string[]): void {
  const key = keyFor(command, argv);
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function snapshotHostCommandCounters(): HostCommandCounters {
  return Object.freeze(Object.fromEntries(counters));
}

/** Test seam. Production code must not reset process-wide instrumentation. */
export function resetHostCommandCounters(): void {
  counters.clear();
}
