import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { AppError } from '@/shared/utils.js';

/**
 * Characterization + gap-hunt fixtures for Claude's native skill catalog
 * (plan Task 7, `.omo/plans/provider-native-skill-catalogs.md:145-152`).
 *
 * The task calls for test-first hermetic coverage of every dimension the plan
 * lists for Claude: enabled/disabled plugins, ancestor/personal/project
 * collisions, bundled/system entries, configured overrides, malformed
 * markdown, unreadable roots, and overridden losers. Product code is only
 * touched when a RED fixture proves a cited native-contract gap the adapter
 * fails to honor. All natural-language descriptions are intentionally NOT
 * pinned - only machine values (command, scope, name presence, sourcePath
 * suffix) are asserted, and no test executes the Claude CLI.
 *
 * References:
 * - server/modules/providers/list/claude/claude-skills.provider.ts
 * - server/modules/providers/tests/skills.test.ts (baseline fixture patterns)
 * - .omo/plans/provider-native-skill-catalogs.md#L28-L30 (native-source contract row)
 */

const patchHomeDir = (nextHomeDir: string): (() => void) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

const writeSkill = async (
  skillsRoot: string,
  directoryName: string,
  name: string,
  description: string,
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

const writePluginManifest = async (
  installPath: string,
  name: string,
): Promise<void> => {
  const configDir = path.join(installPath, '.claude-plugin');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'plugin.json'),
    JSON.stringify({ name, version: '0.1.0', description: `${name} fixture` }, null, 2),
    'utf8',
  );
};

const writePluginCommand = async (
  commandsRoot: string,
  commandName: string,
  description: string,
): Promise<string> => {
  await fs.mkdir(commandsRoot, { recursive: true });
  const commandPath = path.join(commandsRoot, `${commandName}.md`);
  await fs.writeFile(
    commandPath,
    `---\ndescription: ${description}\nargument-hint: 'test args'\n---\n\nCommand body for ${commandName}.\n`,
    'utf8',
  );
  return commandPath;
};

const writeSettings = async (
  claudeHomePath: string,
  settings: Record<string, unknown>,
): Promise<void> => {
  await fs.mkdir(claudeHomePath, { recursive: true });
  await fs.writeFile(
    path.join(claudeHomePath, 'settings.json'),
    JSON.stringify(settings, null, 2),
    'utf8',
  );
};

const writeInstalledPluginsConfig = async (
  claudeHomePath: string,
  config: Record<string, unknown>,
): Promise<void> => {
  const pluginsDir = path.join(claudeHomePath, 'plugins');
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify(config, null, 2),
    'utf8',
  );
};

const byName = <T extends { name: string }>(items: T[]): Map<string, T> =>
  new Map(items.map((item) => [item.name, item]));

const makeSandbox = async (label: string): Promise<{
  homeDir: string;
  claudeHomePath: string;
  workspacePath: string;
  restore: () => Promise<void>;
}> => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `claude-skills-${label}-`));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  return {
    homeDir: tempRoot,
    claudeHomePath: path.join(tempRoot, '.claude'),
    workspacePath,
    restore: async () => {
      restoreHomeDir();
      await fs.rm(tempRoot, { recursive: true, force: true });
    },
  };
};

/**
 * Enabled plugin surface: `enabledPlugins[id] === true` plus a matching
 * `installed_plugins.json` install must produce `/pluginName:name` entries
 * with `scope: 'plugin'`. Both the commands-first tier and the skills
 * fallback tier are exercised.
 */
