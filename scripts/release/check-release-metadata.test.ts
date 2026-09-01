import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkReleaseMetadata,
  deriveSchemaGeneration,
  findPreviousRelease,
  parseStableVersion,
} from './check-release-metadata.mjs';

const TARGET = '1.8.15';
const CODE_GENERATION = 19;

function declarationWith(
  rollbackCompatibleFrom: string[],
  targetGeneration: number | undefined = CODE_GENERATION,
  targetVersion: string = TARGET,
) {
  const targetDatabase: { rollbackCompatibleFrom: string[]; schemaGeneration?: number } = {
    rollbackCompatibleFrom,
  };
  if (targetGeneration !== undefined) targetDatabase.schemaGeneration = targetGeneration;
  return {
    schema: 1,
    releases: {
      '1.8.12': { database: { rollbackCompatibleFrom: ['1.8.11'], schemaGeneration: 18 } },
      '1.8.13': { database: { rollbackCompatibleFrom: ['1.8.12'], schemaGeneration: 18 } },
      '1.8.14': { database: { rollbackCompatibleFrom: ['1.8.12', '1.8.13'], schemaGeneration: 19 } },
      [targetVersion]: { database: targetDatabase },
    },
  };
}

function check(
  declaration: unknown,
  version: string = TARGET,
  lockVersion: string = version,
  canonicalDeclaration?: unknown,
  codeSchemaGeneration: number = CODE_GENERATION,
  canonicalSchemaGeneration: number | null = null,
) {
  return checkReleaseMetadata({
    canonicalDeclaration,
    canonicalSchemaGeneration,
    codeSchemaGeneration,
    declaration,
    packageJson: { version },
    packageLock: { version: lockVersion, packages: { '': { version: lockVersion } } },
  });
}

test('derives the schema generation from the ordered migration registry', () => {
  const source = `export const MIGRATIONS: Migration[] = [
    { version: 1, migrate: first },
    { version: 2, migrate: second },
    { version: 3, migrate: third },
  ];`;
  assert.equal(deriveSchemaGeneration(source), 3);
  assert.throws(
    () => deriveSchemaGeneration(source.replace('version: 2', 'version: 4')),
    /contiguous safe integers/u,
  );
});

test('accepts an unchanged-schema release that carries the previous window forward', () => {
  const declaration = declarationWith(['1.8.12', '1.8.13', '1.8.14']);
  const result = check(declaration);

  assert.equal(findPreviousRelease(declaration, TARGET), '1.8.14');
  assert.deepEqual(result.violations, []);
});

test('accepts a singleton predecessor only when the schema generation increases', () => {
  assert.deepEqual(check(declarationWith(['1.8.14'], 20), TARGET, TARGET, undefined, 20).violations, []);
});

test('rejects a singleton predecessor when the schema generation is unchanged', () => {
  const { violations } = check(declarationWith(['1.8.14']));
  assert.ok(violations.some((violation) => /missing 1\.8\.12, 1\.8\.13/u.test(violation)));
});

test('rejects a singleton predecessor when its schema generation is missing', () => {
  const declaration = declarationWith(['1.8.14'], 20);
  delete declaration.releases['1.8.14'].database.schemaGeneration;

  const { violations } = check(declaration, TARGET, TARGET, undefined, 20);
  assert.ok(violations.some((violation) => /singleton predecessor is allowed only/u.test(violation)));
});

test('bootstraps a pre-governance predecessor from the tag-derived schema generation', () => {
  const declaration = declarationWith(['1.8.14'], 20);
  delete declaration.releases['1.8.14'].database.schemaGeneration;

  const bootstrapped = check(declaration, TARGET, TARGET, undefined, 20, 16);
  assert.deepEqual(bootstrapped.violations, []);

  const unchanged = check(declaration, TARGET, TARGET, undefined, 20, 20);
  assert.ok(unchanged.violations.some((violation) => /singleton predecessor is allowed only/u.test(violation)));
});

