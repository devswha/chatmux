#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DECLARATION_PATH = 'packaging/release/update-compatibility.json';
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function parseStableVersion(value) {
  const match = typeof value === 'string' ? STABLE_SEMVER.exec(value) : null;
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(left, right) {
  return left.reduce((result, value, index) => result || value - right[index], 0);
}

export function findPreviousRelease(declaration, targetVersion) {
  const target = parseStableVersion(targetVersion);
  if (!target) return null;

  const previous = Object.keys(declaration?.releases ?? {})
    .map((version) => ({ parsed: parseStableVersion(version), version }))
    .filter((release) => release.parsed && compareVersions(release.parsed, target) < 0)
    .reduce((highest, release) => !highest || compareVersions(release.parsed, highest.parsed) > 0 ? release : highest, null);

  return previous ? previous.version : null;
}

export function findVersionDisagreements(packageJson, packageLock) {
  const targetVersion = packageJson?.version;

  return [
    ['package-lock.json version', packageLock?.version],
    ['package-lock.json packages[""].version', packageLock?.packages?.['']?.version],
  ]
    .filter(([, version]) => version !== targetVersion)
    .map(([label, version]) => `${label}: expected ${JSON.stringify(targetVersion)}, found ${JSON.stringify(version)}`);
}

function declaredRollbackVersions(declaration, version) {
  const versions = declaration?.releases?.[version]?.database?.rollbackCompatibleFrom;
  return Array.isArray(versions) ? versions : null;
}

function findDeclarationViolations(declaration, targetVersion) {
  if (declaration?.schema !== 1) {
    return [`${DECLARATION_PATH}: expected schema 1, found ${JSON.stringify(declaration?.schema)}`];
  }

  const label = `${DECLARATION_PATH} releases["${targetVersion}"].database.rollbackCompatibleFrom`;
  const declared = declaredRollbackVersions(declaration, targetVersion);
  if (!declared) {
    return [`${label}: no exact compatibility declaration exists for ${targetVersion}.`];
  }

  const violations = [];
  const target = parseStableVersion(targetVersion);
  const seen = new Set();
  for (const version of declared) {
    const parsed = parseStableVersion(version);
    if (!parsed) {
      violations.push(`${label}: ${JSON.stringify(version)} is not an exact stable SemVer version.`);
      continue;
    }
    if (seen.has(version)) {
      violations.push(`${label}: ${version} is declared more than once.`);
    }
    seen.add(version);
    if (compareVersions(parsed, target) >= 0) {
      violations.push(`${label}: ${version} is not lower than the target version ${targetVersion}.`);
    }
  }

  const previousVersion = findPreviousRelease(declaration, targetVersion);
  if (previousVersion === null) {
    return violations;
  }

  // A release that migrates the schema resets the window to exactly its predecessor.
  // Anything else must carry the predecessor's window forward: dropping carried-forward
  // versions strands installs more than one release behind in manual_required (#49).
  if (declared.length === 1 && declared[0] === previousVersion) {
    return violations;
  }

  const carried = declaredRollbackVersions(declaration, previousVersion) ?? [];
  const missing = [...carried, previousVersion].filter((version) => !seen.has(version));
  if (missing.length > 0) {
    violations.push(
      `${label}: must be exactly ["${previousVersion}"] when the release migrates the database schema, ` +
      `or carry forward every version declared by ${previousVersion} plus ${previousVersion} itself; ` +
      `missing ${missing.join(', ')}.`,
    );
  }

  return violations;
}

export function checkReleaseMetadata({ declaration, packageJson, packageLock }) {
  const targetVersion = packageJson?.version;
  if (!parseStableVersion(targetVersion)) {
    return {
      targetVersion,
      violations: [`package.json version: ${JSON.stringify(targetVersion)} is not an exact stable SemVer version.`],
    };
  }

  return {
    targetVersion,
    violations: [
      ...findVersionDisagreements(packageJson, packageLock),
      ...findDeclarationViolations(declaration, targetVersion),
    ],
  };
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(REPOSITORY_ROOT, relativePath), 'utf8'));
}

async function main() {
  const [packageJson, packageLock, declaration] = await Promise.all([
    readJson('package.json'),
    readJson('package-lock.json'),
    readJson(DECLARATION_PATH),
  ]);
  const { targetVersion, violations } = checkReleaseMetadata({ declaration, packageJson, packageLock });

  if (violations.length > 0) {
    console.error(`Release metadata check failed for ${targetVersion} with ${violations.length} violation(s).`);
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  const declared = declaredRollbackVersions(declaration, targetVersion) ?? [];
  console.log(
    `Release metadata check passed for ${targetVersion} (${declared.length} rollback-compatible version(s) declared).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