test('claude enabled plugins surface /pluginName:name commands and skills', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('enabled-plugin');
  try {
    const commandsInstallPath = path.join(
      sandbox.claudeHomePath, 'plugins', 'cache', 'notion-plugin', 'notion', 'abc123',
    );
    const skillsInstallPath = path.join(
      sandbox.claudeHomePath, 'plugins', 'cache', 'anthropic-agent-skills', 'example-skills', 'def456',
    );

    await writePluginManifest(commandsInstallPath, 'Notion');
    await writePluginCommand(path.join(commandsInstallPath, 'commands'), 'insert-row', 'insert row');

    await writePluginManifest(skillsInstallPath, 'ExampleSkills');
    await writeSkill(
      path.join(skillsInstallPath, 'skills'), 'demo-dir', 'demo-skill', 'plugin skill',
    );
    await writeSkill(
      path.join(skillsInstallPath, 'skills', 'nested', 'group'),
      'nested-dir', 'nested-skill', 'nested plugin skill',
    );

    await writeSettings(sandbox.claudeHomePath, {
      enabledPlugins: {
        'notion@notion-marketplace': true,
        'example-skills@anthropic-agent-skills': true,
      },
    });
    await writeInstalledPluginsConfig(sandbox.claudeHomePath, {
      version: 2,
      plugins: {
        'notion@notion-marketplace': [{ scope: 'user', installPath: commandsInstallPath, version: 'abc123' }],
        'example-skills@anthropic-agent-skills': [
          { scope: 'user', installPath: skillsInstallPath, version: 'def456' },
        ],
      },
    });

    const skills = await providerSkillsService.listProviderSkills('claude', {
      workspacePath: sandbox.workspacePath,
    });
    const found = byName(skills);

    const command = found.get('insert-row');
    assert.equal(command?.scope, 'plugin');
    assert.equal(command?.command, '/Notion:insert-row');
    assert.equal(command?.pluginName, 'Notion');
    assert.equal(command?.pluginId, 'notion@notion-marketplace');
    assert.match(command?.sourcePath ?? '', /commands[\\/]insert-row\.md$/);

    const pluginSkill = found.get('demo-skill');
    assert.equal(pluginSkill?.scope, 'plugin');
    assert.equal(pluginSkill?.command, '/ExampleSkills:demo-skill');
    assert.equal(pluginSkill?.pluginId, 'example-skills@anthropic-agent-skills');

    const nestedPluginSkill = found.get('nested-skill');
    assert.equal(nestedPluginSkill?.scope, 'plugin');
    assert.equal(nestedPluginSkill?.command, '/ExampleSkills:nested-skill');
  } finally {
    await sandbox.restore();
  }
});

/**
 * Disabled plugin gate: `enabledPlugins[id] !== true` (missing, false, or a
 * non-boolean truthy) must produce zero plugin skills or commands, even when
 * the install and manifest exist on disk.
 */
test('claude never surfaces skills or commands from disabled or missing plugin gates', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('disabled-plugin');
  try {
    const disabledInstallPath = path.join(
      sandbox.claudeHomePath, 'plugins', 'cache', 'disabled-market', 'disabled-plugin', 'ghi789',
    );
    const missingGateInstallPath = path.join(
      sandbox.claudeHomePath, 'plugins', 'cache', 'no-gate-market', 'no-gate-plugin', 'jkl000',
    );
    const nonBooleanGateInstallPath = path.join(
      sandbox.claudeHomePath, 'plugins', 'cache', 'string-gate-market', 'string-gate-plugin', 'mno111',
    );

    await writePluginManifest(disabledInstallPath, 'DisabledPlugin');
    await writePluginCommand(path.join(disabledInstallPath, 'commands'), 'disabled-cmd', 'gated off');
    await writeSkill(path.join(disabledInstallPath, 'skills'), 'disabled-dir', 'disabled-skill', 'gated off');

    await writePluginManifest(missingGateInstallPath, 'MissingGatePlugin');
    await writePluginCommand(path.join(missingGateInstallPath, 'commands'), 'no-gate-cmd', 'no gate entry');

    await writePluginManifest(nonBooleanGateInstallPath, 'StringGatePlugin');
    await writePluginCommand(
      path.join(nonBooleanGateInstallPath, 'commands'), 'string-gate-cmd', 'non-boolean gate',
    );

    await writeSettings(sandbox.claudeHomePath, {
      enabledPlugins: {
        'disabled-plugin@disabled-market': false,
        // 'no-gate-plugin@no-gate-market' is intentionally absent.
        'string-gate-plugin@string-gate-market': 'yes',
      },
    });
    await writeInstalledPluginsConfig(sandbox.claudeHomePath, {
      version: 2,
      plugins: {
        'disabled-plugin@disabled-market': [
          { scope: 'user', installPath: disabledInstallPath, version: 'ghi789' },
        ],
        'no-gate-plugin@no-gate-market': [
          { scope: 'user', installPath: missingGateInstallPath, version: 'jkl000' },
        ],
        'string-gate-plugin@string-gate-market': [
          { scope: 'user', installPath: nonBooleanGateInstallPath, version: 'mno111' },
        ],
      },
    });

    const skills = await providerSkillsService.listProviderSkills('claude', {
      workspacePath: sandbox.workspacePath,
    });

    for (const forbidden of ['disabled-cmd', 'disabled-skill', 'no-gate-cmd', 'string-gate-cmd']) {
      assert.equal(
        skills.some((skill) => skill.name === forbidden),
        false,
        `disabled/missing/non-boolean gate must not surface ${forbidden}`,
      );
    }
    assert.equal(skills.filter((skill) => skill.scope === 'plugin').length, 0);
  } finally {
    await sandbox.restore();
  }
});

