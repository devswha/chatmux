import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';

/**
 * OMO provider skill contract (plan Task 4).
 *
 * The installed `omo-ai` launcher runs its Senpi engine with the plugin package
 * injected through `--extension <packageRoot>/plugin`. Senpi's own resolver
 * loads skills from:
 *   - `<packageRoot>/plugin/skills` (declared via `pi.skills` in the plugin
 *     manifest) - the built-in bundle,
 *   - `<agentDir>/skills` and `<homedir>/.agents/skills` - user-global auto,
 *   - `<cwd>/.omo/skills` and every `.agents/skills` walking cwd -> git root -
 *     project-local auto (trusted projects),
 *   - explicit `settings.skills` pointer arrays in `~/.omo/agent/settings.json`
 *     and `<cwd>/.omo/settings.json` - the runtime skill-pointer contract.
 *
 * Everything else - `.codex/skills`, `.claude/skills`, and other coding agent
 * roots - is out of contract for OMO. The old provider borrowed those roots
 * unconditionally, so a Codex-only home leaked `~/.codex/skills` as
 * `/skill:foreign-codex`. That is the primary red case reproduced below.
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

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
};

type LauncherFixture = {
  binDir: string;
  packageRoot: string;
  pluginSkillsRoot: string;
};

/**
 * Builds an npm-style global omo-ai install: a `bin/omo` symlink pointing at
 * `bin/omo.js` inside the package, `bin/omo` declared in `package.json#bin`,
 * and a nested `plugin/package.json` whose `pi.skills` declares `./skills`.
 *
 * This matches the real installed layout we observed while planning task 4:
 *   /home/.../lib/node_modules/omo-ai/{bin,plugin}
 *   /home/.../bin/omo -> ../lib/node_modules/omo-ai/bin/omo.js
 */
const createOmoLauncher = async (
  installRoot: string,
  options: {
    manifest?: 'malformed' | Record<string, unknown>;
    pluginPiSkills?: unknown;
  } = {},
): Promise<LauncherFixture> => {
  const binDir = path.join(installRoot, 'bin');
  const packageRoot = path.join(installRoot, 'lib', 'node_modules', 'omo-ai');
  const launcherPath = path.join(packageRoot, 'bin', 'omo.js');
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(path.dirname(launcherPath), { recursive: true });
  await fs.writeFile(launcherPath, '#!/usr/bin/env node\n', 'utf8');
  await fs.chmod(launcherPath, 0o755);
  await fs.symlink(path.relative(binDir, launcherPath), path.join(binDir, 'omo'));

  const manifest = options.manifest ?? {
    name: 'omo-ai',
    version: '5.0.0-beta.test',
    bin: { omo: 'bin/omo.js' },
  };
  if (manifest === 'malformed') {
    await fs.writeFile(path.join(packageRoot, 'package.json'), '{ "name": ', 'utf8');
  } else {
    await writeJson(path.join(packageRoot, 'package.json'), manifest);
  }

  await writeJson(path.join(packageRoot, 'plugin', 'package.json'), {
    name: '@code-yeongyu/omo-senpi',
    version: '5.0.0-beta.test',
    pi: options.pluginPiSkills === undefined
      ? { skills: ['./skills'] }
      : { skills: options.pluginPiSkills },
  });

  const pluginSkillsRoot = path.join(packageRoot, 'plugin', 'skills');
  await fs.mkdir(pluginSkillsRoot, { recursive: true });
  return { binDir, packageRoot, pluginSkillsRoot };
};

type OmoSandbox = {
  homeDir: string;
  workspacePath: string;
  binDir: string | null;
  restore: () => Promise<void>;
};

/**
 * Isolates every OMO-relevant surface: a fresh homedir stubbed via `os.homedir`,
 * a workspace under it, and (optionally) an omo launcher whose `bin/` is
 * prepended to `PATH` so `resolveNativeSkillPackage` can attach the launcher to
 * the fixture package. Both `HOME` and `PATH` are restored on teardown so the
 * real installed omo-ai on this workstation never leaks into other tests.
 */
const createOmoSandbox = async (
  label: string,
  options: {
    launcher?: Parameters<typeof createOmoLauncher>[1];
    installLauncher?: boolean;
  } = {},
): Promise<OmoSandbox & { fixture: LauncherFixture | null }> => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `omo-skills-${label}-`));
  const workspacePath = path.join(homeDir, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(homeDir);
  const originalPath = process.env.PATH;
  let fixture: LauncherFixture | null = null;

  if (options.installLauncher !== false) {
    fixture = await createOmoLauncher(homeDir, options.launcher ?? {});
    process.env.PATH = `${fixture.binDir}${path.delimiter}${originalPath ?? ''}`;
  } else {
    // Explicitly empty PATH so the real installed omo binary cannot influence
    // the "missing launcher" branch. Node's own bootstrap already loaded, so
    // clearing PATH is safe for the remainder of the test.
    process.env.PATH = '';
  }

  return {
    homeDir,
    workspacePath,
    binDir: fixture?.binDir ?? null,
    fixture,
    restore: async () => {
      restoreHomeDir();
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await fs.rm(homeDir, { recursive: true, force: true });
    },
  };
};

