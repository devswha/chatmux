import { constants } from 'node:fs';
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { resolveProjectFileForRead } from '@/shared/project-file-containment.js';

/**
 * Highest number of declared skill roots one manifest may contribute.
 *
 * Manifest content is untrusted input, so the declaration list is bounded before
 * any filesystem work is done for it.
 */
export const MAX_DECLARED_SKILL_ROOTS = 32;

/**
 * Number of ancestor directories inspected while attaching a launcher to its
 * installed package. Real npm/bun global layouts place the manifest one or two
 * levels above the launcher, so a short bounded walk is enough and keeps this
 * resolver from wandering into package-manager caches.
 */
const MAX_PACKAGE_ROOT_WALK_DEPTH = 6;

const DEFAULT_MANIFEST_RELATIVE_PATHS = ['package.json'] as const;

/**
 * Sanitized reason a resolution step produced no usable skill root.
 *
 * `declaration-escaped` covers absolute, traversing, and symlink-escaping
 * declarations. `declaration-missing` also covers declarations that resolve to
 * something other than a directory, because neither can be read as a skill root.
 */
export type NativeSkillPackageDiagnosticCategory =
  | 'cli-not-found'
  | 'package-root-not-found'
  | 'manifest-missing'
  | 'manifest-unreadable'
  | 'manifest-invalid'
  | 'declaration-invalid'
  | 'declaration-capped'
  | 'declaration-escaped'
  | 'declaration-missing'
  | 'declaration-unreadable';

/**
 * Diagnostic record safe to log or return internally.
 *
 * `manifest` is the requested package-relative manifest location and never an
 * absolute path, so diagnostics cannot expose where a CLI is installed.
 */
export type NativeSkillPackageDiagnostic = {
  category: NativeSkillPackageDiagnosticCategory;
  manifest?: string;
};

/**
 * One declared skill root that really exists inside the installed package.
 *
 * `rootDir` and `manifestPath` are canonical, so a caller that scans `rootDir`
 * reads exactly the directory that was containment-checked. `declaredBy` is the
 * package-relative manifest that declared the root, which keeps returned skill
 * source paths attributable without re-reading manifests.
 */
export type NativeSkillPackageRoot = {
  rootDir: string;
  manifestPath: string;
  declaredBy: string;
};

export type NativeSkillPackageRequest = {
  command: string;
  /** Manifests to read, relative to the resolved package root. */
  manifestRelativePaths?: readonly string[];
  /** Explicit launcher lookup directories; falls back to `env.PATH`. */
  searchPaths?: readonly string[];
  env?: NodeJS.ProcessEnv;
};

export type NativeSkillPackageResolution = {
  resolved: boolean;
  packageRoot?: string;
  launcherPath?: string;
  version?: string;
  skillRoots: NativeSkillPackageRoot[];
  diagnostics: NativeSkillPackageDiagnostic[];
};

type PackageIdentity = {
  packageRoot: string;
  launcherPath: string;
  version?: string;
};

const readRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const isSafeRelativePath = (value: string): boolean => {
  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized || path.isAbsolute(normalized) || /^[a-zA-Z]:[\\/]/.test(normalized)) {
    return false;
  }

  const segments = normalized.split('/');
  if (segments[segments.length - 1] === '') {
    segments.pop();
  }

  return segments.length > 0 && segments.every((segment) => segment !== '' && segment !== '..');
};

const resolveLauncherPath = async (
  command: string,
  request: NativeSkillPackageRequest,
): Promise<string | null> => {
  if (!command || command.includes('/') || command.includes('\\')) {
    return null;
  }

  const env = request.env ?? process.env;
  const searchPaths = request.searchPaths
    ?? (env.PATH ?? '').split(path.delimiter).filter((entry) => entry.length > 0);

  for (const searchPath of searchPaths) {
    const candidate = path.join(searchPath, command);
    try {
      await lstat(candidate);
      const canonicalPath = await realpath(candidate);
      const stats = await stat(canonicalPath);
      if (!stats.isFile()) {
        continue;
      }
      await access(canonicalPath, constants.X_OK);
      return canonicalPath;
    } catch {
      // A missing, unreadable, or non-executable candidate simply is not the CLI.
    }
  }

  return null;
};