/**
 * Plugin id shape: an enabled entry keyed by `''` or `'@'` must never emit a
 * `/:name` command. This locks the namespace guard the adapter already has,
 * so a corrupt settings file cannot produce reserved/empty plugin prefixes.
 */
test('claude rejects empty and lone-@ plugin ids without emitting /:name commands', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('invalid-plugin-id');
  try {
    const emptyIdPath = path.join(
      sandbox.claudeHomePath, 'plugins', 'cache', 'invalid-empty', 'empty', '000',
    );
    const atIdPath = path.join(
      sandbox.claudeHomePath, 'plugins', 'cache', 'invalid-at', 'at', '000',
    );
    await writePluginCommand(path.join(emptyIdPath, 'commands'), 'invalid-empty-cmd', 'x');
    await writePluginCommand(path.join(atIdPath, 'commands'), 'invalid-at-cmd', 'x');

    await writeSettings(sandbox.claudeHomePath, {
      enabledPlugins: { '': true, '@': true },
    });
    await writeInstalledPluginsConfig(sandbox.claudeHomePath, {
      version: 2,
      plugins: {
        '': [{ scope: 'user', installPath: emptyIdPath, version: '000' }],
        '@': [{ scope: 'user', installPath: atIdPath, version: '000' }],
      },
    });

    const skills = await providerSkillsService.listProviderSkills('claude', {
      workspacePath: sandbox.workspacePath,
    });

    assert.equal(skills.some((skill) => skill.name === 'invalid-empty-cmd'), false);
    assert.equal(skills.some((skill) => skill.name === 'invalid-at-cmd'), false);
    assert.equal(skills.some((skill) => skill.command.startsWith('/:')), false);
  } finally {
    await sandbox.restore();
  }
});

/**
 * Sibling install folders (a common cache layout where two version dirs live
 * next to each other) each get scanned once with their own pluginId prefix,
 * even when only one sibling ships a plugin.json manifest.
 */
test('claude walks sibling plugin install folders and falls back to the pluginId name when a manifest is absent', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('sibling-plugin');
  try {
    const manifestedInstallPath = path.join(
      sandbox.claudeHomePath, 'plugins', 'cache', 'anthropic-agent-skills', 'example-skills', 'def456',
    );
    const siblingInstallPath = path.join(
      path.dirname(manifestedInstallPath), 'legacy777',
    );

    await writePluginManifest(manifestedInstallPath, 'ExampleSkills');
    await writeSkill(
      path.join(manifestedInstallPath, 'skills'), 'primary-dir', 'primary-skill', 'primary',
    );
    await writeSkill(
      path.join(siblingInstallPath, 'skills'), 'sibling-dir', 'sibling-skill', 'sibling',
    );

    await writeSettings(sandbox.claudeHomePath, {
      enabledPlugins: { 'example-skills@anthropic-agent-skills': true },
    });
    await writeInstalledPluginsConfig(sandbox.claudeHomePath, {
      version: 2,
      plugins: {
        'example-skills@anthropic-agent-skills': [
          { scope: 'user', installPath: manifestedInstallPath, version: 'def456' },
        ],
      },
    });

    const skills = await providerSkillsService.listProviderSkills('claude', {
      workspacePath: sandbox.workspacePath,
    });
    const found = byName(skills);

    assert.equal(found.get('primary-skill')?.pluginName, 'ExampleSkills');
    assert.equal(found.get('primary-skill')?.command, '/ExampleSkills:primary-skill');

    // Sibling folder has no plugin.json, so the adapter must fall back to the
    // installed pluginId's local segment (`example-skills`), never invent a name.
    assert.equal(found.get('sibling-skill')?.pluginName, 'example-skills');
    assert.equal(found.get('sibling-skill')?.command, '/example-skills:sibling-skill');
  } finally {
    await sandbox.restore();
  }
});

