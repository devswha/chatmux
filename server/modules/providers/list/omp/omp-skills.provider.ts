import { existsSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type {
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderSkillSource,
} from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/**
 * Absolute ceiling on returned OMP skill entries. Mirrors the 500-entry limit
 * used by the native skill probe and the shared command discovery so a
 * misconfigured plugins directory or a huge custom dir cannot flood the palette.
 */
const MAX_OMP_SKILL_ENTRIES = 500;

/**
 * How far up the ancestor chain we walk when collecting project-local skill
 * dirs. Matches Senpi/OMP's own `.claude`/`.omp`/`.agents` walk from cwd to the
 * git worktree root.
 */
const MAX_ANCESTOR_DEPTH = 32;

type OmpSkillToggles = {
  enabled: boolean;
  enablePiUser: boolean;
  enablePiProject: boolean;
  enableClaudeUser: boolean;
  enableClaudeProject: boolean;
  enableAgentsUser: boolean;
  enableAgentsProject: boolean;
  enableCodexUser: boolean;
  customDirectories: string[];
};

const DEFAULT_TOGGLES: OmpSkillToggles = {
  enabled: true,
  enablePiUser: true,
  enablePiProject: true,
  enableClaudeUser: true,
  enableClaudeProject: true,
  enableAgentsUser: true,
  enableAgentsProject: true,
  enableCodexUser: true,
  customDirectories: [],
};

const readBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const readStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const s = readOptionalString(entry);
    if (s) out.push(s);
  }
  return out;
};

/**
 * Loads `~/.omp/agent/settings.json` (legacy JSON form of OMP's `config.yml`;
 * still consulted by OMP's own migration path) and extracts the `skills.*`
 * gates. Missing/malformed files fall back to "all defaults enabled" so the
 * provider fails open rather than hiding every source.
 */
const loadTogglesFromSettings = async (settingsPath: string): Promise<OmpSkillToggles> => {
  const raw = await readJsonConfig(settingsPath).catch(() => ({} as Record<string, unknown>));
  const skills = readObjectRecord(raw.skills) ?? {};
  return {
    enabled: readBool(skills.enabled, DEFAULT_TOGGLES.enabled),
    enablePiUser: readBool(skills.enablePiUser, DEFAULT_TOGGLES.enablePiUser),
    enablePiProject: readBool(skills.enablePiProject, DEFAULT_TOGGLES.enablePiProject),
    enableClaudeUser: readBool(skills.enableClaudeUser, DEFAULT_TOGGLES.enableClaudeUser),
    enableClaudeProject: readBool(skills.enableClaudeProject, DEFAULT_TOGGLES.enableClaudeProject),
    enableAgentsUser: readBool(skills.enableAgentsUser, DEFAULT_TOGGLES.enableAgentsUser),
    enableAgentsProject: readBool(skills.enableAgentsProject, DEFAULT_TOGGLES.enableAgentsProject),
    enableCodexUser: readBool(skills.enableCodexUser, DEFAULT_TOGGLES.enableCodexUser),
    customDirectories: readStringArray(skills.customDirectories),
  };
};

const hasGitMarker = (dir: string): boolean => existsSync(path.join(dir, '.git'));

/**
 * Returns the nearest git worktree root at or above `startPath`, else null.
 * OMP's `agents`, `claude`, and `native` discovery providers all walk the
 * ancestor chain up to (but not past) this root.
 */
