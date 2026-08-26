import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveNativeSkillPackage } from '@/modules/providers/shared/skills/native-skill-package.js';
import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import { resolveProjectFileForRead } from '@/shared/project-file-containment.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { addUniqueProviderSkillSource } from '@/shared/utils.js';

/**
 * Manifests read from the installed `omo-ai` package to discover its bundled
 * skill roots. The launcher lives at `<root>/bin/omo.js`, and the actual skill
 * bundle is declared through `plugin/package.json#pi.skills`, so both manifests
 * are inspected. Unknown/missing manifests are safely dropped by the resolver.
 */
const OMO_PACKAGE_MANIFEST_PATHS = ['package.json', 'plugin/package.json'] as const;

/**
 * How far up the ancestor chain we walk when collecting `.agents/skills`.
 *
 * Senpi's package manager walks cwd upward until it either hits the enclosing
 * git repo root or exhausts the filesystem. This adapter walks only as far as
 * the git root: if a workspace is outside every git tree we do not follow the
 * chain into unrelated user directories, matching the containment expectations
 * of the surrounding provider suite.
 */
const MAX_AGENT_ANCESTOR_DEPTH = 32;

/**
 * Highest number of runtime skill pointers we honor per settings file. Untrusted
 * `settings.skills` arrays may be arbitrarily long, so a small cap keeps a
 * misconfigured settings file from turning into a filesystem storm.
 */
const MAX_POINTER_SKILL_ROOTS = 32;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads an array of skill pointer strings from a settings file.
 *
 * `settings.skills` is untrusted user input, so anything that is not an array
 * of non-empty strings is treated as absent. The returned array preserves
 * declaration order for deterministic downstream scanning.
 */
const readSkillPointerDeclarations = async (settingsPath: string): Promise<string[]> => {
  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }

  const skills = parsed.skills;
  if (!Array.isArray(skills)) {
    return [];
  }

  const declarations: string[] = [];
  for (const entry of skills) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      declarations.push(entry.trim());
      if (declarations.length >= MAX_POINTER_SKILL_ROOTS) {
        break;
      }
    }
  }
  return declarations;
};

const hasGitMarker = (dirPath: string): boolean => existsSync(path.join(dirPath, '.git'));

/**
 * Returns the nearest git worktree root at or above `startPath`, or null if
 * none exists inside a bounded upward walk. Senpi's `findGitRepoRoot` follows
 * the same "nearest ancestor with a `.git` entry" rule, so this matches how
 * `collectAncestorAgentsSkillDirs` decides where to stop.
 */