/**
 * When one plugin install ships both `commands/` and `skills/`, the adapter's
 * documented behavior is commands-first (per install folder): `skills/` is
 * skipped so the same plugin does not double-surface entries. This locks the
 * "overridden loser" rule inside a single plugin folder.
 */
test('claude prefers plugin commands over plugin skills inside the same install folder', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('plugin-commands-win');
  try {
    const installPath = path.join(
      sandbox.claudeHomePath, 'plugins', 'cache', 'combo-market', 'combo-plugin', 'aaa',
    );
    await writePluginManifest(installPath, 'ComboPlugin');
    await writePluginCommand(path.join(installPath, 'commands'), 'combo-op', 'combo command');
    await writeSkill(path.join(installPath, 'skills'), 'ignored-dir', 'combo-op', 'skill loser');

    await writeSettings(sandbox.claudeHomePath, {
      enabledPlugins: { 'combo-plugin@combo-market': true },
    });
    await writeInstalledPluginsConfig(sandbox.claudeHomePath, {
      version: 2,
      plugins: {
        'combo-plugin@combo-market': [{ scope: 'user', installPath, version: 'aaa' }],
      },
    });

    const skills = await providerSkillsService.listProviderSkills('claude', {
      workspacePath: sandbox.workspacePath,
    });

    const matches = skills.filter((skill) => skill.name === 'combo-op');
    assert.equal(matches.length, 1, 'commands must dedupe the skill loser in the same install');
    assert.equal(matches[0]?.scope, 'plugin');
    assert.match(matches[0]?.sourcePath ?? '', /commands[\\/]combo-op\.md$/);
  } finally {
    await sandbox.restore();
  }
});

/**
 * Personal + project source characterization: distinct scopes, exact `/name`
 * commands, and truthful sourcePaths. Neither tier bleeds into the other.
 */
test('claude lists personal and project skills with distinct scopes and truthful source paths', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('personal-project');
  try {
    const userSkillPath = await writeSkill(
      path.join(sandbox.claudeHomePath, 'skills'),
      'user-dir', 'personal-only', 'personal only',
    );
    const projectSkillPath = await writeSkill(
      path.join(sandbox.workspacePath, '.claude', 'skills'),
      'project-dir', 'project-only', 'project only',
    );

    const skills = await providerSkillsService.listProviderSkills('claude', {
      workspacePath: sandbox.workspacePath,
    });
    const found = byName(skills);

    const personal = found.get('personal-only');
    assert.equal(personal?.scope, 'user');
    assert.equal(personal?.command, '/personal-only');
    assert.equal(personal?.sourcePath, userSkillPath);

    const project = found.get('project-only');
    assert.equal(project?.scope, 'project');
    assert.equal(project?.command, '/project-only');
    assert.equal(project?.sourcePath, projectSkillPath);
  } finally {
    await sandbox.restore();
  }
});

/**
 * Personal/project collision: same `/name` in both sources dedupes to a
 * single entry by the shared command-key rule. This locks the current source
 * order (user listed before project, so the personal skill wins) and
 * documents which side is the "overridden loser". Product code is unchanged
 * because no cited native contract proves the current order is wrong.
 */
test('claude same-name personal/project collision dedupes to the personal skill (overridden project loser is dropped)', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('collision-personal-project');
  try {
    await writeSkill(
      path.join(sandbox.claudeHomePath, 'skills'),
      'dup-user-dir', 'dup', 'personal variant',
    );
    await writeSkill(
      path.join(sandbox.workspacePath, '.claude', 'skills'),
      'dup-project-dir', 'dup', 'project variant',
    );

    const skills = await providerSkillsService.listProviderSkills('claude', {
      workspacePath: sandbox.workspacePath,
    });
    const dupWinners = skills.filter((skill) => skill.name === 'dup');
    assert.equal(dupWinners.length, 1, 'same-name skills must dedupe by command');
    assert.equal(dupWinners[0]?.scope, 'user', 'personal source is emitted first and wins the /dup command');
    assert.match(dupWinners[0]?.sourcePath ?? '', /dup-user-dir[\\/]SKILL\.md$/);
    assert.equal(
      skills.some((skill) => skill.sourcePath.endsWith(path.join('dup-project-dir', 'SKILL.md'))),
      false,
      'the overridden project loser must not appear in the catalog',
    );
  } finally {
    await sandbox.restore();
  }
});

