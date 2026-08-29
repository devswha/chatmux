import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';

/**
 * OMP provider skill contract (plan Task 6).
 *
 * OMP's real resolver (`@oh-my-pi/pi-coding-agent` `discovery/*`) registers
 * every source at a numeric priority; the effective ranking is:
 *
 *   native (100) > omp-plugins (90) > claude (80) > claude-plugins (70)
 *     > agents (70) > codex (70) > opencode (55) > github (30) > managed (5)
 *
 * The `agents` provider walks `.agent[s]/skills` from cwd to the git root.
 * `~/.omp/agent/settings.json#skills.*` gates each documented source and lets
 * users declare `customDirectories` that beat default-path sources. Managed
 * (auto-learn) skills live at `~/.omp/agent/managed-skills`; user-authored
 * skills live at `~/.omp/agent/skills` (the shared managed-writes root).
 *
 * These fixtures characterize every tier before touching the provider and go
 * red only where the current adapter drifts from that contract.
 */

const HOMEDIR_MODULE = os as unknown as { homedir: () => string };
const patchHomeDir = (nextHomeDir: string): (() => void) => {
  const original = HOMEDIR_MODULE.homedir;
  HOMEDIR_MODULE.homedir = () => nextHomeDir;
  return () => {
    HOMEDIR_MODULE.homedir = original;
  };
};

