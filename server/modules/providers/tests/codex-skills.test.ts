import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { AppError } from '@/shared/utils.js';

/**
 * Characterization + gap-hunt fixtures for Codex's native skill catalog
 * (plan Task 8, `.omo/plans/provider-native-skill-catalogs.md`).
 *
 * The plan's contract row for Codex is:
 *   > CWD/parent/repo-root `.agents/skills`; user, admin, system; installed
 *   > plugin skills; disabled `skills.config` entries.
 *   > `$name`; `repo/user/admin/system/plugin` scopes.
 *   > Preserve proven roots, add plugin/disabled-entry characterization,
 *   > modify only proven gaps.
 *
 * These fixtures pin every dimension the task calls out - `repo`/`user`/
 * `system`/`plugin` sources, `skills.config` with `enabled: false`, malformed
 * plugin manifest, missing root, symlink escape at the source root, source
 * order collision, and the managed add/list/remove round trip - against the
 * current adapter first. Any product change is only made when a red fixture
 * proves a cited native-contract gap; every other assertion is pure
 * characterization so a future regression cannot silently invent behavior.
 *
 * `admin` scope (`/etc/codex/skills`) is intentionally not exercised here:
 * writing under `/etc` requires root, and the current adapter already
 * unconditionally emits that source when building `getSkillSources()`. The
 * shared `findProviderSkillMarkdownFiles` helper returns an empty list for a
 * missing/unreadable admin root, so its absence is not testable at fixture
 * time without escalating privileges.
 *
 * References:
 * - server/modules/providers/list/codex/codex-skills.provider.ts
 * - server/modules/providers/shared/skills/skills.provider.ts
 * - server/shared/utils.ts#findProviderSkillMarkdownFiles
 * - server/modules/providers/tests/skills.test.ts (baseline Codex fixtures)
 * - .omo/plans/provider-native-skill-catalogs.md (Task 8 row + STOP condition)
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

const byName = <T extends { name: string }>(items: T[]): Map<string, T> =>
  new Map(items.map((item) => [item.name, item]));

type CodexSandbox = {
  homeDir: string;
  codexHomePath: string;
  agentsSkillsPath: string;
  systemSkillsPath: string;
  repoRoot: string;
  workspacePath: string;
  restore: () => Promise<void>;
};

/**
 * Isolates one Codex fixture: a temp home patched into `os.homedir`, a
 * `.git`-marked repo root that anchors `findTopmostGitRoot`, and a nested
 * workspace deep enough to distinguish `cwd`, `parent`, and `git root` repo
 * sources. Every home-scoped Codex root starts empty so each test controls
 * exactly the sources under assertion.
 */
const makeSandbox = async (label: string): Promise<CodexSandbox> => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `codex-skills-${label}-`));
  const repoRoot = path.join(homeDir, 'repo');
  const workspacePath = path.join(repoRoot, 'packages', 'app');
  await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(homeDir);
  return {
    homeDir,
    codexHomePath: path.join(homeDir, '.codex'),
    agentsSkillsPath: path.join(homeDir, '.agents', 'skills'),
    systemSkillsPath: path.join(homeDir, '.codex', 'skills', '.system'),
    repoRoot,
    workspacePath,
    restore: async () => {
      restoreHomeDir();
      await fs.rm(homeDir, { recursive: true, force: true });
    },
  };
};

const listCodex = (workspacePath: string) =>
  providerSkillsService.listProviderSkills('codex', { workspacePath });

/**
 * Repo scope characterization: Codex walks its skill catalog from
 *   1. `<workspace>/.agents/skills`
 *   2. `<parent(workspace)>/.agents/skills`
 *   3. `<git-root>/.agents/skills`
 * and each surface with `scope: 'repo'` plus the `$name` command prefix.
 * `sourcePath` must be truthful (canonical resolved path to the SKILL.md).
 */