test('rejects recorded predecessor metadata that disagrees with the tag-derived generation', () => {
  const { violations } = check(
    declarationWith(['1.8.12', '1.8.13', '1.8.14']),
    TARGET,
    TARGET,
    undefined,
    CODE_GENERATION,
    16,
  );
  assert.ok(violations.some((violation) =>
    /recorded 19 disagrees with generation 16 derived from the migration registry at the predecessor tag/u.test(violation)));
});

test('rejects a target declaration with a missing or mismatched schema generation', () => {
  const missingDeclaration = declarationWith(['1.8.12', '1.8.13', '1.8.14']);
  delete missingDeclaration.releases[TARGET].database.schemaGeneration;
  const missing = check(missingDeclaration);
  assert.ok(missing.violations.some((violation) => /schemaGeneration: must be a non-negative safe integer/u.test(violation)));

  const mismatched = check(declarationWith(['1.8.12', '1.8.13', '1.8.14'], 18));
  assert.ok(mismatched.violations.some((violation) => /expected code-derived generation 19, found 18/u.test(violation)));
});

test('rejects a partial carry-forward that strands older installs (#49)', () => {
  const { violations } = check(declarationWith(['1.8.13', '1.8.14']));
  assert.ok(violations.some((violation) => /missing 1\.8\.12/u.test(violation)));
});

test('uses canonical predecessor metadata and rejects changed historical metadata', () => {
  const canonical = declarationWith(['1.8.12', '1.8.13', '1.8.14']);
  const current = structuredClone(canonical);
  current.releases['1.8.14'].database.rollbackCompatibleFrom = ['1.8.13'];

  const { violations } = check(current, TARGET, TARGET, canonical);
  assert.ok(violations.some((violation) => /differs from canonical metadata published at the predecessor tag/u.test(violation)));
});

test('rejects non-stable and duplicate declared versions', () => {
  const prerelease = check(declarationWith(['1.8.12', '1.8.13', '1.8.14-rc.1', '1.8.14']));
  assert.ok(prerelease.violations.some((violation) => /"1\.8\.14-rc\.1" is not an exact stable SemVer/u.test(violation)));

  const duplicated = check(declarationWith(['1.8.12', '1.8.13', '1.8.13', '1.8.14']));
  assert.ok(duplicated.violations.some((violation) => /1\.8\.13 is declared more than once/u.test(violation)));
});

test('rejects a declared version that is not lower than the target', () => {
  const { violations } = check(declarationWith(['1.8.12', '1.8.13', '1.8.14', '1.9.0']));
  assert.ok(violations.some((violation) => /1\.9\.0 is not lower than the target version 1\.8\.15/u.test(violation)));
});

test('rejects a target version without its own declaration entry', () => {
  const { violations } = check(declarationWith(['1.8.12', '1.8.13', '1.8.14'], CODE_GENERATION, '1.8.16'));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /no exact compatibility declaration exists for 1\.8\.15/u);
});

test('rejects a package and lockfile version mismatch', () => {
  const { violations } = check(declarationWith(['1.8.12', '1.8.13', '1.8.14']), TARGET, '1.8.14');
  assert.deepEqual(violations, [
    'package-lock.json version: expected "1.8.15", found "1.8.14"',
    'package-lock.json packages[""].version: expected "1.8.15", found "1.8.14"',
  ]);
});

test('accepts safe SemVer integers and rejects unsafe boundary values', () => {
  assert.deepEqual(parseStableVersion('9007199254740991.0.0'), [Number.MAX_SAFE_INTEGER, 0, 0]);
  assert.equal(parseStableVersion('9007199254740992.0.0'), null);
  assert.deepEqual(
    check(declarationWith(['1.8.14']), '9007199254740992.0.0').violations,
    ['package.json version: "9007199254740992.0.0" is not an exact stable SemVer version.'],
  );
});

test('rejects a package version that is not stable SemVer', () => {
  const { violations } = check(declarationWith(['1.8.14']), '1.8.15-rc.1');
  assert.deepEqual(violations, ['package.json version: "1.8.15-rc.1" is not an exact stable SemVer version.']);
});