test('OMO returns zero skills for a Codex-only home (reproduces the borrowed-catalog defect)', { concurrency: false }, async () => {
  const sandbox = await createOmoSandbox('codex-only', { installLauncher: false });
  try {
    await writeSkill(
      path.join(sandbox.homeDir, '.codex', 'skills'),
      'foreign-codex-dir',
      'foreign-codex',
      'must not leak through OMO',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.claude', 'skills'),
      'foreign-claude-dir',
      'foreign-claude',
      'must not leak through OMO',
    );

    const skills = await providerSkillsService.listProviderSkills('omo', {
      workspacePath: sandbox.workspacePath,
    });

    assert.deepEqual(skills, [], 'OMO must not borrow ~/.codex or ~/.claude skills');
  } finally {
    await sandbox.restore();
  }
});

test('OMO exposes manifest-declared plugin skills with truthful scope and source path', { concurrency: false }, async () => {
  const sandbox = await createOmoSandbox('plugin');
  try {
    assert.ok(sandbox.fixture, 'fixture launcher is required for this case');
    const bundledSkillPath = await writeSkill(
      sandbox.fixture.pluginSkillsRoot,
      'hyperplan',
      'hyperplan',
      'bundled plugin skill',
    );

    const skills = await providerSkillsService.listProviderSkills('omo', {
      workspacePath: sandbox.workspacePath,
    });
    const bundled = skills.find((skill) => skill.name === 'hyperplan');

    assert.ok(bundled, 'plugin/skills SKILL.md must surface through pi.skills');
    assert.equal(bundled.command, '/skill:hyperplan');
    assert.equal(bundled.scope, 'plugin');
    assert.equal(bundled.provider, 'omo');
    assert.equal(bundled.sourcePath, await fs.realpath(bundledSkillPath));
  } finally {
    await sandbox.restore();
  }
});

test('OMO exposes project and user auto-discovered roots with truthful scopes and /skill: commands', { concurrency: false }, async () => {
  const sandbox = await createOmoSandbox('auto-discovery');
  try {
    await writeSkill(
      path.join(sandbox.workspacePath, '.omo', 'skills'),
      'project-skill-dir',
      'project-skill',
      'project .omo/skills entry',
    );
    await writeSkill(
      path.join(sandbox.workspacePath, '.agents', 'skills'),
      'project-agents-dir',
      'project-agents',
      'project .agents/skills compat entry',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.omo', 'agent', 'skills'),
      'user-skill-dir',
      'user-skill',
      'user ~/.omo/agent/skills entry',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.agents', 'skills'),
      'user-agents-dir',
      'user-agents',
      'user ~/.agents/skills entry',
    );

    const skills = await providerSkillsService.listProviderSkills('omo', {
      workspacePath: sandbox.workspacePath,
    });
    const found = new Map(skills.map((skill) => [skill.name, skill]));

    for (const [name, scope] of [
      ['project-skill', 'project'],
      ['project-agents', 'project'],
      ['user-skill', 'user'],
      ['user-agents', 'user'],
    ] as const) {
      const skill = found.get(name);
      assert.ok(skill, `${name} must be listed`);
      assert.equal(skill.scope, scope);
      assert.equal(skill.command, `/skill:${name}`);
      assert.equal(skill.provider, 'omo');
    }
  } finally {
    await sandbox.restore();
  }
});

test('OMO walks ancestor .agents/skills up to the git root but stops there', { concurrency: false }, async () => {
  const sandbox = await createOmoSandbox('agents-walk', { installLauncher: false });
  try {
    const repoRoot = path.join(sandbox.homeDir, 'monorepo');
    const workspacePath = path.join(repoRoot, 'packages', 'app');
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await fs.mkdir(workspacePath, { recursive: true });

    await writeSkill(
      path.join(workspacePath, '.agents', 'skills'),
      'cwd-dir',
      'cwd-agents',
      'cwd .agents skill',
    );
    await writeSkill(
      path.join(repoRoot, '.agents', 'skills'),
      'root-dir',
      'root-agents',
      'repo root .agents skill',
    );
    // A directory ABOVE the git root: the walk must stop before reaching it.
    await writeSkill(
      path.join(sandbox.homeDir, '.agents', 'skills'),
      'user-dir',
      'user-agents-fixture',
      'user global .agents; still visible via user root',
    );
    await writeSkill(
      path.join(sandbox.homeDir, 'monorepo', '..', 'sibling', '.agents', 'skills'),
      'sibling-dir',
      'sibling-agents',
      'sibling .agents must not appear',
    );

    const skills = await providerSkillsService.listProviderSkills('omo', { workspacePath });
    const names = new Set(skills.map((skill) => skill.name));

    assert.equal(names.has('cwd-agents'), true);
    assert.equal(names.has('root-agents'), true);
    // The user-global .agents/skills is reached through the user-scope source,
    // not through the ancestor walk; assert the walk itself stops at the git root.
    assert.equal(names.has('sibling-agents'), false, 'ancestor walk must not cross into sibling trees');
  } finally {
    await sandbox.restore();
  }
});