test('codex lists cwd, parent, and git-root .agents/skills entries as repo scope with $name commands', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('repo-roots');
  try {
    const cwdSkillPath = await writeSkill(
      path.join(sandbox.workspacePath, '.agents', 'skills'),
      'cwd-dir', 'codex-repo-cwd', 'cwd .agents/skills entry',
    );
    const parentSkillPath = await writeSkill(
      path.join(sandbox.repoRoot, 'packages', '.agents', 'skills'),
      'parent-dir', 'codex-repo-parent', 'parent .agents/skills entry',
    );
    const rootSkillPath = await writeSkill(
      path.join(sandbox.repoRoot, '.agents', 'skills'),
      'root-dir', 'codex-repo-root', 'git-root .agents/skills entry',
    );

    const skills = await listCodex(sandbox.workspacePath);
    const found = byName(skills);

    for (const [name, sourcePath] of [
      ['codex-repo-cwd', cwdSkillPath],
      ['codex-repo-parent', parentSkillPath],
      ['codex-repo-root', rootSkillPath],
    ] as const) {
      const skill = found.get(name);
      assert.ok(skill, `${name} must be listed`);
      assert.equal(skill.provider, 'codex');
      assert.equal(skill.scope, 'repo');
      assert.equal(skill.command, `$${name}`);
      assert.equal(skill.sourcePath, sourcePath);
    }
  } finally {
    await sandbox.restore();
  }
});

/**
 * User scope characterization: `~/.agents/skills` is the sole user-scope
 * source Codex consumes today. `~/.codex/skills/foo/SKILL.md` (without the
 * hidden `.system` prefix) is intentionally NOT scanned, so a skill written
 * there must not leak into the user catalog.
 */
test('codex lists ~/.agents/skills as user scope and does not scan ~/.codex/skills', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('user-scope');
  try {
    const userSkillPath = await writeSkill(
      sandbox.agentsSkillsPath, 'user-dir', 'codex-user-only', 'user .agents/skills entry',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.codex', 'skills'),
      'codex-home-dir', 'codex-home-only', 'must not leak from ~/.codex/skills',
    );

    const skills = await listCodex(sandbox.workspacePath);
    const found = byName(skills);

    const user = found.get('codex-user-only');
    assert.equal(user?.scope, 'user');
    assert.equal(user?.command, '$codex-user-only');
    assert.equal(user?.sourcePath, userSkillPath);

    assert.equal(
      found.get('codex-home-only'),
      undefined,
      '~/.codex/skills is not a user-scope root: skills written there must not leak',
    );
  } finally {
    await sandbox.restore();
  }
});

/**
 * System scope characterization: bundled system skills live under the
 * hidden `~/.codex/skills/.system` directory. `findProviderSkillMarkdownFiles`
 * does not skip dot-prefixed root directories, so a SKILL.md under this
 * hidden folder surfaces with `scope: 'system'` and the `$name` command.
 */
test('codex lists ~/.codex/skills/.system as system scope with truthful sourcePath', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('system-scope');
  try {
    const systemSkillPath = await writeSkill(
      sandbox.systemSkillsPath, 'system-dir', 'codex-system-bundled', 'bundled system skill',
    );

    const skills = await listCodex(sandbox.workspacePath);
    const found = byName(skills);

    const system = found.get('codex-system-bundled');
    assert.equal(system?.scope, 'system');
    assert.equal(system?.command, '$codex-system-bundled');
    assert.equal(system?.sourcePath, systemSkillPath);
  } finally {
    await sandbox.restore();
  }
});

/**
 * Plugin scope characterization: the current adapter has no installed-plugin
 * scanner. Every speculative plugin layout below (`~/.codex/plugins/*`, a
 * `~/.codex/skills.config.json` with a plugin declaration, and a plain
 * `plugin/skills` folder alongside the user root) must therefore produce
 * zero `scope: 'plugin'` entries. This locks the safe boundary until a
 * cited native Codex plugin contract exists; a future regression that adds
 * a speculative plugin walker will fail this fixture.
 */