const writeSkill = async (
  skillsRoot: string,
  directoryName: string,
  name: string,
  description = `Body for ${name}`,
): Promise<string> => {
  const skillDir = path.join(skillsRoot, directoryName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(
    skillPath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`,
    'utf8',
  );
  return skillPath;
};

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
};

type Sandbox = {
  homeDir: string;
  workspacePath: string;
  restore: () => Promise<void>;
};

/**
 * Isolates every OMP surface: temp homedir stubbed via `os.homedir`, a fresh
 * workspace under it, and a `.git` marker so `.claude`/`agents` walk-up rules
 * stop at the repo root rather than climbing into the real user home. The
 * fresh temp home also guarantees `~/.omp/agent/settings.json`,
 * `~/.claude/plugins/*`, and `~/.omp/plugins/*` start empty so each fixture
 * controls exactly the sources under test.
 */
const makeSandbox = async (label: string): Promise<Sandbox> => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-skills-${label}-`));
  const workspacePath = path.join(homeDir, 'workspace');
  await fs.mkdir(path.join(workspacePath, '.git'), { recursive: true });
  const restoreHomeDir = patchHomeDir(homeDir);
  return {
    homeDir,
    workspacePath,
    restore: async () => {
      restoreHomeDir();
      await fs.rm(homeDir, { recursive: true, force: true });
    },
  };
};

const listOmp = (workspacePath: string) =>
  providerSkillsService.listProviderSkills('omp', { workspacePath });

const byName = (skills: Awaited<ReturnType<typeof listOmp>>) =>
  new Map(skills.map((skill) => [skill.name, skill]));

/**
 * Writes an OMP extension plugin under `~/.omp/plugins/node_modules/<name>`
 * with an `omp` (or `pi`) manifest key so the loader accepts it as an enabled
 * plugin. Optionally writes/updates `omp-plugins.lock.json` to disable it.
 */
const installOmpPlugin = async (
  homeDir: string,
  packageName: string,
  options: { manifestKey?: 'omp' | 'pi'; disabled?: boolean } = {},
): Promise<string> => {
  const pluginsRoot = path.join(homeDir, '.omp', 'plugins');
  const packageDir = path.join(pluginsRoot, 'node_modules', packageName);
  await fs.mkdir(packageDir, { recursive: true });
  const manifestKey = options.manifestKey ?? 'omp';
  await writeJson(path.join(packageDir, 'package.json'), {
    name: packageName,
    version: '1.0.0',
    [manifestKey]: {},
  });
  if (options.disabled) {
    const lockPath = path.join(pluginsRoot, 'omp-plugins.lock.json');
    let lock: { plugins?: Record<string, { enabled?: boolean }> } = {};
    try { lock = JSON.parse(await fs.readFile(lockPath, 'utf8')); } catch { lock = {}; }
    lock.plugins = lock.plugins ?? {};
    lock.plugins[packageName] = { enabled: false };
    await writeJson(lockPath, lock);
  }
  return path.join(packageDir, 'skills');
};

/**
 * Writes an installed Claude plugin under `~/.claude/plugins/cache/...` and
 * enables it in `~/.claude/settings.json`; matches ChatMux's Claude plugin
 * discovery contract that OMP mirrors for the `claude-plugins` tier.
 */
const installClaudePlugin = async (
  homeDir: string,
  pluginId: string,
  pluginName: string,
  options: { enabled?: boolean } = {},
): Promise<string> => {
  const [pluginBase] = pluginId.split('@');
  const cacheRoot = path.join(homeDir, '.claude', 'plugins', 'cache', pluginBase, pluginName, 'v1');
  await fs.mkdir(path.join(cacheRoot, '.claude-plugin'), { recursive: true });
  await writeJson(path.join(cacheRoot, '.claude-plugin', 'plugin.json'), {
    name: pluginName,
    version: '1.0.0',
  });

  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  let settings: { enabledPlugins?: Record<string, boolean> } = {};
  try { settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')); } catch { settings = {}; }
  settings.enabledPlugins = settings.enabledPlugins ?? {};
  settings.enabledPlugins[pluginId] = options.enabled ?? true;
  await writeJson(settingsPath, settings);

  const installedPath = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
  let installed: { plugins?: Record<string, Array<{ scope: string; installPath: string; version: string }>> } = {};
  try { installed = JSON.parse(await fs.readFile(installedPath, 'utf8')); } catch { installed = {}; }
  installed.plugins = installed.plugins ?? {};
  installed.plugins[pluginId] = [{ scope: 'user', installPath: cacheRoot, version: 'v1' }];
  await writeJson(installedPath, installed);

  return path.join(cacheRoot, 'skills');
};

// ---------------------------------------------------------------------------
// Tier: native (highest priority) - walk-up project + user + managed-writes
// ---------------------------------------------------------------------------
test('OMP native tier: cwd, parent, and repo-root .omp/skills plus ~/.omp/agent/skills', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('native-tier');
  const { homeDir, workspacePath } = sandbox;
  const nested = path.join(workspacePath, 'packages', 'app');
  await fs.mkdir(nested, { recursive: true });
  try {
    await writeSkill(path.join(nested, '.omp', 'skills'), 'cwd-dir', 'native-cwd');
    await writeSkill(path.join(workspacePath, 'packages', '.omp', 'skills'), 'parent-dir', 'native-parent');
    await writeSkill(path.join(workspacePath, '.omp', 'skills'), 'root-dir', 'native-root');
    await writeSkill(path.join(homeDir, '.omp', 'agent', 'skills'), 'user-dir', 'native-user');

    const skills = await listOmp(nested);
    const found = byName(skills);

    for (const name of ['native-cwd', 'native-parent', 'native-root']) {
      assert.equal(found.get(name)?.scope, 'project', `${name} scope`);
      assert.equal(found.get(name)?.command, `/skill:${name}`, `${name} command`);
    }
    assert.equal(found.get('native-user')?.scope, 'user');
    assert.equal(found.get('native-user')?.command, '/skill:native-user');
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Tier: extension/plugin (omp-plugins) - node_modules installs
// ---------------------------------------------------------------------------
test('OMP extension/plugin tier: ~/.omp/plugins/node_modules/<pkg>/skills surface as plugin scope', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('plugin-tier');
  try {
    const enabledSkills = await installOmpPlugin(sandbox.homeDir, 'omp-plugin-hyperplan');
    await writeSkill(enabledSkills, 'hyperplan-dir', 'plugin-hyperplan');

    const disabledSkills = await installOmpPlugin(sandbox.homeDir, 'omp-plugin-off', { disabled: true });
    await writeSkill(disabledSkills, 'off-dir', 'plugin-off');

    // A node_modules directory without an OMP manifest key must not leak.
    const notOmpDir = path.join(sandbox.homeDir, '.omp', 'plugins', 'node_modules', 'not-omp');
    await fs.mkdir(path.join(notOmpDir, 'skills', 'not-omp-dir'), { recursive: true });
    await writeJson(path.join(notOmpDir, 'package.json'), { name: 'not-omp', version: '1.0.0' });
    await fs.writeFile(
      path.join(notOmpDir, 'skills', 'not-omp-dir', 'SKILL.md'),
      '---\nname: plugin-not-omp\ndescription: no manifest\n---\n',
      'utf8',
    );

    // Scoped package layout `<root>/node_modules/@scope/name`.
    const scopedSkills = await installOmpPlugin(sandbox.homeDir, '@omp/scoped');
    await writeSkill(scopedSkills, 'scoped-dir', 'plugin-scoped');

    const skills = await listOmp(sandbox.workspacePath);
    const found = byName(skills);

    assert.equal(found.get('plugin-hyperplan')?.scope, 'plugin');
    assert.equal(found.get('plugin-hyperplan')?.command, '/skill:plugin-hyperplan');
    assert.equal(found.get('plugin-scoped')?.scope, 'plugin');
    assert.equal(found.get('plugin-off'), undefined, 'disabled plugin must be hidden');
    assert.equal(found.get('plugin-not-omp'), undefined, 'non-OMP package must not leak');
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Tier: claude compat (project walk-up + user)
// ---------------------------------------------------------------------------
test('OMP claude tier: walk-up .claude/skills project + ~/.claude/skills user', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('claude-tier');
  const nested = path.join(sandbox.workspacePath, 'packages', 'app');
  await fs.mkdir(nested, { recursive: true });
  try {
    await writeSkill(path.join(nested, '.claude', 'skills'), 'claude-cwd-dir', 'claude-cwd');
    await writeSkill(path.join(sandbox.workspacePath, '.claude', 'skills'), 'claude-root-dir', 'claude-root');
    await writeSkill(path.join(sandbox.homeDir, '.claude', 'skills'), 'claude-user-dir', 'claude-user');

    const skills = await listOmp(nested);
    const found = byName(skills);

    assert.equal(found.get('claude-cwd')?.scope, 'project');
    assert.equal(found.get('claude-root')?.scope, 'project');
    assert.equal(found.get('claude-user')?.scope, 'user');
    assert.equal(found.get('claude-cwd')?.command, '/skill:claude-cwd');
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Tier: claude-plugins compat (installed marketplace)
// ---------------------------------------------------------------------------
test('OMP claude-plugins tier: enabled Claude plugin skills surface, disabled hidden', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('claude-plugins-tier');
  try {
    const enabledSkills = await installClaudePlugin(
      sandbox.homeDir,
      'notion@notion-marketplace',
      'Notion',
    );
    await writeSkill(enabledSkills, 'notion-dir', 'notion-skill');

    const disabledSkills = await installClaudePlugin(
      sandbox.homeDir,
      'off@off-marketplace',
      'Off',
      { enabled: false },
    );
    await writeSkill(disabledSkills, 'off-dir', 'off-plugin-skill');

    const skills = await listOmp(sandbox.workspacePath);
    const found = byName(skills);

    assert.equal(found.get('notion-skill')?.scope, 'plugin');
    assert.equal(found.get('notion-skill')?.command, '/skill:notion-skill');
    assert.equal(found.get('off-plugin-skill'), undefined, 'disabled Claude plugin must be hidden');
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Tier: agents (.agent + .agents, walk-up + user)
// ---------------------------------------------------------------------------
test('OMP agents tier: walk-up .agent/.agents project + user', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('agents-tier');
  const nested = path.join(sandbox.workspacePath, 'packages', 'app');
  await fs.mkdir(nested, { recursive: true });
  try {
    await writeSkill(path.join(nested, '.agent', 'skills'), 'a1-dir', 'agent-cwd');
    await writeSkill(path.join(nested, '.agents', 'skills'), 'a2-dir', 'agents-cwd');
    await writeSkill(path.join(sandbox.workspacePath, '.agents', 'skills'), 'ar-dir', 'agents-root');
    await writeSkill(path.join(sandbox.homeDir, '.agent', 'skills'), 'au1-dir', 'agent-user');
    await writeSkill(path.join(sandbox.homeDir, '.agents', 'skills'), 'au2-dir', 'agents-user');

    const skills = await listOmp(nested);
    const found = byName(skills);

    assert.equal(found.get('agent-cwd')?.scope, 'project');
    assert.equal(found.get('agents-cwd')?.scope, 'project');
    assert.equal(found.get('agents-root')?.scope, 'project');
    assert.equal(found.get('agent-user')?.scope, 'user');
    assert.equal(found.get('agents-user')?.scope, 'user');
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Tier: codex + opencode + github compat
// ---------------------------------------------------------------------------
test('OMP codex/opencode/github compat tiers surface with truthful scopes and /skill: prefix', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('third-party-tiers');
  try {
    await writeSkill(path.join(sandbox.workspacePath, '.codex', 'skills'), 'cx-p-dir', 'codex-project');
    await writeSkill(path.join(sandbox.homeDir, '.codex', 'skills'), 'cx-u-dir', 'codex-user');
    await writeSkill(path.join(sandbox.workspacePath, '.opencode', 'skills'), 'oc-p-dir', 'opencode-project');
    await writeSkill(path.join(sandbox.homeDir, '.config', 'opencode', 'skills'), 'oc-u-dir', 'opencode-user');
    await writeSkill(path.join(sandbox.workspacePath, '.github', 'skills'), 'gh-dir', 'github-project');

    const skills = await listOmp(sandbox.workspacePath);
    const found = byName(skills);

    for (const [name, scope] of [
      ['codex-project', 'project'],
      ['codex-user', 'user'],
      ['opencode-project', 'project'],
      ['opencode-user', 'user'],
      ['github-project', 'project'],
    ] as const) {
      const skill = found.get(name);
      assert.ok(skill, `${name} must be listed`);
      assert.equal(skill.scope, scope, `${name} scope`);
      assert.equal(skill.command, `/skill:${name}`, `${name} command`);
    }
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Tier: managed (~/.omp/agent/managed-skills)
// ---------------------------------------------------------------------------
test('OMP managed tier: ~/.omp/agent/managed-skills is visible as a user-scope /skill: entry', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('managed-tier');
  try {
    await writeSkill(
      path.join(sandbox.homeDir, '.omp', 'agent', 'managed-skills'),
      'auto-dir',
      'auto-managed',
    );

    const skills = await listOmp(sandbox.workspacePath);
    const managed = skills.find((skill) => skill.name === 'auto-managed');

    assert.ok(managed, 'managed-skills SKILL.md must surface');
    assert.equal(managed.scope, 'user');
    assert.equal(managed.command, '/skill:auto-managed');
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Precedence: single name repeated at every tier resolves in documented order
// ---------------------------------------------------------------------------
test('OMP precedence: native > extension/plugin > claude > claude-plugin/agents/codex > opencode > github > managed', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('precedence');
  try {
    const name = 'dup';

    // Place the same name at every tier so first-name wins can be observed.
    await writeSkill(path.join(sandbox.workspacePath, '.omp', 'skills'), 'n-dir', name, 'native project');
    const pluginSkills = await installOmpPlugin(sandbox.homeDir, 'omp-plugin-dup');
    await writeSkill(pluginSkills, 'p-dir', name, 'extension/plugin');
    await writeSkill(path.join(sandbox.workspacePath, '.claude', 'skills'), 'c-dir', name, 'claude project');
    const claudePluginSkills = await installClaudePlugin(sandbox.homeDir, 'dup@dup-market', 'Dup');
    await writeSkill(claudePluginSkills, 'cp-dir', name, 'claude plugin');
    await writeSkill(path.join(sandbox.workspacePath, '.agents', 'skills'), 'a-dir', name, 'agents project');
    await writeSkill(path.join(sandbox.workspacePath, '.codex', 'skills'), 'cx-dir', name, 'codex project');
    await writeSkill(path.join(sandbox.workspacePath, '.opencode', 'skills'), 'oc-dir', name, 'opencode project');
    await writeSkill(path.join(sandbox.workspacePath, '.github', 'skills'), 'gh-dir', name, 'github project');
    await writeSkill(path.join(sandbox.homeDir, '.omp', 'agent', 'managed-skills'), 'm-dir', name, 'managed');

    // Native wins.
    let winners = (await listOmp(sandbox.workspacePath)).filter((skill) => skill.name === name);
    assert.equal(winners.length, 1, 'name collision must dedupe to a single entry');
    assert.equal(winners[0]?.scope, 'project', 'native project must win over every lower tier');
    assert.match(
      winners[0]?.sourcePath ?? '',
      /[\\/]\.omp[\\/]skills[\\/]/,
      'winner must be the native source path',
    );

    // Remove native: extension/plugin now wins.
    await fs.rm(path.join(sandbox.workspacePath, '.omp', 'skills'), { recursive: true, force: true });
    winners = (await listOmp(sandbox.workspacePath)).filter((skill) => skill.name === name);
    assert.equal(winners[0]?.scope, 'plugin', 'extension/plugin must win over claude+lower');

    // Remove extension/plugin: claude project now wins.
    await fs.rm(pluginSkills, { recursive: true, force: true });
    winners = (await listOmp(sandbox.workspacePath)).filter((skill) => skill.name === name);
    assert.equal(winners[0]?.scope, 'project');
    assert.match(winners[0]?.sourcePath ?? '', /[\\/]\.claude[\\/]skills[\\/]/);

    // Remove claude project: claude-plugin/agents/codex tier now wins (any of them).
    await fs.rm(path.join(sandbox.workspacePath, '.claude'), { recursive: true, force: true });
    winners = (await listOmp(sandbox.workspacePath)).filter((skill) => skill.name === name);
    assert.equal(winners.length, 1);
    assert.ok(
      /[\\/]plugins[\\/]cache[\\/]/.test(winners[0]?.sourcePath ?? '')
        || /[\\/]\.agents?[\\/]skills[\\/]/.test(winners[0]?.sourcePath ?? '')
        || /[\\/]\.codex[\\/]skills[\\/]/.test(winners[0]?.sourcePath ?? ''),
      'claude-plugin, agents, or codex must win before opencode/github/managed',
    );

    // Remove those: opencode now wins.
    await fs.rm(path.join(sandbox.homeDir, '.claude'), { recursive: true, force: true });
    await fs.rm(path.join(sandbox.workspacePath, '.agents'), { recursive: true, force: true });
    await fs.rm(path.join(sandbox.workspacePath, '.codex'), { recursive: true, force: true });
    winners = (await listOmp(sandbox.workspacePath)).filter((skill) => skill.name === name);
    assert.match(winners[0]?.sourcePath ?? '', /[\\/]\.opencode[\\/]skills[\\/]/);

    // Remove opencode: github now wins.
    await fs.rm(path.join(sandbox.workspacePath, '.opencode'), { recursive: true, force: true });
    winners = (await listOmp(sandbox.workspacePath)).filter((skill) => skill.name === name);
    assert.match(winners[0]?.sourcePath ?? '', /[\\/]\.github[\\/]skills[\\/]/);

    // Remove github: managed (dead last) wins.
    await fs.rm(path.join(sandbox.workspacePath, '.github'), { recursive: true, force: true });
    winners = (await listOmp(sandbox.workspacePath)).filter((skill) => skill.name === name);
    assert.match(winners[0]?.sourcePath ?? '', /[\\/]managed-skills[\\/]/);
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Toggles: settings.json gates each documented source; kill switch works
// ---------------------------------------------------------------------------
test('OMP toggles: settings.json disables documented sources and the master kill switch', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('toggles');
  try {
    await writeSkill(path.join(sandbox.homeDir, '.claude', 'skills'), 'u-dir', 'claude-user-toggled');
    await writeSkill(path.join(sandbox.workspacePath, '.claude', 'skills'), 'p-dir', 'claude-project-toggled');
    await writeSkill(path.join(sandbox.homeDir, '.codex', 'skills'), 'cx-dir', 'codex-user-toggled');
    await writeSkill(path.join(sandbox.homeDir, '.omp', 'agent', 'skills'), 'omp-u', 'native-user-kept');

    await writeJson(path.join(sandbox.homeDir, '.omp', 'agent', 'settings.json'), {
      skills: {
        enableClaudeUser: false,
        enableClaudeProject: false,
        enableCodexUser: false,
      },
    });

    let names = new Set((await listOmp(sandbox.workspacePath)).map((skill) => skill.name));
    assert.equal(names.has('claude-user-toggled'), false, 'enableClaudeUser=false must hide user Claude');
    assert.equal(names.has('claude-project-toggled'), false, 'enableClaudeProject=false must hide project Claude');
    assert.equal(names.has('codex-user-toggled'), false, 'enableCodexUser=false must hide user Codex');
    assert.equal(names.has('native-user-kept'), true, 'unrelated tiers must remain visible');

    // Master kill switch collapses everything to zero.
    await writeJson(path.join(sandbox.homeDir, '.omp', 'agent', 'settings.json'), {
      skills: { enabled: false },
    });
    names = new Set((await listOmp(sandbox.workspacePath)).map((skill) => skill.name));
    assert.equal(names.size, 0, 'skills.enabled=false must disable every source');
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Custom directories: settings.json entries win over defaults
// ---------------------------------------------------------------------------
test('OMP custom directories are listed as /skill: entries and win over default-path skills', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('custom-dirs');
  try {
    const customDir = path.join(sandbox.homeDir, 'my-custom-skills');
    await writeSkill(customDir, 'custom-dir', 'custom-only');
    await writeSkill(customDir, 'overridden-dir', 'overridden');

    // A default-path claude skill with the same name should lose to the custom directory.
    await writeSkill(path.join(sandbox.homeDir, '.claude', 'skills'), 'default-dir', 'overridden', 'default claude entry');

    await writeJson(path.join(sandbox.homeDir, '.omp', 'agent', 'settings.json'), {
      skills: { customDirectories: [customDir] },
    });

    const skills = await listOmp(sandbox.workspacePath);
    const found = byName(skills);

    const customOnly = found.get('custom-only');
    assert.ok(customOnly, 'custom-only must surface');
    assert.equal(customOnly.command, '/skill:custom-only');
    assert.equal(customOnly.scope, 'user');
    assert.equal(path.dirname(path.dirname(customOnly.sourcePath)), path.resolve(customDir));

    const overridden = found.get('overridden');
    assert.ok(overridden, 'overridden must resolve to the custom directory');
    assert.equal(path.dirname(path.dirname(overridden.sourcePath)), path.resolve(customDir));
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Symlink/duplicate handling: same real dir referenced twice yields one entry
// ---------------------------------------------------------------------------
test('OMP dedupes symlinked/duplicate skill roots by real path', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('symlinks');
  try {
    // Real skill lives in the user home; a project-level `.omp` is a symlink to it.
    const userOmpDir = path.join(sandbox.homeDir, '.omp', 'agent', 'skills');
    await writeSkill(userOmpDir, 'shared-dir', 'shared');
    await fs.mkdir(path.join(sandbox.workspacePath, '.omp'), { recursive: true });
    await fs.symlink(userOmpDir, path.join(sandbox.workspacePath, '.omp', 'skills'));

    const skills = await listOmp(sandbox.workspacePath);
    const matches = skills.filter((skill) => skill.name === 'shared');
    assert.equal(matches.length, 1, 'symlinked duplicates must dedupe to one entry');
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// 500-skill cap
// ---------------------------------------------------------------------------
test('OMP caps its returned skills at 500', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('cap');
  try {
    const root = path.join(sandbox.homeDir, '.omp', 'agent', 'skills');
    await fs.mkdir(root, { recursive: true });
    await Promise.all(
      Array.from({ length: 505 }, (_, index) =>
        writeSkill(root, `dir-${String(index).padStart(4, '0')}`, `skill-${String(index).padStart(4, '0')}`),
      ),
    );

    const skills = await listOmp(sandbox.workspacePath);
    assert.equal(skills.length, 500, 'OMP must enforce a 500-entry cap');
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Malformed sources: bad YAML, missing dirs, unreadable files don't hide siblings
// ---------------------------------------------------------------------------
test('OMP tolerates malformed and missing sources without leaking or hiding valid siblings', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('malformed');
  try {
    const projectSkills = path.join(sandbox.workspacePath, '.omp', 'skills');
    const badDir = path.join(projectSkills, 'malformed-dir');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(
      path.join(badDir, 'SKILL.md'),
      '---\nname: [unterminated: flow\n---\n\nBody.\n',
      'utf8',
    );
    await writeSkill(projectSkills, 'good-dir', 'good-sibling');

    // A settings.json that is not valid JSON must not crash the provider.
    await fs.mkdir(path.join(sandbox.homeDir, '.omp', 'agent'), { recursive: true });
    await fs.writeFile(
      path.join(sandbox.homeDir, '.omp', 'agent', 'settings.json'),
      '{ this is not : json',
      'utf8',
    );

    // An omp plugin package with malformed manifest must be skipped, not thrown.
    const badPluginDir = path.join(sandbox.homeDir, '.omp', 'plugins', 'node_modules', 'bad-plugin');
    await fs.mkdir(badPluginDir, { recursive: true });
    await fs.writeFile(path.join(badPluginDir, 'package.json'), '{ not json', 'utf8');

    const skills = await listOmp(sandbox.workspacePath);
    const names = new Set(skills.map((skill) => skill.name));
    assert.equal(names.has('good-sibling'), true);
    assert.equal(names.size >= 1, true);
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Managed add/list/remove round trip
// ---------------------------------------------------------------------------
test('OMP managed add/list/remove round trip lives at ~/.omp/agent/skills', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('managed-round-trip');
  try {
    const created = await providerSkillsService.addProviderSkills('omp', {
      entries: [
        {
          directoryName: 'managed-dir',
          content: '---\nname: managed\ndescription: managed omp skill\n---\n\nBody.\n',
        },
      ],
    });
    assert.equal(created.length, 1);
    assert.equal(created[0]?.command, '/skill:managed');
    assert.equal(created[0]?.scope, 'user');
    assert.equal(
      created[0]?.sourcePath,
      path.join(sandbox.homeDir, '.omp', 'agent', 'skills', 'managed-dir', 'SKILL.md'),
    );

    const listed = await listOmp(sandbox.workspacePath);
    assert.equal(
      listed.some((skill) => skill.name === 'managed' && skill.scope === 'user'),
      true,
      'managed skill must be visible on list',
    );

    const removed = await providerSkillsService.removeProviderSkill('omp', {
      directoryName: 'managed-dir',
    });
    assert.equal(removed.removed, true);

    const after = await listOmp(sandbox.workspacePath);
    assert.equal(after.some((skill) => skill.name === 'managed'), false);
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Truthful paths + /skill: prefix + foreign roots never leak
// ---------------------------------------------------------------------------
test('OMP returns truthful sourcePaths, /skill: commands, and refuses foreign roots', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('truthful');
  try {
    await writeSkill(path.join(sandbox.workspacePath, '.omp', 'skills'), 'p-dir', 'p-skill');
    await writeSkill(path.join(sandbox.homeDir, '.omp', 'agent', 'skills'), 'u-dir', 'u-skill');

    // Foreign roots that OMP does not document must never leak.
    await writeSkill(path.join(sandbox.workspacePath, '.cursor', 'skills'), 'x-dir', 'foreign-cursor');
    await writeSkill(path.join(sandbox.homeDir, '.gjc', 'skills'), 'y-dir', 'foreign-gjc');

    const skills = await listOmp(sandbox.workspacePath);
    for (const skill of skills) {
      assert.equal(skill.provider, 'omp');
      assert.match(skill.command, /^\/skill:/, `${skill.name} command must use /skill: prefix`);
      assert.equal(path.isAbsolute(skill.sourcePath), true);
      assert.equal(path.basename(skill.sourcePath), 'SKILL.md');
      await fs.stat(skill.sourcePath); // throws if fabricated
    }

    const names = new Set(skills.map((skill) => skill.name));
    assert.equal(names.has('foreign-cursor'), false, '.cursor is a foreign root');
    assert.equal(names.has('foreign-gjc'), false, '.gjc is a foreign root');
    assert.equal(names.has('p-skill'), true);
    assert.equal(names.has('u-skill'), true);
  } finally {
    await sandbox.restore();
  }
});