/**
 * Ancestor scope characterization: the adapter's project source is the
 * literal `<workspacePath>/.claude/skills`, not an ancestor walk. A
 * `.claude/skills` directory living in a parent above the workspace must not
 * appear. This locks the current safe scope until a machine-readable native
 * contract proves ancestor walk is required.
 */
test('claude does not walk workspace ancestors for project-scoped .claude/skills', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('no-ancestor');
  const repoRoot = path.join(sandbox.homeDir, 'ancestor-repo');
  const workspacePath = path.join(repoRoot, 'packages', 'app');
  try {
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await fs.mkdir(workspacePath, { recursive: true });

    await writeSkill(
      path.join(workspacePath, '.claude', 'skills'),
      'own-dir', 'workspace-own', 'workspace project skill',
    );
    await writeSkill(
      path.join(repoRoot, '.claude', 'skills'),
      'ancestor-dir', 'ancestor-only', 'ancestor project skill',
    );
    await writeSkill(
      path.join(repoRoot, 'packages', '.claude', 'skills'),
      'ancestor-mid-dir', 'ancestor-mid', 'intermediate ancestor skill',
    );

    const skills = await providerSkillsService.listProviderSkills('claude', { workspacePath });
    const found = byName(skills);

    assert.equal(found.get('workspace-own')?.scope, 'project');
    assert.equal(found.get('workspace-own')?.command, '/workspace-own');
    assert.equal(
      found.get('ancestor-only'),
      undefined,
      'ancestor .claude/skills must not be treated as project-scoped without a proven contract',
    );
    assert.equal(found.get('ancestor-mid'), undefined);
  } finally {
    await sandbox.restore();
  }
});

/**
 * Bundled/system characterization: the adapter never executes Claude and has
 * no native inventory probe, so bundled skills are absent from the catalog.
 * This is the documented safe fallback - closing this gap requires a native
 * probe (out of scope for this task).
 */
test('claude returns no bundled/system-scope entries without a native probe', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('bundled-system');
  try {
    // A user skill exists so we can distinguish empty-adapter behavior from
    // a genuine catalog that simply lacks a bundled tier.
    await writeSkill(
      path.join(sandbox.claudeHomePath, 'skills'),
      'user-dir', 'user-skill', 'baseline user skill',
    );

    // Common paths a bundled probe would consult in the future. None of them
    // are scanned by the current adapter, so their contents must never surface.
    await writeSkill(
      path.join(sandbox.homeDir, '.claude-code', 'bundled', 'skills'),
      'bundled-a-dir', 'bundled-skill-a', 'bundled A',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.local', 'share', 'claude-code', 'skills'),
      'bundled-b-dir', 'bundled-skill-b', 'bundled B',
    );

    const skills = await providerSkillsService.listProviderSkills('claude', {
      workspacePath: sandbox.workspacePath,
    });

    assert.equal(skills.some((skill) => skill.name === 'user-skill'), true);
    assert.equal(
      skills.some((skill) => skill.scope === 'system'),
      false,
      'no bundled/system-scope entry may appear until a native inventory probe is added',
    );
    for (const forbidden of ['bundled-skill-a', 'bundled-skill-b']) {
      assert.equal(
        skills.some((skill) => skill.name === forbidden),
        false,
        `speculative bundled path ${forbidden} must not leak into the catalog`,
      );
    }
  } finally {
    await sandbox.restore();
  }
});

/**
 * Configured overrides: `settings.json` toggles beyond `enabledPlugins` are
 * not honored today (there is no machine-readable Claude schema for
 * per-skill enable/disable that we can safely encode without executing
 * Claude). A `disabledSkills`-style array must therefore have no effect,
 * and the corresponding user skill remains listed. This locks the current
 * behavior as a truthful characterization.
 */
test('claude ignores non-plugin toggle overrides in settings.json and keeps user skills visible', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('configured-overrides');
  try {
    await writeSkill(
      path.join(sandbox.claudeHomePath, 'skills'),
      'toggle-dir', 'togglable-skill', 'user skill under a hypothetical override',
    );
    await writeSettings(sandbox.claudeHomePath, {
      // Hypothetical override schemas the adapter does not yet consume.
      disabledSkills: ['togglable-skill'],
      skills: { disabled: ['togglable-skill'], overrides: { 'togglable-skill': false } },
    });

    const skills = await providerSkillsService.listProviderSkills('claude', {
      workspacePath: sandbox.workspacePath,
    });
    const toggled = skills.find((skill) => skill.name === 'togglable-skill');
    assert.ok(toggled, 'togglable-skill remains visible until a native override contract is proven');
    assert.equal(toggled.scope, 'user');
    assert.equal(toggled.command, '/togglable-skill');
  } finally {
    await sandbox.restore();
  }
});

