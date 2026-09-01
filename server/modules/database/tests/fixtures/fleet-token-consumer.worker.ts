import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';
import { tsImport } from 'tsx/esm/api';

const { FleetPairingTokensRepository } = await tsImport(
  '../../repositories/fleet-pairing-tokens.js',
  import.meta.url,
) as typeof import('../../repositories/fleet-pairing-tokens.js');

type ConsumerData = Readonly<{
  filename: string;
  token: readonly number[];
  now: number;
  gate: SharedArrayBuffer;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConsumerData(value: unknown): ConsumerData {
  if (!isRecord(value)
    || typeof value.filename !== 'string'
    || !Array.isArray(value.token)
    || !value.token.every((byte) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)
    || typeof value.now !== 'number'
    || !Number.isSafeInteger(value.now)
    || !(value.gate instanceof SharedArrayBuffer)) {
    throw new TypeError('invalid fleet token consumer worker data');
  }
  return { filename: value.filename, token: value.token, now: value.now, gate: value.gate };
}

const data = parseConsumerData(workerData);
if (parentPort === null) throw new TypeError('fleet token consumer requires a parent port');
const db = new Database(data.filename);
db.pragma('busy_timeout = 5000');
const repository = new FleetPairingTokensRepository(db);
parentPort.postMessage({ kind: 'ready' });
Atomics.wait(new Int32Array(data.gate), 0, 0);
const result = repository.consume(Uint8Array.from(data.token), data.now);
db.close();
parentPort.postMessage({ kind: 'result', outcome: result.kind });