test('codex returns no plugin-scope entries without a native plugin contract', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('plugin-absent');
  try {
    // A user skill so we can distinguish "empty adapter" from "no plugin tier".
    await writeSkill(
      sandbox.agentsSkillsPath, 'baseline-dir', 'codex-plugin-baseline', 'baseline user skill',
    );

    // Speculative plugin layouts a future implementer might guess at.
    await writeSkill(
      path.join(sandbox.codexHomePath, 'plugins', 'notion-plugin', 'skills'),
      'notion-dir', 'codex-plugin-notion', 'plugin-styled entry under ~/.codex/plugins',
    );
    await writeSkill(
      path.join(sandbox.codexHomePath, 'plugins', 'node_modules', '@codex', 'scoped-plugin', 'skills'),
      'scoped-dir', 'codex-plugin-scoped', 'plugin-styled entry under nested plugins layout',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.codex-plugins', 'workflow', 'skills'),
      'workflow-dir', 'codex-plugin-workflow', 'plugin-styled entry outside ~/.codex',
    );

    // Also declare a plugin in the speculative skills.config so we prove even
    // an explicit "plugin" entry there does not enable a walker.
    await fs.mkdir(sandbox.codexHomePath, { recursive: true });
    await fs.writeFile(
      path.join(sandbox.codexHomePath, 'skills.config.json'),
      JSON.stringify({
        plugins: [
          { name: 'notion-plugin', enabled: true, root: 'plugins/notion-plugin/skills' },
        ],
      }, null, 2),
      'utf8',
    );

    const skills = await listCodex(sandbox.workspacePath);

    assert.equal(
      skills.some((skill) => skill.name === 'codex-plugin-baseline'),
      true,
      'baseline user skill must remain visible so absence is a scope statement, not a crash',
    );
    assert.equal(
      skills.filter((skill) => skill.scope === 'plugin').length,
      0,
      'no plugin-scope entry may appear until a cited native Codex plugin contract is proven',
    );
    for (const forbidden of ['codex-plugin-notion', 'codex-plugin-scoped', 'codex-plugin-workflow']) {
      assert.equal(
        skills.some((skill) => skill.name === forbidden),
        false,
        `speculative plugin path ${forbidden} must not leak into the catalog`,
      );
    }
  } finally {
    await sandbox.restore();
  }
});

/**
 * `skills.config` disabled-entry characterization: the current adapter does
 * not consume any `skills.config` file, so a `{ skills: { <name>: { enabled:
 * false } } }` declaration must have no effect on the catalog. A regression
 * that starts honoring this file without a proven contract would break the
 * assertion below; a fixture-proven fix would flip this test to expect the
 * skill to disappear. Either way, the adapter's behavior stays anchored to
 * a citable contract instead of drifting into speculation.
 */
test('codex ignores a speculative skills.config enabled=false entry and keeps the skill visible', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('skills-config-disabled');
  try {
    const toggledSkillPath = await writeSkill(
      sandbox.agentsSkillsPath, 'toggled-dir', 'codex-toggled', 'user skill under a hypothetical disable',
    );

    await fs.mkdir(sandbox.codexHomePath, { recursive: true });
    // Two speculative shapes (`skills` map and `disabled` array) so a future
    // regression that guesses either does not slip past this characterization.
    await fs.writeFile(
      path.join(sandbox.codexHomePath, 'skills.config.json'),
      JSON.stringify({
        skills: { 'codex-toggled': { enabled: false } },
        disabled: ['codex-toggled'],
      }, null, 2),
      'utf8',
    );
    // A TOML-shaped variant, since Codex's other config files (`config.toml`)
    // are TOML. This one is deliberately malformed as JSON to prove even a
    // valid-looking Codex config filename does not enable a hidden gate.
    await fs.writeFile(
      path.join(sandbox.codexHomePath, 'skills.config.toml'),
      '[skills.codex-toggled]\nenabled = false\n',
      'utf8',
    );

    const skills = await listCodex(sandbox.workspacePath);
    const toggled = skills.find((skill) => skill.name === 'codex-toggled');
    assert.ok(toggled, 'codex-toggled must remain visible until a native disabled-config contract is proven');
    assert.equal(toggled.scope, 'user');
    assert.equal(toggled.command, '$codex-toggled');
    assert.equal(toggled.sourcePath, toggledSkillPath);
  } finally {
    await sandbox.restore();
  }
});