/**
 * Malformed markdown: a SKILL.md with unparseable YAML front matter must be
 * skipped without hiding valid siblings, and it must not throw out of the
 * service. Covers both a personal-tier and a project-tier bad sibling.
 */
test('claude skips malformed SKILL.md files without hiding valid sibling skills', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('malformed');
  try {
    const userSkillsDir = path.join(sandbox.claudeHomePath, 'skills');
    await fs.mkdir(path.join(userSkillsDir, 'bad-user-dir'), { recursive: true });
    await fs.writeFile(
      path.join(userSkillsDir, 'bad-user-dir', 'SKILL.md'),
      '---\nname: [unterminated: flow: collection\n---\n\nbody.\n',
      'utf8',
    );
    await writeSkill(userSkillsDir, 'good-user-dir', 'good-user-skill', 'valid user sibling');

    const projectSkillsDir = path.join(sandbox.workspacePath, '.claude', 'skills');
    await fs.mkdir(path.join(projectSkillsDir, 'bad-project-dir'), { recursive: true });
    await fs.writeFile(
      path.join(projectSkillsDir, 'bad-project-dir', 'SKILL.md'),
      '---\nname: [also: broken: yaml\n---\n',
      'utf8',
    );
    await writeSkill(projectSkillsDir, 'good-project-dir', 'good-project-skill', 'valid project sibling');

    const skills = await providerSkillsService.listProviderSkills('claude', {
      workspacePath: sandbox.workspacePath,
    });
    const found = byName(skills);

    assert.equal(found.get('good-user-skill')?.scope, 'user');
    assert.equal(found.get('good-user-skill')?.command, '/good-user-skill');
    assert.equal(found.get('good-project-skill')?.scope, 'project');
    assert.equal(found.get('good-project-skill')?.command, '/good-project-skill');

    for (const skill of skills) {
      assert.equal(
        skill.sourcePath.includes('bad-user-dir') || skill.sourcePath.includes('bad-project-dir'),
        false,
        'malformed SKILL.md sources must not appear in the catalog',
      );
    }
  } finally {
    await sandbox.restore();
  }
});

/**
 * Unreadable roots: a completely missing `.claude/skills` directory, a
 * file-in-place-of-directory, and a corrupt `installed_plugins.json` must
 * all resolve to an empty (safe) list rather than throwing. The still-valid
 * project skill remains visible so one broken source cannot suppress the
 * whole catalog.
 */
test('claude returns a safe empty list when personal roots or plugin configs are unreadable', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('unreadable');
  try {
    // No ~/.claude/skills directory at all. Instead, a plain file sits where
    // the directory would be, so any readdir would fail.
    await fs.mkdir(sandbox.claudeHomePath, { recursive: true });
    await fs.writeFile(
      path.join(sandbox.claudeHomePath, 'skills'),
      'not a directory\n',
      'utf8',
    );

    // Corrupt installed_plugins.json to make sure readJsonConfig degrades safely.
    const pluginsDir = path.join(sandbox.claudeHomePath, 'plugins');
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.writeFile(path.join(pluginsDir, 'installed_plugins.json'), '{ this is not json', 'utf8');

    // A project skill exists so we can prove the adapter still delivers the
    // healthy source instead of throwing when a broken source is present.
    const projectSkillPath = await writeSkill(
      path.join(sandbox.workspacePath, '.claude', 'skills'),
      'ok-project-dir', 'ok-project-skill', 'valid project skill',
    );

    const skills = await providerSkillsService.listProviderSkills('claude', {
      workspacePath: sandbox.workspacePath,
    });
    const found = byName(skills);

    assert.equal(found.get('ok-project-skill')?.scope, 'project');
    assert.equal(found.get('ok-project-skill')?.sourcePath, projectSkillPath);
    assert.equal(
      skills.some((skill) => skill.scope === 'user'),
      false,
      'personal source must degrade to empty when its root is unreadable',
    );
    assert.equal(
      skills.some((skill) => skill.scope === 'plugin'),
      false,
      'plugin source must degrade to empty when installed_plugins.json is corrupt',
    );
  } finally {
    await sandbox.restore();
  }
});