const findNearestGitRoot = (startPath: string): string | null => {
  let current = path.resolve(startPath);
  for (let depth = 0; depth <= MAX_AGENT_ANCESTOR_DEPTH; depth += 1) {
    if (hasGitMarker(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
};

/**
 * Enumerates `.agents/skills` directories from the workspace path upward to the
 * enclosing git root (inclusive). When no git root is found the walk is limited
 * to the workspace path itself so an untethered workspace cannot pull in
 * `.agents/skills` from unrelated ancestor directories.
 */
const collectProjectAgentsSkillDirs = (workspacePath: string): string[] => {
  const resolved = path.resolve(workspacePath);
  const gitRoot = findNearestGitRoot(resolved);
  const dirs: string[] = [];
  let current = resolved;
  for (let depth = 0; depth <= MAX_AGENT_ANCESTOR_DEPTH; depth += 1) {
    dirs.push(path.join(current, '.agents', 'skills'));
    if (!gitRoot || current === gitRoot) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirs;
};

/**
 * Resolves a pointer declaration to a canonical directory inside `containment`.
 *
 * Pointers are the untrusted contents of a settings file, so the pointer must
 * (a) resolve to an existing directory and (b) still live inside its
 * containment root after canonicalization. `resolveProjectFileForRead` performs
 * the symlink-safe containment check we already use for other provider
 * skill inputs.
 */
const resolveSkillPointerRoot = async (
  containment: string,
  baseDir: string,
  declaration: string,
): Promise<string | null> => {
  const raw = declaration.replace(/\\/g, '/');
  const candidate = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(baseDir, raw);
  let canonical: string | null;
  try {
    canonical = await resolveProjectFileForRead(containment, candidate);
  } catch {
    return null;
  }
  if (!canonical) {
    return null;
  }
  try {
    const stats = await stat(canonical);
    if (!stats.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  return canonical;
};

const resolveOmoPluginSkillRoots = async (): Promise<string[]> => {
  const resolution = await resolveNativeSkillPackage({
    command: 'omo',
    manifestRelativePaths: OMO_PACKAGE_MANIFEST_PATHS,
  });
  if (!resolution.resolved) {
    return [];
  }
  return resolution.skillRoots.map((root) => root.rootDir);
};

/**
 * OMO skill discovery adapter.
 *
 * OMO ships as the `omo-ai` npm package: a launcher that spawns Senpi with the
 * bundled plugin injected through `--extension <root>/plugin`. Senpi's own
 * resolver then reads skills from
 *   - `<packageRoot>/plugin/skills` (declared via `pi.skills`) - bundled plugin,
 *   - `<agentDir>/skills` and `<home>/.agents/skills` - user auto,
 *   - `<cwd>/.omo/skills` and every `.agents/skills` up to the git root -
 *     project auto,
 *   - `settings.skills` arrays in `~/.omo/agent/settings.json` and
 *     `<cwd>/.omo/settings.json` - the runtime skill-pointer contract.
 *
 * This adapter mirrors that contract and rejects everything else - Codex,
 * Claude, OMP, or foreign compatibility trees. `commandPrefix: '/skill:'` is
 * preserved because the OMO runtime dispatches skills through that prefix.
 */
export class OmoSkillsProvider extends SkillsProvider {
  constructor() {
    super('omo');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const homeDir = os.homedir();
    const resolvedWorkspace = path.resolve(workspacePath);
    const resolvedHome = path.resolve(homeDir);
    const userAgentDir = path.join(resolvedHome, '.omo', 'agent');
    const userAgentsSkillsDir = path.join(resolvedHome, '.agents', 'skills');

    // 1. Project auto-discovery: `<workspace>/.omo/skills`.
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'project',
      rootDir: path.join(resolvedWorkspace, '.omo', 'skills'),
      commandPrefix: '/skill:',
    });

    // 2. Ancestor `.agents/skills` walk (cwd -> git root) as project sources.
    //    Filter out the user's global `.agents/skills` so it stays under the
    //    user scope instead of getting silently promoted to project scope.
    for (const agentsSkillsDir of collectProjectAgentsSkillDirs(resolvedWorkspace)) {
      if (path.resolve(agentsSkillsDir) === userAgentsSkillsDir) {
        continue;
      }
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'project',
        rootDir: agentsSkillsDir,
        commandPrefix: '/skill:',
      });
    }

    // 3. Project runtime pointers: `<workspace>/.omo/settings.json#skills`.
    //    Pointers must resolve inside the workspace tree.
    const projectSettingsPath = path.join(resolvedWorkspace, '.omo', 'settings.json');
    for (const declaration of await readSkillPointerDeclarations(projectSettingsPath)) {
      const rootDir = await resolveSkillPointerRoot(
        resolvedWorkspace,
        resolvedWorkspace,
        declaration,
      );
      if (rootDir === null) {
        continue;
      }
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'project',
        rootDir,
        commandPrefix: '/skill:',
      });
    }

    // 4. User auto-discovery: `~/.omo/agent/skills` and `~/.agents/skills`.
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(userAgentDir, 'skills'),
      commandPrefix: '/skill:',
    });
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: userAgentsSkillsDir,
      commandPrefix: '/skill:',
    });

    // 5. User runtime pointers: `~/.omo/agent/settings.json#skills`, contained
    //    inside `~/.omo`. That keeps the pointer surface as wide as the OMO
    //    runtime's own state directory without letting a hostile settings
    //    write expose `/etc` or another user's home.
    const userSettingsPath = path.join(userAgentDir, 'settings.json');
    const userPointerRoot = path.join(resolvedHome, '.omo');
    for (const declaration of await readSkillPointerDeclarations(userSettingsPath)) {
      const rootDir = await resolveSkillPointerRoot(
        userPointerRoot,
        userAgentDir,
        declaration,
      );
      if (rootDir === null) {
        continue;
      }
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'user',
        rootDir,
        commandPrefix: '/skill:',
      });
    }

    // 6. Plugin-declared bundled skills through `pi.skills`. Runs last so any
    //    project or user override with the same name wins the command-dedupe.
    for (const rootDir of await resolveOmoPluginSkillRoots()) {
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'plugin',
        rootDir,
        commandPrefix: '/skill:',
      });
    }

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.omo', 'agent', 'skills'),
      commandPrefix: '/skill:',
    };
  }
}
