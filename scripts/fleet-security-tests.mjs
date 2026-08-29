import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectTests, runTests } from './run-tests.mjs';

// Existing fleet tests that pin one or more cells of the task-22 threat matrix.
const CONSOLIDATED_FLEET_TESTS = [
  'fleet-owner-authorization.service.test.ts',
  'fleet-pairing-limiter.service.test.ts',
  'fleet-pairing-store.integration.test.ts',
  'fleet-pairing.routes.test.ts',
  'fleet-pairing.service.test.ts',
  'fleet-hub-pairing.service.test.ts',
  'fleet-revocation.routes.test.ts',
  'fleet-revocation.service.test.ts',
  'fleet-role-exclusivity.service.test.ts',
  'fleet-role-http.test.ts',
  'fleet-role-runtime.test.ts',
  'fleet-protocol-auth.test.ts',
  'fleet-protocol-boundary.test.ts',
  'fleet-protocol-characterization.test.ts',
  'fleet-protocol-connection.test.ts',
  'fleet-protocol-live.test.ts',
  'fleet-protocol-state.test.ts',
  'fleet-protocol-timeout-live.test.ts',
  'task-7-peer-operation-boundary.test.ts',
  'task-8-hub-live-driver.test.ts',
  'task-11-mutation-ledger.test.ts',
  'task-11-persisted-authority.test.ts',
];

const CONSOLIDATED_DATABASE_TESTS = [
  'fleet-pairing-tokens.integration.test.ts',
  'fleet-role-exclusivity.integration.test.ts',
  'fleet-role-migration.integration.test.ts',
];

function traceDirArgument() {
  const index = process.argv.indexOf('--trace-dir');
  return index === -1 ? undefined : process.argv[index + 1];
}

async function suiteFiles() {
  const fleetTests = await collectTests('server/modules/fleet/tests');
  const consolidated = fleetTests.filter((file) =>
    file.includes('security/') || CONSOLIDATED_FLEET_TESTS.some((name) => file.endsWith(name)));
  const databaseTests = (await collectTests('server/modules/database/tests'))
    .filter((file) => CONSOLIDATED_DATABASE_TESTS.some((name) => file.endsWith(name)));
  const files = [...consolidated, ...databaseTests].sort();
  for (const required of CONSOLIDATED_FLEET_TESTS) {
    if (!files.some((file) => file.endsWith(required))) throw new Error(`[fleet-security] missing ${required}`);
  }
  if (!files.some((file) => file.includes('security'))) {
    throw new Error('[fleet-security] missing the task-22 security suite');
  }
  return files;
}

function mergeTraces(traceDir, fragmentsDir) {
  const fragments = readdirSync(fragmentsDir).filter((name) => name.endsWith('.json')).sort();
  const cases = fragments.flatMap((name) => {
    const parsed = JSON.parse(readFileSync(join(fragmentsDir, name), 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`[fleet-security] invalid trace fragment ${name}`);
    return parsed;
  });
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(
    join(traceDir, 'task-22-fleet-security.json'),
    `${JSON.stringify({ suite: 'task-22-fleet-security', files: fragments, cases }, null, 2)}\n`,
  );
  rmSync(fragmentsDir, { recursive: true, force: true });
}

const files = await suiteFiles();
const traceDir = traceDirArgument();
const fragmentsDir = traceDir === undefined ? undefined : join(traceDir, '.fragments');
if (traceDir !== undefined && fragmentsDir !== undefined) {
  if (!existsSync(traceDir)) mkdirSync(traceDir, { recursive: true });
  process.env.FLEET_SECURITY_TRACE_DIR = fragmentsDir;
}
runTests('fleet-security', files, { tsconfig: 'server/tsconfig.json' });
if (traceDir !== undefined && fragmentsDir !== undefined && existsSync(fragmentsDir)) {
  mergeTraces(traceDir, fragmentsDir);
  console.log(`[fleet-security] traces merged into ${join(traceDir, 'task-22-fleet-security.json')}`);
}