const findNearestGitRoot = (startPath: string): string | null => {
  let current = path.resolve(startPath);
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    if (hasGitMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
};

/**
 * Enumerates ancestor directories from workspacePath up to the git root
 * (inclusive), or just the workspacePath when no git root is found.
 */
const ancestorsToGitRoot = (workspacePath: string): string[] => {
  const resolved = path.resolve(workspacePath);
  const gitRoot = findNearestGitRoot(resolved);
  const ancestors: string[] = [];
  let current = resolved;
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    ancestors.push(current);
    if (!gitRoot || current === gitRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
};

const listChildDirectories = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(dir, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
};

/**
 * Enumerates enabled OMP extension package roots under `~/.omp/plugins`.
 *
 * Real OMP resolves plugins through `getEnabledPlugins` (union of
 * `<root>/package.json#dependencies` and `<root>/omp-plugins.lock.json#plugins`,
 * filtered by manifest key + lockfile enable state). This adapter takes a
 * bounded, purely filesystem shape of the same contract: scan
 * `<root>/node_modules/*` (and `<root>/node_modules/@scope/*`) and only keep
 * packages whose `package.json` has an `omp` or `pi` manifest key. The
 * lockfile disables individual plugins by name.
 */
const listOmpPluginSkillDirs = async (homeDir: string): Promise<string[]> => {
  const pluginsRoot = path.join(homeDir, '.omp', 'plugins');
  const nodeModules = path.join(pluginsRoot, 'node_modules');
  const disabled = new Set<string>();
  try {
    const lock = await readJsonConfig(path.join(pluginsRoot, 'omp-plugins.lock.json'));
    const plugins = readObjectRecord(lock.plugins);
    if (plugins) {
      for (const [name, state] of Object.entries(plugins)) {
        const rec = readObjectRecord(state);
        if (rec && rec.enabled === false) disabled.add(name);
      }
    }
  } catch {
    // Malformed lockfile: fail open (every plugin enabled unless disabled inline).
  }

  const results: string[] = [];
  const topEntries = await listChildDirectories(nodeModules);
  const packageDirs: string[] = [];
  for (const entry of topEntries) {
    if (path.basename(entry).startsWith('@')) {
      packageDirs.push(...(await listChildDirectories(entry)));
    } else {
      packageDirs.push(entry);
    }
  }

  for (const packageDir of packageDirs) {
    const packageName = packageDir.startsWith(`${nodeModules}${path.sep}`)
      ? packageDir.slice(nodeModules.length + 1)
      : path.basename(packageDir);
    if (disabled.has(packageName)) continue;

    let manifest: Record<string, unknown>;
    try {
      manifest = await readJsonConfig(path.join(packageDir, 'package.json'));
    } catch {
      continue;
    }
    // Only accept packages that advertise themselves as OMP extensions.
    if (!readObjectRecord(manifest.omp) && !readObjectRecord(manifest.pi)) continue;
    results.push(path.join(packageDir, 'skills'));
  }
  return results;
};

/**
 * Enumerates enabled Claude plugin skill roots under `~/.claude/plugins/cache`
 * respecting `~/.claude/settings.json#enabledPlugins` and the install paths
 * recorded in `~/.claude/plugins/installed_plugins.json`. Mirrors the shape of
 * ChatMux's `ClaudeSkillsProvider` plugin discovery so OMP surfaces the same
 * marketplace plugins the underlying Claude runtime would.
 */
const listClaudePluginSkillDirs = async (homeDir: string): Promise<string[]> => {
  const claudeHome = path.join(homeDir, '.claude');
  const settings = await readJsonConfig(path.join(claudeHome, 'settings.json'));
  const enabled = readObjectRecord(settings.enabledPlugins);
  if (!enabled) return [];

  const installed = readObjectRecord(
    (await readJsonConfig(path.join(claudeHome, 'plugins', 'installed_plugins.json'))).plugins,
  );
  if (!installed) return [];

  const roots: string[] = [];
  const visited = new Set<string>();
  for (const [pluginId, isEnabled] of Object.entries(enabled).sort(([a], [b]) => a.localeCompare(b))) {
    if (isEnabled !== true) continue;
    const installs = installed[pluginId];
    if (!Array.isArray(installs)) continue;
    for (const install of installs) {
      const record = readObjectRecord(install);
      const installPath = readOptionalString(record?.installPath);
      if (!installPath) continue;
      // Claude's install path points at one version folder; usable plugin
      // payloads live in its sibling folders (see ClaudeSkillsProvider).
      const siblings = await listChildDirectories(path.dirname(installPath));
      for (const sibling of siblings) {
        const key = path.resolve(sibling);
        if (visited.has(key)) continue;
        visited.add(key);
        const skillsDir = path.join(sibling, 'skills');
        if (existsSync(skillsDir)) roots.push(skillsDir);
      }
    }
  }
  return roots;
};

/**
 * OMP skill discovery adapter.
 *
 * Encodes OMP's documented resolver precedence (`@oh-my-pi/pi-coding-agent`
 * `discovery/*.ts`, priorities in parentheses):
 *
 *   native (100) > omp-plugins (90) > claude (80) > claude-plugins (70)
 *     > agents (70) > codex (70) > opencode (55) > github (30) > managed (5)
 *
 * Sources are emitted top-to-bottom so the shared command-key dedupe
 * (`dedupeProviderSkillsByCommand`) resolves same-name collisions as
 * first-wins across tiers. `~/.omp/agent/settings.json#skills.*` gates each
 * documented source and injects `customDirectories` at the top of the user
 * tier so they beat default-path sources. `commandPrefix: '/skill:'` is
 * preserved (OMP dispatches skills via `/skill:<name>`), the shared managed
 * root stays at `~/.omp/agent/skills` for add/list/remove, and every returned
 * skill has an existing SKILL.md sourcePath.
 */
export class OmpSkillsProvider extends SkillsProvider {
  constructor() {
    super('omp');
  }

  /**
   * Overrides base list to enforce a 500-entry cap and realpath-based dedup
   * so symlinked or duplicated source dirs never expand the palette twice.
   */
  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const raw = await super.listSkills(options);
    const seenReal = new Set<string>();
    const seenName = new Set<string>();
    const capped: ProviderSkill[] = [];
    for (const skill of raw) {
      let realPath = skill.sourcePath;
      try { realPath = await realpath(skill.sourcePath); } catch { /* keep declared path */ }
      // Dedupe on real skill file so that symlinked source directories
      // pointing at the same on-disk SKILL.md collapse to one entry.
      const dedupeKey = `${realPath}::${skill.name}`;
      if (seenReal.has(dedupeKey)) continue;
      seenReal.add(dedupeKey);
      // Also dedupe by name inside this provider so tier precedence resolves
      // to the highest source before the service-level command dedupe runs.
      if (seenName.has(skill.name)) continue;
      seenName.add(skill.name);
      capped.push(skill);
      if (capped.length >= MAX_OMP_SKILL_ENTRIES) break;
    }
    return capped;
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const homeDir = os.homedir();
    const resolvedHome = path.resolve(homeDir);
    const resolvedWorkspace = path.resolve(workspacePath);
    const settingsPath = path.join(resolvedHome, '.omp', 'agent', 'settings.json');
    const toggles = await loadTogglesFromSettings(settingsPath);

    if (!toggles.enabled) return [];

    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();

    const add = (source: ProviderSkillSource): void => {
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        commandPrefix: '/skill:',
        ...source,
      });
    };

    // Tier 0: settings.customDirectories - explicit user overrides win first.
    for (const raw of toggles.customDirectories) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const expanded = trimmed.startsWith('~')
        ? path.join(resolvedHome, trimmed.slice(1))
        : trimmed;
      add({
        scope: 'user',
        rootDir: path.isAbsolute(expanded) ? expanded : path.resolve(resolvedWorkspace, expanded),
        commandPrefix: '/skill:',
      });
    }

    const ancestors = ancestorsToGitRoot(resolvedWorkspace);

    // Tier 1: native (project walk-up `.omp/skills`) + user `~/.omp/agent/skills`.
    if (toggles.enablePiProject) {
      for (const ancestor of ancestors) {
        add({ scope: 'project', rootDir: path.join(ancestor, '.omp', 'skills'), commandPrefix: '/skill:' });
      }
    }
    if (toggles.enablePiUser) {
      add({ scope: 'user', rootDir: path.join(resolvedHome, '.omp', 'agent', 'skills'), commandPrefix: '/skill:' });
    }

    // Tier 2: extension/plugin - `~/.omp/plugins/node_modules/<pkg>/skills`.
    for (const rootDir of await listOmpPluginSkillDirs(resolvedHome)) {
      add({ scope: 'plugin', rootDir, commandPrefix: '/skill:' });
    }

    // Tier 3: claude (project walk-up `.claude/skills`) + user `~/.claude/skills`.
    if (toggles.enableClaudeProject) {
      for (const ancestor of ancestors) {
        add({ scope: 'project', rootDir: path.join(ancestor, '.claude', 'skills'), commandPrefix: '/skill:' });
      }
    }
    if (toggles.enableClaudeUser) {
      add({ scope: 'user', rootDir: path.join(resolvedHome, '.claude', 'skills'), commandPrefix: '/skill:' });
    }

    // Tier 4: claude-plugins - installed marketplace plugin skill dirs.
    for (const rootDir of await listClaudePluginSkillDirs(resolvedHome)) {
      add({ scope: 'plugin', rootDir, commandPrefix: '/skill:', recursive: true });
    }

    // Tier 5: agents - walk-up `.agent/skills` + `.agents/skills` + user.
    if (toggles.enableAgentsProject) {
      for (const ancestor of ancestors) {
        for (const base of ['.agent', '.agents']) {
          add({ scope: 'project', rootDir: path.join(ancestor, base, 'skills'), commandPrefix: '/skill:' });
        }
      }
    }
    if (toggles.enableAgentsUser) {
      for (const base of ['.agent', '.agents']) {
        add({ scope: 'user', rootDir: path.join(resolvedHome, base, 'skills'), commandPrefix: '/skill:' });
      }
    }

    // Tier 6: codex - project + user (Codex user tier gated by enableCodexUser).
    add({ scope: 'project', rootDir: path.join(resolvedWorkspace, '.codex', 'skills'), commandPrefix: '/skill:' });
    if (toggles.enableCodexUser) {
      add({ scope: 'user', rootDir: path.join(resolvedHome, '.codex', 'skills'), commandPrefix: '/skill:' });
    }

    // Tier 7: opencode - project `<workspace>/.opencode/skills` + user `~/.config/opencode/skills`.
    add({ scope: 'project', rootDir: path.join(resolvedWorkspace, '.opencode', 'skills'), commandPrefix: '/skill:' });
    add({ scope: 'user', rootDir: path.join(resolvedHome, '.config', 'opencode', 'skills'), commandPrefix: '/skill:' });

    // Tier 8: github - project `<workspace>/.github/skills`.
    add({ scope: 'project', rootDir: path.join(resolvedWorkspace, '.github', 'skills'), commandPrefix: '/skill:' });

    // Tier 9: managed (dead last) - `~/.omp/agent/managed-skills`.
    add({ scope: 'user', rootDir: path.join(resolvedHome, '.omp', 'agent', 'managed-skills'), commandPrefix: '/skill:' });

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.omp', 'agent', 'skills'),
      commandPrefix: '/skill:',
    };
  }
}