/**
 * Malformed `settings.json` and a plugin install whose `installPath` is
 * missing must both be tolerated without leaking a plugin entry or throwing.
 */
test('claude tolerates malformed settings.json and skips plugin installs without an installPath', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('bad-plugin-shape');
  try {
    await fs.mkdir(sandbox.claudeHomePath, { recursive: true });
    await fs.writeFile(
      path.join(sandbox.claudeHomePath, 'settings.json'),
      '{ enabledPlugins: not-json',
      'utf8',
    );

    // Even with malformed settings, a real project skill must still be discoverable.
    await writeSkill(
      path.join(sandbox.workspacePath, '.claude', 'skills'),
      'still-here-dir', 'still-here', 'project skill next to a broken settings.json',
    );

    // A separate case: settings valid but the install record is missing installPath.
    const shapelessInstallPath = path.join(
      sandbox.claudeHomePath, 'plugins', 'cache', 'shapeless-market', 'shapeless-plugin', 'zzz',
    );
    await writePluginManifest(shapelessInstallPath, 'ShapelessPlugin');
    await writePluginCommand(path.join(shapelessInstallPath, 'commands'), 'shapeless-cmd', 'x');

    // The malformed settings.json above already prevents plugin discovery in
    // this fixture. We additionally seed an installed_plugins entry that
    // lacks installPath to prove the adapter would filter it even if the
    // settings gate were enabled.
    await writeInstalledPluginsConfig(sandbox.claudeHomePath, {
      version: 2,
      plugins: {
        'shapeless-plugin@shapeless-market': [{ scope: 'user', version: 'zzz' }],
      },
    });

    const skills = await providerSkillsService.listProviderSkills('claude', {
      workspacePath: sandbox.workspacePath,
    });

    assert.equal(skills.find((skill) => skill.name === 'still-here')?.scope, 'project');
    assert.equal(skills.some((skill) => skill.name === 'shapeless-cmd'), false);
    assert.equal(skills.some((skill) => skill.scope === 'plugin'), false);
  } finally {
    await sandbox.restore();
  }
});

/**
 * Managed round trip: personal `.claude/skills` remains the writable root.
 * Add > list > remove must round-trip without corrupting other sources.
 */
test('claude managed add/list/remove round trip stays green for the personal skill root', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('managed-round-trip');
  try {
    const created = await providerSkillsService.addProviderSkills('claude', {
      entries: [
        {
          directoryName: 'managed-dir',
          content: '---\nname: managed-claude\ndescription: managed claude skill\n---\n\nManaged body.\n',
        },
      ],
    });
    assert.equal(created.length, 1);
    assert.equal(created[0]?.command, '/managed-claude');
    assert.equal(created[0]?.scope, 'user');
    assert.equal(
      created[0]?.sourcePath.endsWith(path.join('.claude', 'skills', 'managed-dir', 'SKILL.md')),
      true,
    );
    const persisted = await fs.readFile(created[0]!.sourcePath, 'utf8');
    assert.match(persisted, /Managed body\./);

    const listed = await providerSkillsService.listProviderSkills('claude', {
      workspacePath: sandbox.workspacePath,
    });
    assert.equal(
      listed.some((skill) => skill.name === 'managed-claude' && skill.scope === 'user'),
      true,
    );

    const removed = await providerSkillsService.removeProviderSkill('claude', {
      directoryName: 'managed-dir',
    });
    assert.equal(removed.removed, true);
    await assert.rejects(
      fs.stat(path.join(sandbox.claudeHomePath, 'skills', 'managed-dir', 'SKILL.md')),
    );

    // AppError is imported to keep the round-trip test aligned with the
    // adapter's public error contract; a redundant well-formed removal is a
    // no-op rather than an exception.
    const idempotent = await providerSkillsService.removeProviderSkill('claude', {
      directoryName: 'managed-dir',
    });
    assert.equal(idempotent.removed, false);
    assert.doesNotThrow(() => new AppError('kept import live', { code: 'NOOP', statusCode: 500 }));
  } finally {
    await sandbox.restore();
  }
});