const manifestClaimsLauncher = (
  manifest: Record<string, unknown>,
  manifestDir: string,
  command: string,
  launcherPath: string,
): boolean => {
  const bin = manifest.bin;
  // npm names a string `bin` after the package itself, so only a package named
  // like the command may claim the launcher through the string form.
  const declaredLauncher = typeof bin === 'string'
    ? (manifest.name === command ? bin : null)
    : readRecord(bin)?.[command];
  if (typeof declaredLauncher !== 'string' || !isSafeRelativePath(declaredLauncher)) {
    return false;
  }

  return path.resolve(manifestDir, declaredLauncher) === launcherPath;
};

/**
 * Attaches the launcher to the installed package that declares it through `bin`.
 *
 * Only ancestors of the real launcher are inspected, and the manifest must claim
 * this exact launcher, so an unrelated ancestor package can never lend its
 * skill declarations to the CLI.
 */
const resolvePackageIdentity = async (
  command: string,
  launcherPath: string,
): Promise<PackageIdentity | null> => {
  let current = path.dirname(launcherPath);

  for (let depth = 0; depth <= MAX_PACKAGE_ROOT_WALK_DEPTH; depth += 1) {
    const manifestPath = path.join(current, 'package.json');
    try {
      const manifest = readRecord(JSON.parse(await readFile(manifestPath, 'utf8')));
      if (manifest && manifestClaimsLauncher(manifest, current, command, launcherPath)) {
        return {
          packageRoot: current,
          launcherPath,
          version: typeof manifest.version === 'string' ? manifest.version : undefined,
        };
      }
    } catch {
      // Missing, unreadable, or malformed ancestor manifests are not a match.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }

  return null;
};

const readDeclaredSkillPaths = (
  manifest: Record<string, unknown>,
): { declarations: string[]; invalid: boolean } => {
  if (manifest.pi === undefined) {
    return { declarations: [], invalid: false };
  }

  const pi = readRecord(manifest.pi);
  if (!pi) {
    return { declarations: [], invalid: true };
  }
  if (pi.skills === undefined) {
    return { declarations: [], invalid: false };
  }

  const skills = pi.skills;
  if (!Array.isArray(skills) || skills.length === 0) {
    return { declarations: [], invalid: Array.isArray(skills) ? skills.length > 0 : true };
  }
  if (skills.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    return { declarations: [], invalid: true };
  }

  return { declarations: skills as string[], invalid: false };
};

const resolveDeclaredRoot = async (
  packageRoot: string,
  manifestDir: string,
  declaration: string,
): Promise<{ rootDir: string } | { category: NativeSkillPackageDiagnosticCategory }> => {
  if (!isSafeRelativePath(declaration)) {
    return { category: 'declaration-escaped' };
  }

  const candidate = path.resolve(manifestDir, declaration.trim().replace(/\\/g, '/'));
  let canonicalPath: string | null;
  try {
    canonicalPath = await resolveProjectFileForRead(packageRoot, candidate);
  } catch (error) {
    return {
      category: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'declaration-missing'
        : 'declaration-unreadable',
    };
  }
  if (!canonicalPath) {
    return { category: 'declaration-escaped' };
  }

  try {
    const stats = await stat(canonicalPath);
    if (!stats.isDirectory()) {
      return { category: 'declaration-missing' };
    }
    await access(canonicalPath, constants.R_OK | constants.X_OK);
  } catch (error) {
    return {
      category: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'declaration-missing'
        : 'declaration-unreadable',
    };
  }

  return { rootDir: canonicalPath };
};

/**
 * Resolves the skill roots an installed CLI package declares for itself.
 *
 * The active launcher is located through explicit lookup directories or `PATH`,
 * canonicalized, and attached to the package whose `package.json#bin` claims it.
 * Declared `pi.skills` directories are then resolved relative to the manifest
 * that declared them and must stay inside the package's real root. Nothing is
 * executed, no package-manager cache is searched, and every failure produces a
 * sanitized diagnostic with an empty or partial root list instead of a guess.
 */
export const resolveNativeSkillPackage = async (
  request: NativeSkillPackageRequest,
): Promise<NativeSkillPackageResolution> => {
  const command = request.command.trim();
  const launcherPath = await resolveLauncherPath(command, request);
  if (!launcherPath) {
    return { resolved: false, skillRoots: [], diagnostics: [{ category: 'cli-not-found' }] };
  }

  const identity = await resolvePackageIdentity(command, launcherPath);
  if (!identity) {
    return {
      resolved: false,
      skillRoots: [],
      diagnostics: [{ category: 'package-root-not-found' }],
    };
  }

  const manifestRelativePaths = request.manifestRelativePaths ?? DEFAULT_MANIFEST_RELATIVE_PATHS;
  const skillRoots: NativeSkillPackageRoot[] = [];
  const diagnostics: NativeSkillPackageDiagnostic[] = [];
  const seenRootDirs = new Set<string>();

  for (const manifestRelativePath of manifestRelativePaths) {
    if (!isSafeRelativePath(manifestRelativePath)) {
      diagnostics.push({ category: 'manifest-missing', manifest: manifestRelativePath });
      continue;
    }

    const manifestCandidate = path.resolve(identity.packageRoot, manifestRelativePath);
    let manifestPath: string | null;
    try {
      manifestPath = await resolveProjectFileForRead(identity.packageRoot, manifestCandidate);
    } catch (error) {
      diagnostics.push({
        category: (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'manifest-missing'
          : 'manifest-unreadable',
        manifest: manifestRelativePath,
      });
      continue;
    }
    if (!manifestPath) {
      diagnostics.push({ category: 'manifest-missing', manifest: manifestRelativePath });
      continue;
    }

    let manifest: Record<string, unknown> | null;
    try {
      const content = await readFile(manifestPath, 'utf8');
      try {
        manifest = readRecord(JSON.parse(content));
      } catch {
        diagnostics.push({ category: 'manifest-invalid', manifest: manifestRelativePath });
        continue;
      }
    } catch (error) {
      diagnostics.push({
        category: (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'manifest-missing'
          : 'manifest-unreadable',
        manifest: manifestRelativePath,
      });
      continue;
    }
    if (!manifest) {
      diagnostics.push({ category: 'manifest-invalid', manifest: manifestRelativePath });
      continue;
    }

    const { declarations, invalid } = readDeclaredSkillPaths(manifest);
    if (invalid) {
      diagnostics.push({ category: 'declaration-invalid', manifest: manifestRelativePath });
      continue;
    }

    const manifestDir = path.dirname(manifestPath);
    let acceptedFromManifest = 0;
    let capped = false;
    for (const declaration of declarations) {
      if (acceptedFromManifest >= MAX_DECLARED_SKILL_ROOTS) {
        capped = true;
        break;
      }

      const resolvedRoot = await resolveDeclaredRoot(
        identity.packageRoot,
        manifestDir,
        declaration,
      );
      if ('category' in resolvedRoot) {
        diagnostics.push({ category: resolvedRoot.category, manifest: manifestRelativePath });
        continue;
      }
      if (seenRootDirs.has(resolvedRoot.rootDir)) {
        continue;
      }

      seenRootDirs.add(resolvedRoot.rootDir);
      skillRoots.push({
        rootDir: resolvedRoot.rootDir,
        manifestPath,
        declaredBy: manifestRelativePath,
      });
      acceptedFromManifest += 1;
    }

    if (capped) {
      diagnostics.push({ category: 'declaration-capped', manifest: manifestRelativePath });
    }
  }

  return {
    resolved: true,
    packageRoot: identity.packageRoot,
    launcherPath: identity.launcherPath,
    ...(identity.version === undefined ? {} : { version: identity.version }),
    skillRoots,
    diagnostics,
  };
};