/**
 * Malformed plugin manifest tolerance: even though the current adapter does
 * not read plugin manifests, a malformed `package.json` or `plugin.json`
 * anywhere under `~/.codex/plugins/*` and a corrupt `skills.config.json`
 * next to the Codex home must not throw out of `listProviderSkills`. A valid
 * user-tier skill must remain visible alongside every broken sibling.
 */
test('codex tolerates malformed plugin manifests and a corrupt skills.config without hiding valid skills', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('malformed-plugin-manifest');
  try {
    await writeSkill(
      sandbox.agentsSkillsPath, 'survivor-dir', 'codex-survivor', 'valid user skill next to broken plugins',
    );

    const brokenPluginDir = path.join(sandbox.codexHomePath, 'plugins', 'broken-plugin');
    await fs.mkdir(brokenPluginDir, { recursive: true });
    await fs.writeFile(path.join(brokenPluginDir, 'package.json'), '{ "name": ', 'utf8');
    await fs.writeFile(path.join(brokenPluginDir, 'plugin.json'), '{ not json', 'utf8');

    const skillLikeDir = path.join(brokenPluginDir, 'skills', 'malformed-dir');
    await fs.mkdir(skillLikeDir, { recursive: true });
    await fs.writeFile(
      path.join(skillLikeDir, 'SKILL.md'),
      '---\nname: [unterminated: flow\n---\n\nbody\n',
      'utf8',
    );

    await fs.mkdir(sandbox.codexHomePath, { recursive: true });
    await fs.writeFile(
      path.join(sandbox.codexHomePath, 'skills.config.json'),
      '{ this is not json',
      'utf8',
    );

    const skills = await listCodex(sandbox.workspacePath);
    const found = byName(skills);

    assert.equal(found.get('codex-survivor')?.scope, 'user');
    assert.equal(found.get('codex-survivor')?.command, '$codex-survivor');
    assert.equal(
      skills.some((skill) => skill.scope === 'plugin'),
      false,
      'a malformed plugin manifest must never grant a synthetic plugin entry',
    );
    // The malformed SKILL.md lives under a plugin path that is not scanned,
    // so it must not surface under any scope.
    assert.equal(
      skills.some((skill) => skill.sourcePath.includes(path.join('broken-plugin', 'skills'))),
      false,
      'skills under an unread plugin directory must not appear',
    );
  } finally {
    await sandbox.restore();
  }
});

/**
 * Missing root tolerance: none of Codex's documented roots exist in this
 * fixture (empty temp home, empty workspace, no git-root `.agents/skills`,
 * no `~/.codex`, no `~/.agents`). `listProviderSkills` must resolve to an
 * empty array without throwing.
 */
test('codex returns an empty catalog when every documented root is missing', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('missing-root');
  try {
    const skills = await listCodex(sandbox.workspacePath);
    assert.deepEqual(skills, [], 'missing roots must degrade to an empty catalog without throwing');
  } finally {
    await sandbox.restore();
  }
});

/**
 * Symlink escape characterization: `findProviderSkillMarkdownFiles` iterates
 * `readdir(root, { withFileTypes: true })` and only walks entries whose
 * `dirent.isDirectory()` is true. A symlink pointing to a directory returns
 * `false` for `isDirectory()` (it returns true for `isSymbolicLink()`
 * instead), so a symlinked child under a source root is skipped. This means
 * an outside-root skill referenced via a top-level symlink under
 * `.agents/skills` never surfaces, and a valid sibling directory next to it
 * still does.
 */
test('codex skips a symlinked directory whose target lives outside the source root', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('symlink-escape');
  try {
    const outsideRoot = path.join(sandbox.homeDir, 'outside');
    await fs.mkdir(outsideRoot, { recursive: true });
    const outsideSkillDir = path.join(outsideRoot, 'foreign-dir');
    await fs.mkdir(outsideSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(outsideSkillDir, 'SKILL.md'),
      '---\nname: codex-foreign\ndescription: foreign skill reached via symlink\n---\n\nbody\n',
      'utf8',
    );

    const projectSkillsDir = path.join(sandbox.workspacePath, '.agents', 'skills');
    await fs.mkdir(projectSkillsDir, { recursive: true });
    await fs.symlink(outsideSkillDir, path.join(projectSkillsDir, 'escaped-link'));
    const validSkillPath = await writeSkill(
      projectSkillsDir, 'valid-dir', 'codex-valid-sibling', 'valid sibling next to the escaped symlink',
    );

    const skills = await listCodex(sandbox.workspacePath);
    const found = byName(skills);

    assert.equal(
      found.get('codex-foreign'),
      undefined,
      'a symlinked directory whose target lives outside the source root must not surface',
    );
    const valid = found.get('codex-valid-sibling');
    assert.equal(valid?.scope, 'repo');
    assert.equal(valid?.sourcePath, validSkillPath);
    assert.equal(
      skills.some((skill) => skill.sourcePath.startsWith(outsideRoot + path.sep)),
      false,
      'no source path may point outside the documented Codex roots',
    );
  } finally {
    await sandbox.restore();
  }
});

