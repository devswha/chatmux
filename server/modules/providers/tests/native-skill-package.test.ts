import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_DECLARED_SKILL_ROOTS,
  resolveNativeSkillPackage,
} from '@/modules/providers/shared/skills/native-skill-package.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
};

const writeSkill = async (skillsRoot: string, directoryName: string): Promise<string> => {
  const skillDir = path.join(skillsRoot, directoryName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(
    skillPath,
    `---\nname: ${directoryName}\ndescription: ${directoryName} fixture\n---\n\n`,
    'utf8',
  );
  return skillPath;
};

type PackageFixture = {
  binDir: string;
  launcherPath: string;
  packageRoot: string;
};

/**
 * Builds a launcher/package layout that matches how a global CLI is really
 * installed: an executable launcher inside a bin directory that is a relative
 * symlink into the installed package's `bin/` entry point.
 */
const createLauncherPackage = async (
  installRoot: string,
  options: {
    command: string;
    binDirRelativePath: string;
    packageRelativePath: string;
    manifest?: Record<string, unknown> | 'malformed' | 'absent';
  },
): Promise<PackageFixture> => {
  const binDir = path.join(installRoot, options.binDirRelativePath);
  const packageRoot = path.join(installRoot, options.packageRelativePath);
  const launcherPath = path.join(packageRoot, 'bin', `${options.command}.js`);
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(path.dirname(launcherPath), { recursive: true });
  await fs.writeFile(launcherPath, '#!/usr/bin/env node\n', 'utf8');
  await fs.chmod(launcherPath, 0o755);

  const manifest = options.manifest ?? {
    name: `${options.command}-cli`,
    version: '1.2.3',
    bin: { [options.command]: `bin/${options.command}.js` },
  };
  if (manifest === 'malformed') {
    await fs.writeFile(path.join(packageRoot, 'package.json'), '{ "name": ', 'utf8');
  } else if (manifest !== 'absent') {
    await writeJson(path.join(packageRoot, 'package.json'), manifest);
  }

  const shimPath = path.join(binDir, options.command);
  await fs.symlink(path.relative(binDir, launcherPath), shimPath);
  return { binDir, launcherPath, packageRoot };
};

const assertNoAbsolutePathLeak = (value: unknown, ...forbiddenPaths: string[]): void => {
  const serialized = JSON.stringify(value ?? null);
  for (const forbiddenPath of forbiddenPaths) {
    assert.equal(serialized.includes(forbiddenPath), false, 'diagnostics must not leak real paths');
  }
  assert.equal(
    /"\/[^"]*"/.test(serialized),
    false,
    'diagnostics must not include absolute filesystem paths',
  );
};

