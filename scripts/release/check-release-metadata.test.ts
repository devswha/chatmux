import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkReleaseMetadata,
  findPreviousRelease,
} from './check-release-metadata.mjs';

const TARGET = '1.8.15';

function declarationWith(rollbackCompatibleFrom: string[], targetVersion: string = TARGET) {
  return {
    schema: 1,
    releases: {
      '1.8.12': { database: { rollbackCompatibleFrom: ['1.8.11'] } },
      '1.8.13': { database: { rollbackCompatibleFrom: ['1.8.12'] } },
      '1.8.14': { database: { rollbackCompatibleFrom: ['1.8.12', '1.8.13'] } },
      [targetVersion]: { database: { rollbackCompatibleFrom } },
    },
  };
}

function check(declaration: unknown, version: string = TARGET, lockVersion: string = version) {
  return checkReleaseMetadata({
    declaration,
    packageJson: { version },
    packageLock: { version: lockVersion, packages: { '': { version: lockVersion } } },
  });
}

test('accepts a schema-unchanged release that carries the previous window forward', () => {
  const result = check(declarationWith(['1.8.12', '1.8.13', '1.8.14']));

  assert.equal(findPreviousRelease(declarationWith(['1.8.12', '1.8.13', '1.8.14']), TARGET), '1.8.14');
  assert.deepEqual(result.violations, []);
});

test('accepts an explicit schema-migration boundary declaring only the previous release', () => {
  assert.deepEqual(check(declarationWith(['1.8.14'])).violations, []);
});

test('rejects a partial carry-forward that strands older installs (#49)', () => {
  const { violations } = check(declarationWith(['1.8.13', '1.8.14']));

  assert.equal(violations.length, 1);
  assert.match(violations[0], /missing 1\.8\.12\./u);
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
  const { violations } = check(declarationWith(['1.8.12', '1.8.13', '1.8.14'], '1.8.16'));

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

test('rejects a package version that is not stable SemVer', () => {
  const { violations } = check(declarationWith(['1.8.14']), '1.8.15-rc.1');

  assert.deepEqual(violations, ['package.json version: "1.8.15-rc.1" is not an exact stable SemVer version.']);
});
