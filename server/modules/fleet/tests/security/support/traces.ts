import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SecurityTrace = Readonly<{
  readonly case: string;
  readonly surface: 'http' | 'websocket';
  readonly request: string;
  readonly outcome: string;
  readonly sideEffects: string;
}>;

// Mutable accumulator: the trace buffer is the documented purpose of this module.
const entries: SecurityTrace[] = [];
let armed = false;

export function recordTrace(entry: SecurityTrace): void {
  entries.push(entry);
}

export function recordedTraces(): readonly SecurityTrace[] {
  return entries;
}

export function armTraceFlush(label: string): void {
  if (armed) return;
  armed = true;
  process.on('exit', () => {
    const directory = process.env.FLEET_SECURITY_TRACE_DIR;
    if (directory === undefined || entries.length === 0) return;
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${label}.json`), `${JSON.stringify(entries, null, 2)}\n`);
  });
}