test('OMO includes runtime pointer skills from settings.json but excludes hostile paths', { concurrency: false }, async () => {
  const sandbox = await createOmoSandbox('pointers');
  try {
    // Legitimate pointer inside the workspace's project tree.
    const projectPointerRoot = path.join(sandbox.workspacePath, 'internal', 'plans-skills');
    await writeSkill(projectPointerRoot, 'plan-pointer-dir', 'plan-pointer', 'runtime pointer skill');

    // Legitimate pointer inside the user's ~/.omo agent tree.
    const userPointerRoot = path.join(sandbox.homeDir, '.omo', 'agent', 'projected', 'skills');
    await writeSkill(userPointerRoot, 'proj-pointer-dir', 'proj-pointer', 'projected pointer skill');

    // Hostile pointer sitting completely outside every allowed root.
    const hostileRoot = path.join(sandbox.homeDir, 'outside', 'hostile-skills');
    await writeSkill(hostileRoot, 'hostile-dir', 'hostile-pointer', 'must not leak');

    await writeJson(path.join(sandbox.workspacePath, '.omo', 'settings.json'), {
      skills: [projectPointerRoot, path.join(sandbox.workspacePath, '..', 'hostile-skills')],
    });
    await writeJson(path.join(sandbox.homeDir, '.omo', 'agent', 'settings.json'), {
      skills: [userPointerRoot, hostileRoot],
    });

    const skills = await providerSkillsService.listProviderSkills('omo', {
      workspacePath: sandbox.workspacePath,
    });
    const names = new Set(skills.map((skill) => skill.name));

    assert.equal(names.has('plan-pointer'), true, 'workspace-contained pointer must surface');
    assert.equal(names.has('proj-pointer'), true, 'user-agent-contained pointer must surface');
    assert.equal(names.has('hostile-pointer'), false, 'pointers escaping allowed roots must be dropped');
  } finally {
    await sandbox.restore();
  }
});

test('OMO returns fs-only skills when the omo launcher is not on PATH', { concurrency: false }, async () => {
  const sandbox = await createOmoSandbox('missing-launcher', { installLauncher: false });
  try {
    await writeSkill(
      path.join(sandbox.homeDir, '.omo', 'agent', 'skills'),
      'still-visible-dir',
      'still-visible',
      'user global stays visible when the launcher is missing',
    );

    const skills = await providerSkillsService.listProviderSkills('omo', {
      workspacePath: sandbox.workspacePath,
    });

    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, 'still-visible');
    assert.equal(skills[0]?.scope, 'user');
    assert.equal(skills[0]?.command, '/skill:still-visible');
    // No fabricated bundled entry sneaks in.
    assert.equal(skills.some((skill) => skill.scope === 'plugin'), false);
  } finally {
    await sandbox.restore();
  }
});

test('OMO fails closed when the omo-ai manifest is malformed', { concurrency: false }, async () => {
  const sandbox = await createOmoSandbox('malformed-manifest', {
    launcher: { manifest: 'malformed' },
  });
  try {
    // Even a valid bundled SKILL.md must not surface if the manifest never
    // attributes the launcher to this package.
    await writeSkill(sandbox.fixture!.pluginSkillsRoot, 'hyperplan', 'hyperplan', 'never leaks');
    await writeSkill(
      path.join(sandbox.homeDir, '.omo', 'agent', 'skills'),
      'user-fallback-dir',
      'user-fallback',
      'user fallback still surfaces',
    );

    const skills = await providerSkillsService.listProviderSkills('omo', {
      workspacePath: sandbox.workspacePath,
    });

    assert.equal(skills.some((skill) => skill.scope === 'plugin'), false);
    assert.equal(
      skills.some((skill) => skill.name === 'user-fallback' && skill.scope === 'user'),
      true,
    );
  } finally {
    await sandbox.restore();
  }
});