test('resolves npm-style launcher package and declared skill roots', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-package-npm-'));
  try {
    const fixture = await createLauncherPackage(tempRoot, {
      command: 'omo',
      binDirRelativePath: 'bin',
      packageRelativePath: path.join('lib', 'node_modules', 'omo-ai'),
    });
    await writeJson(path.join(fixture.packageRoot, 'plugin', 'package.json'), {
      name: '@fixture/omo-senpi',
      pi: { extensions: ['./extensions/omo.js'], skills: ['./skills'] },
    });
    const skillPath = await writeSkill(path.join(fixture.packageRoot, 'plugin', 'skills'), 'hyperplan');

    const resolution = await resolveNativeSkillPackage({
      command: 'omo',
      searchPaths: [fixture.binDir],
      manifestRelativePaths: ['package.json', 'plugin/package.json'],
    });

    assert.equal(resolution.resolved, true);
    assert.equal(resolution.packageRoot, await fs.realpath(fixture.packageRoot));
    assert.equal(resolution.launcherPath, await fs.realpath(fixture.launcherPath));
    assert.equal(resolution.version, '1.2.3');
    assert.deepEqual(resolution.diagnostics, []);
    assert.deepEqual(
      resolution.skillRoots.map((root) => root.rootDir),
      [await fs.realpath(path.join(fixture.packageRoot, 'plugin', 'skills'))],
    );
    assert.deepEqual(
      resolution.skillRoots.map((root) => root.manifestPath),
      [await fs.realpath(path.join(fixture.packageRoot, 'plugin', 'package.json'))],
    );

    // Truthful paths: the returned root really contains the declared skill file.
    const entries = await fs.readdir(resolution.skillRoots[0]!.rootDir);
    assert.deepEqual(entries, ['hyperplan']);
    assert.equal(
      path.join(resolution.skillRoots[0]!.rootDir, 'hyperplan', 'SKILL.md'),
      await fs.realpath(skillPath),
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolves bun-style symlinked launcher through PATH and relative declarations', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-package-bun-'));
  try {
    const fixture = await createLauncherPackage(tempRoot, {
      command: 'omo',
      binDirRelativePath: path.join('.bun', 'bin'),
      packageRelativePath: path.join('.bun', 'install', 'global', 'node_modules', 'omo-ai'),
      manifest: {
        name: 'omo',
        version: '5.0.0-beta.21',
        // npm's string `bin` form: the executable is named after the package.
        bin: 'bin/omo.js',
        pi: { skills: ['plugin/skills', './extra-skills'] },
      },
    });
    await writeSkill(path.join(fixture.packageRoot, 'plugin', 'skills'), 'git-master');
    await writeSkill(path.join(fixture.packageRoot, 'extra-skills'), 'debugging');

    const resolution = await resolveNativeSkillPackage({
      command: 'omo',
      env: { PATH: [path.join(tempRoot, 'missing-bin'), fixture.binDir].join(path.delimiter) },
    });

    assert.equal(resolution.resolved, true);
    assert.equal(resolution.packageRoot, await fs.realpath(fixture.packageRoot));
    assert.deepEqual(resolution.diagnostics, []);
    assert.deepEqual(
      resolution.skillRoots.map((root) => root.rootDir),
      [
        await fs.realpath(path.join(fixture.packageRoot, 'plugin', 'skills')),
        await fs.realpath(path.join(fixture.packageRoot, 'extra-skills')),
      ],
    );
    assert.deepEqual(
      resolution.skillRoots.map((root) => root.declaredBy),
      ['package.json', 'package.json'],
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('returns fail-closed sanitized results for absent CLI and unresolvable package', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-package-absent-'));
  try {
    const missing = await resolveNativeSkillPackage({
      command: 'omo',
      searchPaths: [path.join(tempRoot, 'bin')],
    });
    assert.deepEqual(missing, {
      resolved: false,
      skillRoots: [],
      diagnostics: [{ category: 'cli-not-found' }],
    });

    // A launcher that no package.json claims through `bin` must not be attributed
    // to an unrelated ancestor package.
    const binDir = path.join(tempRoot, 'orphan-bin');
    const launcherPath = path.join(tempRoot, 'orphan', 'bin', 'omo.js');
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(path.dirname(launcherPath), { recursive: true });
    await fs.writeFile(launcherPath, '#!/usr/bin/env node\n', 'utf8');
    await fs.chmod(launcherPath, 0o755);
    await writeJson(path.join(tempRoot, 'orphan', 'package.json'), {
      name: 'unrelated',
      bin: { other: 'bin/other.js' },
    });
    await fs.symlink(path.relative(binDir, launcherPath), path.join(binDir, 'omo'));

    const orphan = await resolveNativeSkillPackage({ command: 'omo', searchPaths: [binDir] });
    assert.equal(orphan.resolved, false);
    assert.deepEqual(orphan.skillRoots, []);
    assert.deepEqual(orphan.diagnostics, [{ category: 'package-root-not-found' }]);
    assertNoAbsolutePathLeak(orphan, tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('fails closed on missing, malformed, and unreadable manifests', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-package-manifest-'));
  try {
    const fixture = await createLauncherPackage(tempRoot, {
      command: 'omo',
      binDirRelativePath: 'bin',
      packageRelativePath: path.join('lib', 'node_modules', 'omo-ai'),
    });
    await writeSkill(path.join(fixture.packageRoot, 'plugin', 'skills'), 'frontend');
    await fs.writeFile(path.join(fixture.packageRoot, 'plugin', 'package.json'), '{ "pi": ', 'utf8');
    const unreadableManifestPath = path.join(fixture.packageRoot, 'locked', 'package.json');
    await writeJson(unreadableManifestPath, { pi: { skills: ['./skills'] } });
    await fs.chmod(unreadableManifestPath, 0o000);

    const resolution = await resolveNativeSkillPackage({
      command: 'omo',
      searchPaths: [fixture.binDir],
      manifestRelativePaths: [
        'plugin/package.json',
        'missing/package.json',
        'locked/package.json',
      ],
    });

    assert.equal(resolution.resolved, true);
    assert.deepEqual(resolution.skillRoots, []);
    const categories = resolution.diagnostics.map((diagnostic) => diagnostic.category);
    assert.equal(categories.includes('manifest-invalid'), true);
    assert.equal(categories.includes('manifest-missing'), true);
    assert.equal(categories.includes(isRoot ? 'declaration-missing' : 'manifest-unreadable'), true);
    assert.deepEqual(
      resolution.diagnostics
        .filter((diagnostic) => diagnostic.manifest !== undefined)
        .map((diagnostic) => diagnostic.manifest),
      ['plugin/package.json', 'missing/package.json', 'locked/package.json'],
    );
    assertNoAbsolutePathLeak(resolution.diagnostics, tempRoot);
  } finally {
    await fs.chmod(
      path.join(tempRoot, 'lib', 'node_modules', 'omo-ai', 'locked', 'package.json'),
      0o600,
    ).catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects invalid pi.skills declarations without exposing roots', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-package-invalid-'));
  try {
    const fixture = await createLauncherPackage(tempRoot, {
      command: 'omo',
      binDirRelativePath: 'bin',
      packageRelativePath: 'pkg',
      manifest: {
        name: 'omo-ai',
        bin: { omo: 'bin/omo.js' },
        pi: { skills: './skills' },
      },
    });
    await writeSkill(path.join(fixture.packageRoot, 'skills'), 'debugging');
    await writeJson(path.join(fixture.packageRoot, 'a', 'package.json'), { pi: { skills: [] } });
    await writeJson(path.join(fixture.packageRoot, 'b', 'package.json'), {
      pi: { skills: [{ dir: './skills' }, 42] },
    });
    await writeJson(path.join(fixture.packageRoot, 'c', 'package.json'), { pi: 'skills' });
    await writeJson(path.join(fixture.packageRoot, 'd', 'package.json'), { name: 'no-pi-field' });

    const resolution = await resolveNativeSkillPackage({
      command: 'omo',
      searchPaths: [fixture.binDir],
      manifestRelativePaths: [
        'package.json',
        'a/package.json',
        'b/package.json',
        'c/package.json',
        'd/package.json',
      ],
    });

    assert.equal(resolution.resolved, true);
    assert.deepEqual(resolution.skillRoots, []);
    assert.deepEqual(resolution.diagnostics, [
      { category: 'declaration-invalid', manifest: 'package.json' },
      { category: 'declaration-invalid', manifest: 'b/package.json' },
      { category: 'declaration-invalid', manifest: 'c/package.json' },
    ]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects traversal, absolute, and symlink-escaping declared roots', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-package-escape-'));
  try {
    const outsideRoot = path.join(tempRoot, 'outside');
    await writeSkill(outsideRoot, 'foreign');
    const fixture = await createLauncherPackage(tempRoot, {
      command: 'omo',
      binDirRelativePath: 'bin',
      packageRelativePath: 'pkg',
      manifest: {
        name: 'omo-ai',
        bin: { omo: 'bin/omo.js' },
        pi: {
          skills: [
            '../outside',
            './nested/../../outside',
            outsideRoot,
            './escaped-link',
            './skills',
          ],
        },
      },
    });
    await fs.symlink(outsideRoot, path.join(fixture.packageRoot, 'escaped-link'));
    await writeSkill(path.join(fixture.packageRoot, 'skills'), 'native');

    const resolution = await resolveNativeSkillPackage({
      command: 'omo',
      searchPaths: [fixture.binDir],
    });

    assert.deepEqual(
      resolution.skillRoots.map((root) => root.rootDir),
      [await fs.realpath(path.join(fixture.packageRoot, 'skills'))],
    );
    assert.deepEqual(
      resolution.diagnostics,
      Array.from({ length: 4 }, () => ({
        category: 'declaration-escaped' as const,
        manifest: 'package.json',
      })),
    );
    assertNoAbsolutePathLeak(resolution.diagnostics, tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('reports missing, non-directory, and unreadable declared roots', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-package-roots-'));
  try {
    const fixture = await createLauncherPackage(tempRoot, {
      command: 'omo',
      binDirRelativePath: 'bin',
      packageRelativePath: 'pkg',
      manifest: {
        name: 'omo-ai',
        bin: { omo: 'bin/omo.js' },
        pi: { skills: ['./gone', './file-skills', './locked-skills', './skills'] },
      },
    });
    await fs.writeFile(path.join(fixture.packageRoot, 'file-skills'), 'not a directory\n', 'utf8');
    await writeSkill(path.join(fixture.packageRoot, 'locked-skills'), 'locked');
    await writeSkill(path.join(fixture.packageRoot, 'skills'), 'native');
    await fs.chmod(path.join(fixture.packageRoot, 'locked-skills'), 0o000);

    const resolution = await resolveNativeSkillPackage({
      command: 'omo',
      searchPaths: [fixture.binDir],
    });

    assert.deepEqual(
      resolution.skillRoots.map((root) => root.rootDir),
      isRoot
        ? [
          await fs.realpath(path.join(fixture.packageRoot, 'locked-skills')),
          await fs.realpath(path.join(fixture.packageRoot, 'skills')),
        ]
        : [await fs.realpath(path.join(fixture.packageRoot, 'skills'))],
    );
    const categories = resolution.diagnostics.map((diagnostic) => diagnostic.category);
    assert.equal(categories.filter((category) => category === 'declaration-missing').length, 2);
    assert.equal(
      categories.includes('declaration-unreadable'),
      !isRoot,
    );
  } finally {
    await fs.chmod(path.join(tempRoot, 'pkg', 'locked-skills'), 0o700).catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('dedupes repeated declarations and caps declared roots', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'native-skill-package-cap-'));
  try {
    const declarations = Array.from(
      { length: MAX_DECLARED_SKILL_ROOTS + 3 },
      (_, index) => `./skills-${index}`,
    );
    const fixture = await createLauncherPackage(tempRoot, {
      command: 'omo',
      binDirRelativePath: 'bin',
      packageRelativePath: 'pkg',
      manifest: {
        name: 'omo-ai',
        bin: { omo: 'bin/omo.js' },
        pi: { skills: ['./skills-0', ...declarations] },
      },
    });
    for (const declaration of declarations) {
      await writeSkill(path.join(fixture.packageRoot, declaration), 'native');
    }

    const resolution = await resolveNativeSkillPackage({
      command: 'omo',
      searchPaths: [fixture.binDir],
    });

    assert.equal(resolution.skillRoots.length, MAX_DECLARED_SKILL_ROOTS);
    assert.equal(
      new Set(resolution.skillRoots.map((root) => root.rootDir)).size,
      MAX_DECLARED_SKILL_ROOTS,
    );
    assert.deepEqual(
      resolution.diagnostics,
      [{ category: 'declaration-capped', manifest: 'package.json' }],
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