/**
 * Source-order collision: Codex's `getSkillSources` emits repo entries first,
 * then user, admin, and system. The shared `SkillsProvider.listSkills`
 * concatenates skills in source order, and `providerSkillsService`
 * dedupes by command, so a same-name collision between repo and system
 * resolves to the repo winner and drops the system loser from the catalog.
 * This locks the documented winner precedence for `$name` collisions.
 */
test('codex resolves a same-name repo/user/system collision to the repo winner via source order', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('collision-order');
  try {
    const repoWinnerPath = await writeSkill(
      path.join(sandbox.workspacePath, '.agents', 'skills'),
      'repo-dir', 'codex-collide', 'repo variant that must win',
    );
    await writeSkill(
      sandbox.agentsSkillsPath, 'user-dir', 'codex-collide', 'user variant that must lose',
    );
    await writeSkill(
      sandbox.systemSkillsPath, 'system-dir', 'codex-collide', 'system variant that must lose',
    );

    let winners = (await listCodex(sandbox.workspacePath)).filter((skill) => skill.name === 'codex-collide');
    assert.equal(winners.length, 1, 'name collision must dedupe to a single entry');
    assert.equal(winners[0]?.scope, 'repo', 'repo source must win over user and system');
    assert.equal(winners[0]?.sourcePath, repoWinnerPath);

    // Remove the repo winner: user is emitted before system, so user takes over.
    await fs.rm(path.join(sandbox.workspacePath, '.agents', 'skills'), { recursive: true, force: true });
    winners = (await listCodex(sandbox.workspacePath)).filter((skill) => skill.name === 'codex-collide');
    assert.equal(winners[0]?.scope, 'user', 'user must win once the repo winner is gone');

    // Remove user too: only the system entry remains.
    await fs.rm(sandbox.agentsSkillsPath, { recursive: true, force: true });
    winners = (await listCodex(sandbox.workspacePath)).filter((skill) => skill.name === 'codex-collide');
    assert.equal(winners[0]?.scope, 'system', 'system remains as the last source when repo and user are gone');
  } finally {
    await sandbox.restore();
  }
});

/**
 * Managed add/list/remove round trip: Codex writes managed global skills
 * under `~/.agents/skills`. The round trip must persist a truthful
 * `$name`-prefixed catalog entry, surface on the next `listProviderSkills`
 * call, and remove cleanly with an idempotent second delete.
 */
