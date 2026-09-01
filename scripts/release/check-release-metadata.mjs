#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DECLARATION_PATH = 'packaging/release/update-compatibility.json';
const MIGRATION_REGISTRY_PATH = 'server/modules/database/migration-parts/migration-registry.ts';
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function parseStableVersion(value) {
  const match = typeof value === 'string' ? STABLE_SEMVER.exec(value) : null;
  if (!match) return null;
  const components = match.slice(1).map(Number);
  return components.every(Number.isSafeInteger) ? components : null;
}

export function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export function deriveSchemaGeneration(source, label = MIGRATION_REGISTRY_PATH) {
  const sourceFile = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let migrations;

  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'MIGRATIONS' &&
      node.initializer
    ) {
      let initializer = node.initializer;
      while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) initializer = initializer.expression;
      if (ts.isArrayLiteralExpression(initializer)) migrations = initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!migrations) throw new Error(`${label}: could not find the MIGRATIONS array.`);

  const versions = migrations.elements.map((element, index) => {
    if (!ts.isObjectLiteralExpression(element)) {
      throw new Error(`${label}: migration ${index + 1} is not an object literal.`);
    }
    const property = element.properties.find((candidate) =>
      ts.isPropertyAssignment(candidate) &&
      ((ts.isIdentifier(candidate.name) && candidate.name.text === 'version') ||
        (ts.isStringLiteral(candidate.name) && candidate.name.text === 'version')),
    );
    if (!property || !ts.isPropertyAssignment(property) || !ts.isNumericLiteral(property.initializer)) {
      throw new Error(`${label}: migration ${index + 1} has no literal numeric version.`);
    }
    return Number(property.initializer.text);
  });

  for (let index = 0; index < versions.length; index += 1) {
    if (!Number.isSafeInteger(versions[index]) || versions[index] !== index + 1) {
      throw new Error(`${label}: migration versions must be contiguous safe integers starting at 1.`);
    }
  }
  return versions.length;
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

function databaseMetadata(declaration, version) {
  return declaration?.releases?.[version]?.database;
}

function declaredRollbackVersions(declaration, version) {
  const versions = databaseMetadata(declaration, version)?.rollbackCompatibleFrom;
  return Array.isArray(versions) ? versions : null;
}

function findDeclarationViolations(declaration, canonicalDeclaration, targetVersion, codeSchemaGeneration, canonicalSchemaGeneration) {
  if (declaration?.schema !== 1) {
    return [`${DECLARATION_PATH}: expected schema 1, found ${JSON.stringify(declaration?.schema)}`];
  }
  if (canonicalDeclaration && canonicalDeclaration.schema !== 1) {
    return [`canonical ${DECLARATION_PATH}: expected schema 1, found ${JSON.stringify(canonicalDeclaration?.schema)}`];
  }

  const databaseLabel = `${DECLARATION_PATH} releases["${targetVersion}"].database`;
  const label = `${databaseLabel}.rollbackCompatibleFrom`;
  const targetDatabase = databaseMetadata(declaration, targetVersion);
  const declared = declaredRollbackVersions(declaration, targetVersion);
  if (!declared) {
    return [`${label}: no exact compatibility declaration exists for ${targetVersion}.`];
  }

  const violations = [];
  if (!Number.isSafeInteger(targetDatabase?.schemaGeneration) || targetDatabase.schemaGeneration < 0) {
    violations.push(`${databaseLabel}.schemaGeneration: must be a non-negative safe integer derived from the migration registry.`);
  } else if (targetDatabase.schemaGeneration !== codeSchemaGeneration) {
    violations.push(`${databaseLabel}.schemaGeneration: expected code-derived generation ${codeSchemaGeneration}, found ${JSON.stringify(targetDatabase.schemaGeneration)}.`);
  }

  const target = parseStableVersion(targetVersion);
  const seen = new Set();
  for (const version of declared) {
    const parsed = parseStableVersion(version);
    if (!parsed) {
      violations.push(`${label}: ${JSON.stringify(version)} is not an exact stable SemVer version.`);
      continue;
    }
    if (seen.has(version)) violations.push(`${label}: ${version} is declared more than once.`);
    seen.add(version);
    if (compareVersions(parsed, target) >= 0) {
      violations.push(`${label}: ${version} is not lower than the target version ${targetVersion}.`);
    }
  }

  const history = canonicalDeclaration ?? declaration;
  const previousVersion = findPreviousRelease(history, targetVersion);
  if (previousVersion === null) return violations;

  if (canonicalDeclaration) {
    const currentPrevious = declaration?.releases?.[previousVersion];
    const canonicalPrevious = canonicalDeclaration?.releases?.[previousVersion];
    if (JSON.stringify(currentPrevious) !== JSON.stringify(canonicalPrevious)) {
      violations.push(`${DECLARATION_PATH} releases["${previousVersion}"]: differs from canonical metadata published at the predecessor tag.`);
    }
  }

  // Published metadata is immutable, and releases up to 1.8.14 predate schemaGeneration.
  // The predecessor's generation is therefore derived from the migration registry source
  // at the predecessor tag when available, with the recorded value as local fallback.
  const previousDatabase = databaseMetadata(history, previousVersion);
  const recordedPreviousGeneration = previousDatabase?.schemaGeneration;
  const previousGeneration = Number.isSafeInteger(canonicalSchemaGeneration)
    ? canonicalSchemaGeneration
    : recordedPreviousGeneration;
  if (
    Number.isSafeInteger(canonicalSchemaGeneration) &&
    Number.isSafeInteger(recordedPreviousGeneration) &&
    canonicalSchemaGeneration !== recordedPreviousGeneration
  ) {
    violations.push(
      `${DECLARATION_PATH} releases["${previousVersion}"].database.schemaGeneration: recorded ` +
      `${recordedPreviousGeneration} disagrees with generation ${canonicalSchemaGeneration} ` +
      'derived from the migration registry at the predecessor tag.',
    );
  }
  const targetGeneration = targetDatabase?.schemaGeneration;
  const generationIncreased =
    Number.isSafeInteger(previousGeneration) &&
    Number.isSafeInteger(targetGeneration) &&
    previousGeneration < targetGeneration;
  const singletonPrevious = declared.length === 1 && declared[0] === previousVersion;
  if (singletonPrevious && generationIncreased) return violations;

  const carried = declaredRollbackVersions(history, previousVersion) ?? [];
  const missing = [...carried, previousVersion].filter((version) => !seen.has(version));
  if (missing.length > 0) {
    violations.push(
      `${label}: a singleton predecessor is allowed only when its schema generation (derived from the ` +
      'predecessor tag when available, otherwise recorded) is lower than the target generation; ' +
      `otherwise carry forward every version declared by ${previousVersion} plus ` +
      `${previousVersion} itself; missing ${missing.join(', ')}.`,
    );
  }

  return violations;
}