test('OMO drops declared pi.skills roots that escape the resolved package root', { concurrency: false }, async () => {
  const sandbox = await createOmoSandbox('hostile-manifest', {
    launcher: { pluginPiSkills: ['../../../etc/skills', './skills'] },
  });
  try {
    await writeSkill(
      sandbox.fixture!.pluginSkillsRoot,
      'safe-dir',
      'safe-plugin',
      'stays inside the package root',
    );

    const skills = await providerSkillsService.listProviderSkills('omo', {
      workspacePath: sandbox.workspacePath,
    });
    const plugins = skills.filter((skill) => skill.scope === 'plugin');

    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]?.name, 'safe-plugin');
    assert.equal(plugins[0]?.command, '/skill:safe-plugin');
  } finally {
    await sandbox.restore();
  }
});

test('OMO honors truthful scopes when a name collides across plugin, user, and project sources', { concurrency: false }, async () => {
  const sandbox = await createOmoSandbox('scope-truth');
  try {
    await writeSkill(sandbox.fixture!.pluginSkillsRoot, 'dup-dir', 'dup', 'plugin variant');
    await writeSkill(
      path.join(sandbox.homeDir, '.omo', 'agent', 'skills'),
      'dup-dir',
      'dup',
      'user variant',
    );
    await writeSkill(
      path.join(sandbox.workspacePath, '.omo', 'skills'),
      'dup-dir',
      'dup',
      'project variant',
    );

    const skills = await providerSkillsService.listProviderSkills('omo', {
      workspacePath: sandbox.workspacePath,
    });
    const winners = skills.filter((skill) => skill.name === 'dup');

    assert.equal(winners.length, 1, 'same-name collision must dedupe by command');
    assert.equal(winners[0]?.provider, 'omo');
    assert.equal(winners[0]?.command, '/skill:dup');
    // Whichever tier wins, it must be a truthful OMO scope, never a foreign one.
    assert.ok(['plugin', 'project', 'user'].includes(winners[0]!.scope));
  } finally {
    await sandbox.restore();
  }
});

test('OMO add/list/remove round trip lives in the ~/.omo/agent/skills managed root', { concurrency: false }, async () => {
  const sandbox = await createOmoSandbox('managed-writes');
  try {
    const created = await providerSkillsService.addProviderSkills('omo', {
      entries: [
        {
          directoryName: 'managed-dir',
          content: '---\nname: managed\ndescription: managed omo skill\n---\n\nBody.\n',
        },
      ],
    });
    assert.equal(created.length, 1);
    assert.equal(created[0]?.command, '/skill:managed');
    assert.equal(created[0]?.scope, 'user');
    assert.equal(
      created[0]?.sourcePath,
      path.join(sandbox.homeDir, '.omo', 'agent', 'skills', 'managed-dir', 'SKILL.md'),
    );

    const listed = await providerSkillsService.listProviderSkills('omo', {
      workspacePath: sandbox.workspacePath,
    });
    assert.equal(
      listed.some((skill) => skill.name === 'managed' && skill.scope === 'user'),
      true,
      'managed skill must be visible on list',
    );

    const removed = await providerSkillsService.removeProviderSkill('omo', {
      directoryName: 'managed-dir',
    });
    assert.equal(removed.removed, true);

    const afterRemoval = await providerSkillsService.listProviderSkills('omo', {
      workspacePath: sandbox.workspacePath,
    });
    assert.equal(afterRemoval.some((skill) => skill.name === 'managed'), false);
  } finally {
    await sandbox.restore();
  }
});

test('OMO never fabricates a sourcePath: every returned entry points at a real SKILL.md', { concurrency: false }, async () => {
  const sandbox = await createOmoSandbox('truthful-paths');
  try {
    await writeSkill(sandbox.fixture!.pluginSkillsRoot, 'hyperplan', 'hyperplan', 'plugin bundle');
    await writeSkill(
      path.join(sandbox.workspacePath, '.omo', 'skills'),
      'project-dir',
      'project-truthful',
      'project entry',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.omo', 'agent', 'skills'),
      'user-dir',
      'user-truthful',
      'user entry',
    );

    const skills = await providerSkillsService.listProviderSkills('omo', {
      workspacePath: sandbox.workspacePath,
    });

    assert.ok(skills.length >= 3);
    for (const skill of skills) {
      assert.equal(typeof skill.sourcePath, 'string');
      assert.equal(path.isAbsolute(skill.sourcePath), true, 'sourcePath must be absolute');
      assert.equal(
        path.basename(skill.sourcePath),
        'SKILL.md',
        `sourcePath ${skill.sourcePath} must point at a SKILL.md file`,
      );
      // Stat throws if the file is fabricated; catch that as a failing assert.
      await fs.stat(skill.sourcePath);
    }
  } finally {
    await sandbox.restore();
  }
});