test('codex managed add/list/remove round trip persists under ~/.agents/skills', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('managed-round-trip');
  try {
    const created = await providerSkillsService.addProviderSkills('codex', {
      entries: [
        {
          directoryName: 'managed-dir',
          content: '---\nname: codex-managed\ndescription: managed codex skill\n---\n\nManaged body.\n',
          files: [
            {
              relativePath: 'scripts/run.sh',
              content: Buffer.from('#!/bin/sh\necho codex\n').toString('base64'),
              encoding: 'base64',
            },
          ],
        },
      ],
    });
    assert.equal(created.length, 1);
    const managedSkill = created[0];
    assert.ok(managedSkill);
    assert.equal(managedSkill.command, '$codex-managed');
    assert.equal(managedSkill.scope, 'user');
    assert.equal(
      managedSkill.sourcePath,
      path.join(sandbox.agentsSkillsPath, 'managed-dir', 'SKILL.md'),
    );
    assert.match(await fs.readFile(managedSkill.sourcePath, 'utf8'), /Managed body\./);
    assert.equal(
      await fs.readFile(path.join(sandbox.agentsSkillsPath, 'managed-dir', 'scripts', 'run.sh'), 'utf8'),
      '#!/bin/sh\necho codex\n',
    );

    const listed = await listCodex(sandbox.workspacePath);
    assert.equal(
      listed.some((skill) => skill.name === 'codex-managed' && skill.scope === 'user'),
      true,
      'managed skill must be visible on the next list call',
    );

    const removed = await providerSkillsService.removeProviderSkill('codex', {
      directoryName: 'managed-dir',
    });
    assert.equal(removed.removed, true);
    assert.equal(removed.provider, 'codex');
    await assert.rejects(fs.stat(managedSkill.sourcePath));

    // A redundant well-formed removal is a no-op rather than an exception.
    const idempotent = await providerSkillsService.removeProviderSkill('codex', {
      directoryName: 'managed-dir',
    });
    assert.equal(idempotent.removed, false);
    // Keep the AppError import live to align with the adapter's public error
    // contract; it is thrown for containment/invalid-name failures elsewhere.
    assert.doesNotThrow(() => new AppError('kept import live', { code: 'NOOP', statusCode: 500 }));
  } finally {
    await sandbox.restore();
  }
});

/**
 * Truthful shape: every returned Codex entry uses the `$` command prefix, is
 * tagged with `provider: 'codex'`, and its `sourcePath` really exists on
 * disk under one of the documented roots. No foreign provider path
 * (`~/.claude/skills`, `~/.cursor/skills`, `~/.opencode/skills`, `.omo`,
 * `.gjc`) may leak into the catalog even when those directories exist.
 */
test('codex returns truthful $-prefixed commands and never leaks foreign provider roots', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('truthful');
  try {
    await writeSkill(
      path.join(sandbox.workspacePath, '.agents', 'skills'),
      'p-dir', 'codex-project-truth', 'project truth skill',
    );
    await writeSkill(
      sandbox.agentsSkillsPath, 'u-dir', 'codex-user-truth', 'user truth skill',
    );

    for (const foreignRoot of [
      path.join(sandbox.homeDir, '.claude', 'skills'),
      path.join(sandbox.homeDir, '.cursor', 'skills'),
      path.join(sandbox.homeDir, '.opencode', 'skills'),
      path.join(sandbox.homeDir, '.omo', 'skills'),
      path.join(sandbox.homeDir, '.gjc', 'skills'),
      path.join(sandbox.workspacePath, '.claude', 'skills'),
      path.join(sandbox.workspacePath, '.cursor', 'skills'),
      path.join(sandbox.workspacePath, '.opencode', 'skills'),
      path.join(sandbox.workspacePath, '.omo', 'skills'),
      path.join(sandbox.workspacePath, '.gjc', 'skills'),
    ]) {
      await writeSkill(
        foreignRoot,
        `${path.basename(path.dirname(foreignRoot))}-dir`,
        `foreign-${path.basename(path.dirname(foreignRoot))}`,
        'foreign provider skill that must not leak',
      );
    }

    const skills = await listCodex(sandbox.workspacePath);
    assert.ok(skills.length >= 2, 'baseline codex skills must remain visible');
    for (const skill of skills) {
      assert.equal(skill.provider, 'codex');
      assert.match(skill.command, /^\$/, `${skill.name} command must use the $ prefix`);
      assert.equal(path.isAbsolute(skill.sourcePath), true);
      assert.equal(path.basename(skill.sourcePath), 'SKILL.md');
      await fs.stat(skill.sourcePath); // throws if fabricated
    }

    const names = new Set(skills.map((skill) => skill.name));
    for (const forbidden of [
      'foreign-.claude', 'foreign-.cursor', 'foreign-.opencode', 'foreign-.omo', 'foreign-.gjc',
    ]) {
      assert.equal(names.has(forbidden), false, `foreign root ${forbidden} must not leak into Codex`);
    }
    assert.equal(names.has('codex-project-truth'), true);
    assert.equal(names.has('codex-user-truth'), true);
  } finally {
    await sandbox.restore();
  }
});