export function checkReleaseMetadata({
  canonicalDeclaration,
  canonicalSchemaGeneration,
  codeSchemaGeneration,
  declaration,
  packageJson,
  packageLock,
}) {
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
      ...findDeclarationViolations(declaration, canonicalDeclaration, targetVersion, codeSchemaGeneration, canonicalSchemaGeneration),
    ],
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const canonicalArgumentIndex = process.argv.indexOf('--canonical-declaration');
  const canonicalPath = canonicalArgumentIndex >= 0
    ? process.argv[canonicalArgumentIndex + 1]
    : process.env.CHATMUX_CANONICAL_COMPATIBILITY_DECLARATION;
  if (canonicalArgumentIndex >= 0 && !canonicalPath) throw new Error('--canonical-declaration requires a path.');
  const canonicalRegistryPath = process.env.CHATMUX_CANONICAL_MIGRATION_REGISTRY;

  const [packageJson, packageLock, declaration, migrationSource, canonicalDeclaration, canonicalRegistrySource] = await Promise.all([
    readJson(resolve(REPOSITORY_ROOT, 'package.json')),
    readJson(resolve(REPOSITORY_ROOT, 'package-lock.json')),
    readJson(resolve(REPOSITORY_ROOT, DECLARATION_PATH)),
    readFile(resolve(REPOSITORY_ROOT, MIGRATION_REGISTRY_PATH), 'utf8'),
    canonicalPath ? readJson(resolve(canonicalPath)) : null,
    canonicalRegistryPath ? readFile(resolve(canonicalRegistryPath), 'utf8') : null,
  ]);
  if (!canonicalDeclaration) {
    console.warn('Warning: no canonical compatibility declaration provided; using mutable in-repository history.');
  }
  if (!canonicalRegistrySource) {
    console.warn('Warning: no canonical migration registry provided; using the recorded predecessor schema generation.');
  }
  const codeSchemaGeneration = deriveSchemaGeneration(migrationSource);
  const canonicalSchemaGeneration = canonicalRegistrySource
    ? deriveSchemaGeneration(canonicalRegistrySource, 'canonical predecessor migration registry')
    : null;
  const { targetVersion, violations } = checkReleaseMetadata({
    canonicalDeclaration,
    canonicalSchemaGeneration,
    codeSchemaGeneration,
    declaration,
    packageJson,
    packageLock,
  });

  if (violations.length > 0) {
    console.error(`Release metadata check failed for ${targetVersion} with ${violations.length} violation(s).`);
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }

  const declared = declaredRollbackVersions(declaration, targetVersion) ?? [];
  console.log(
    `Release metadata check passed for ${targetVersion} (schema generation ${codeSchemaGeneration}; ` +
    `${declared.length} rollback-compatible version(s) declared).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
