import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GJC_BUILTIN_COMMANDS,
  listLiveGjcCommands,
  type LiveGjcCommand,
} from '@/modules/providers/services/live-commands.service.js';

/**
 * GJC live tmux palette precedence (plan Task 12).
 *
 * `listLiveGjcCommands` composes the deck the live gjc composer types into
 * the verified pane. Its documented precedence is:
 *
 *   1. Native TUI built-ins (`GJC_BUILTIN_COMMANDS`) - implemented inside the
 *      gjc binary, so a same-name markdown/skill can never shadow them.
 *   2. User markdown commands under `~/.gjc/agent/commands`.
 *   3. Project markdown commands under `<workspace>/.gjc/commands`.
 *   4. Effective GJC skills - the union of `gjc skills list --json`
 *      (bundled/system) and `gjc skills discover --json` (user/project
 *      candidates), routed through the native skill probe.
 *
 * The palette then applies deterministic first-wins dedupe by command name, so
 * built-in beats user-cmd beats project-cmd beats skill on collision, and
 * every non-colliding entry from every tier survives.
 *
 * The tests are hermetic: no real `gjc` binary is invoked. A temporary shim on
 * `PATH` fully controls what the native probes see, and `os.homedir()` is
 * patched to an isolated sandbox so filesystem scanning cannot escape the
 * fixture. There are no sleeps; every scenario is a single deterministic call.
 */

// ---------------------------------------------------------------------------
// Homedir/PATH sandbox and native `gjc` shim (mirrors gjc-skills.test.ts).
// ---------------------------------------------------------------------------

const HOMEDIR_MODULE = os as unknown as { homedir: () => string };
const patchHomeDir = (nextHomeDir: string): (() => void) => {
  const original = HOMEDIR_MODULE.homedir;
  HOMEDIR_MODULE.homedir = () => nextHomeDir;
  return () => {
    HOMEDIR_MODULE.homedir = original;
  };
};

const writeCommandFile = async (
  rootDir: string,
  relativePath: string,
  contents: string,
): Promise<string> => {
  const filePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
  return filePath;
};

/**
 * Emits a Node script that behaves like the real `gjc skills` CLI for the two
 * argv shapes the adapter probes, and exits non-zero for anything else so an
 * unexpected argv shape can never masquerade as valid JSON.
 */
const buildGjcShim = (options: {
  listPayload?: unknown | 'noop';
  discoverPayload?: unknown | 'noop';
  listStderr?: string;
  discoverStderr?: string;
  listExitCode?: number;
  discoverExitCode?: number;
  listRawStdout?: string;
  discoverRawStdout?: string;
}): string => {
  const encodeStdout = (payload: unknown | 'noop' | undefined, raw: string | undefined): string => {
    if (typeof raw === 'string') {
      return `process.stdout.write(${JSON.stringify(raw)});`;
    }
    if (payload === undefined || payload === 'noop') {
      return '';
    }
    return `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});`;
  };
  const encodeStderr = (message: string | undefined): string => (
    message ? `process.stderr.write(${JSON.stringify(message)});` : ''
  );
  return [
    // Absolute-path shebang so the shim never depends on PATH containing node.
    `#!${process.execPath}`,
    "const argv = process.argv.slice(2).join(' ');",
    "if (argv === 'skills list --json') {",
    encodeStdout(options.listPayload, options.listRawStdout),
    encodeStderr(options.listStderr),
    `process.exit(${options.listExitCode ?? 0});`,
    "}",
    "if (argv === 'skills discover --json') {",
    encodeStdout(options.discoverPayload, options.discoverRawStdout),
    encodeStderr(options.discoverStderr),
    `process.exit(${options.discoverExitCode ?? 0});`,
    "}",
    // Fallback: unexpected argv must fail loudly so the adapter can never
    // consume it as a valid payload.
    "process.stderr.write('unexpected argv: ' + argv);",
    "process.exit(64);",
    "",
  ].join('\n');
};

type LiveSandbox = {
  homeDir: string;
  workspacePath: string;
  userCommandsDir: string;
  projectCommandsDir: string;
  writeShim: (source: string) => Promise<void>;
  restore: () => Promise<void>;
};

const createLiveSandbox = async (
  label: string,
  options: { installShim?: boolean } = {},
): Promise<LiveSandbox> => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-live-${label}-`));
  const workspacePath = path.join(homeDir, 'workspace');
  const binDir = path.join(homeDir, 'bin');
  const userCommandsDir = path.join(homeDir, '.gjc', 'agent', 'commands');
  const projectCommandsDir = path.join(workspacePath, '.gjc', 'commands');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(userCommandsDir, { recursive: true });
  await fs.mkdir(projectCommandsDir, { recursive: true });

  const restoreHomeDir = patchHomeDir(homeDir);
  const originalPath = process.env.PATH;
  // Replace PATH so the workstation's real `gjc` binary can never win the
  // shim lookup by accident. When `installShim: false` the probe must fail
  // with the missing-binary category and the palette must degrade cleanly.
  process.env.PATH = options.installShim === false ? '' : binDir;

  const writeShim = async (source: string): Promise<void> => {
    const shimPath = path.join(binDir, 'gjc');
    await fs.writeFile(shimPath, source, 'utf8');
    await fs.chmod(shimPath, 0o755);
  };

  return {
    homeDir,
    workspacePath,
    userCommandsDir,
    projectCommandsDir,
    writeShim,
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

const byCommandName = (commands: LiveGjcCommand[]): Map<string, LiveGjcCommand> =>
  new Map(commands.map((command) => [command.name, command]));

const namespacesFor = (
  commands: LiveGjcCommand[],
  name: string,
): LiveGjcCommand['namespace'][] => (
  commands.filter((command) => command.name === name).map((command) => command.namespace)
);

// ---------------------------------------------------------------------------
// Collision precedence: builtin > user > project > skill.
// ---------------------------------------------------------------------------

test('builtin wins a four-way collision against user, project, and skill', { concurrency: false }, async () => {
  const sandbox = await createLiveSandbox('collide-builtin');
  try {
    await writeCommandFile(
      sandbox.userCommandsDir,
      'clear.md',
      '---\ndescription: user-clear-should-lose\n---\nbody\n',
    );
    await writeCommandFile(
      sandbox.projectCommandsDir,
      'clear.md',
      '---\ndescription: project-clear-should-lose\n---\nbody\n',
    );
    await sandbox.writeShim(buildGjcShim({
      listPayload: {
        skills: [
          {
            name: 'clear',
            description: 'skill-clear-should-lose',
            path: 'embedded:gjc/skills/clear/SKILL.md',
            source: 'bundled:default',
          },
        ],
      },
      discoverPayload: { entries: [] },
    }));

    const commands = await listLiveGjcCommands(sandbox.workspacePath);
    const clearEntries = commands.filter((command) => command.name === '/clear');

    assert.equal(clearEntries.length, 1, 'dedupe must keep exactly one /clear');
    assert.equal(clearEntries[0]?.namespace, 'builtin');
    // Native built-in descriptions are frozen inside the deck; the loser
    // markdown/skill description must not overwrite them.
    assert.equal(
      clearEntries[0]?.description,
      GJC_BUILTIN_COMMANDS.find((command) => command.name === '/clear')?.description,
    );
  } finally {
    await sandbox.restore();
  }
});

test('user markdown command wins a three-way collision against project and skill', { concurrency: false }, async () => {
  const sandbox = await createLiveSandbox('collide-user');
  try {
    const userPath = await writeCommandFile(
      sandbox.userCommandsDir,
      'alpha.md',
      '---\ndescription: user-alpha-wins\n---\nbody\n',
    );
    await writeCommandFile(
      sandbox.projectCommandsDir,
      'alpha.md',
      '---\ndescription: project-alpha-loses\n---\nbody\n',
    );
    await sandbox.writeShim(buildGjcShim({
      listPayload: {
        skills: [
          {
            name: 'alpha',
            description: 'bundled-alpha-loses',
            path: 'embedded:gjc/skills/alpha/SKILL.md',
            source: 'bundled:default',
          },
        ],
      },
      discoverPayload: { entries: [] },
    }));

    const commands = await listLiveGjcCommands(sandbox.workspacePath);
    const alphaEntries = commands.filter((command) => command.name === '/alpha');

    assert.equal(alphaEntries.length, 1);
    assert.equal(alphaEntries[0]?.namespace, 'user');
    assert.equal(alphaEntries[0]?.scope, 'user');
    assert.equal(alphaEntries[0]?.sourcePath, userPath);
    assert.equal(alphaEntries[0]?.description, 'user-alpha-wins');
  } finally {
    await sandbox.restore();
  }
});

test('project markdown command wins over a same-name effective skill', { concurrency: false }, async () => {
  const sandbox = await createLiveSandbox('collide-project');
  try {
    const projectPath = await writeCommandFile(
      sandbox.projectCommandsDir,
      'beta.md',
      '---\ndescription: project-beta-wins\n---\nbody\n',
    );
    await sandbox.writeShim(buildGjcShim({
      listPayload: { skills: [] },
      discoverPayload: {
        entries: [
          {
            name: 'beta',
            description: 'discovered-beta-loses',
            path: path.join(sandbox.homeDir, '.gjc', 'agent', 'skills', 'beta', 'SKILL.md'),
            source: 'user',
          },
        ],
      },
    }));

    const commands = await listLiveGjcCommands(sandbox.workspacePath);
    const betaEntries = commands.filter((command) => command.name === '/beta');

    assert.equal(betaEntries.length, 1);
    assert.equal(betaEntries[0]?.namespace, 'project');
    assert.equal(betaEntries[0]?.scope, 'project');
    assert.equal(betaEntries[0]?.sourcePath, projectPath);
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Non-colliding union: every tier's unique entries survive.
// ---------------------------------------------------------------------------

test('bundled + discovered union merges with user/project markdown without collisions', { concurrency: false }, async () => {
  const sandbox = await createLiveSandbox('union');
  try {
    await writeCommandFile(
      sandbox.userCommandsDir,
      'user-tool.md',
      '---\ndescription: user tool\n---\nbody\n',
    );
    await writeCommandFile(
      sandbox.projectCommandsDir,
      'proj-tool.md',
      '---\ndescription: project tool\n---\nbody\n',
    );
    const discoveredPath = path.join(
      sandbox.homeDir,
      '.gjc',
      'agent',
      'skills',
      'design-interview',
      'SKILL.md',
    );
    await sandbox.writeShim(buildGjcShim({
      listPayload: {
        skills: [
          {
            name: 'autoresearch',
            description: 'bundled autoresearch',
            path: 'embedded:gjc/skills/autoresearch/SKILL.md',
            source: 'bundled:default',
          },
          {
            name: 'ultragoal',
            description: 'bundled ultragoal',
            path: 'embedded:gjc/skills/ultragoal/SKILL.md',
            source: 'bundled:default',
          },
        ],
      },
      discoverPayload: {
        entries: [
          {
            name: 'design-interview',
            description: 'custom discovered',
            path: discoveredPath,
            source: 'user',
          },
        ],
      },
    }));

    const commands = await listLiveGjcCommands(sandbox.workspacePath);
    const byName = byCommandName(commands);

    // Every built-in survives.
    for (const builtin of GJC_BUILTIN_COMMANDS) {
      const surfaced = byName.get(builtin.name);
      assert.ok(surfaced, `built-in ${builtin.name} must be present`);
      assert.equal(surfaced.namespace, 'builtin');
    }

    // Markdown commands from both scopes survive with truthful sourcePaths.
    assert.equal(byName.get('/user-tool')?.namespace, 'user');
    assert.equal(
      byName.get('/user-tool')?.sourcePath,
      path.join(sandbox.userCommandsDir, 'user-tool.md'),
    );
    assert.equal(byName.get('/proj-tool')?.namespace, 'project');
    assert.equal(
      byName.get('/proj-tool')?.sourcePath,
      path.join(sandbox.projectCommandsDir, 'proj-tool.md'),
    );

    // Bundled + discovered union: all three unique skill names are present.
    assert.equal(byName.get('/autoresearch')?.namespace, 'skill');
    assert.equal(byName.get('/autoresearch')?.scope, 'system');
    assert.equal(
      byName.get('/autoresearch')?.sourcePath,
      'embedded:gjc/skills/autoresearch/SKILL.md',
    );
    assert.equal(byName.get('/ultragoal')?.namespace, 'skill');
    assert.equal(byName.get('/ultragoal')?.scope, 'system');
    assert.equal(byName.get('/design-interview')?.namespace, 'skill');
    assert.equal(byName.get('/design-interview')?.scope, 'user');
    assert.equal(byName.get('/design-interview')?.sourcePath, discoveredPath);
  } finally {
    await sandbox.restore();
  }
});

test('deterministic dedupe collapses same-name skill duplicates to a single entry', { concurrency: false }, async () => {
  const sandbox = await createLiveSandbox('dedupe-dupes');
  try {
    const winnerPath = 'embedded:gjc/skills/dupe-tool/SKILL.md';
    const loserPath = path.join(sandbox.homeDir, '.gjc', 'agent', 'skills', 'dupe-tool', 'SKILL.md');
    await sandbox.writeShim(buildGjcShim({
      // Bundled must beat the same-name discovered candidate (native shadow),
      // and the palette's first-wins dedupe must not surface both.
      listPayload: {
        skills: [
          {
            name: 'dupe-tool',
            description: 'bundled winner',
            path: winnerPath,
            source: 'bundled:default',
          },
        ],
      },
      discoverPayload: {
        entries: [
          {
            name: 'dupe-tool',
            description: 'discovered loser',
            path: loserPath,
            source: 'user',
          },
        ],
      },
    }));

    const commands = await listLiveGjcCommands(sandbox.workspacePath);
    const namespaces = namespacesFor(commands, '/dupe-tool');

    assert.deepEqual(namespaces, ['skill']);
    assert.equal(
      commands.find((command) => command.name === '/dupe-tool')?.sourcePath,
      winnerPath,
    );
  } finally {
    await sandbox.restore();
  }
});

// ---------------------------------------------------------------------------
// Partial-source failure: valid tiers still surface; no stale/foreign skill.
// ---------------------------------------------------------------------------

test('discover probe failure preserves bundled skill and file-based commands', { concurrency: false }, async () => {
  const sandbox = await createLiveSandbox('partial-discover-fails');
  try {
    await writeCommandFile(
      sandbox.userCommandsDir,
      'usr-cmd.md',
      '---\ndescription: usr cmd\n---\nbody\n',
    );
    await writeCommandFile(
      sandbox.projectCommandsDir,
      'proj-cmd.md',
      '---\ndescription: proj cmd\n---\nbody\n',
    );
    await sandbox.writeShim(buildGjcShim({
      listPayload: {
        skills: [
          {
            name: 'autoresearch',
            description: 'bundled autoresearch',
            path: 'embedded:gjc/skills/autoresearch/SKILL.md',
            source: 'bundled:default',
          },
        ],
      },
      // Discover fails with nonzero exit. The GJC adapter falls back to a
      // filesystem scan of only its own roots; those roots are empty here, so
      // no discovered skill surfaces.
      discoverExitCode: 7,
    }));

    const commands = await listLiveGjcCommands(sandbox.workspacePath);
    const byName = byCommandName(commands);

    assert.equal(byName.get('/usr-cmd')?.namespace, 'user');
    assert.equal(byName.get('/proj-cmd')?.namespace, 'project');
    // Bundled tier still succeeded and its skill surfaced.
    assert.equal(byName.get('/autoresearch')?.namespace, 'skill');
    assert.equal(byName.get('/autoresearch')?.scope, 'system');
    // Built-ins are always present regardless of probe outcome.
    assert.equal(byName.get('/clear')?.namespace, 'builtin');
  } finally {
    await sandbox.restore();
  }
});

test('list probe failure still surfaces discovered candidates and file commands', { concurrency: false }, async () => {
  const sandbox = await createLiveSandbox('partial-list-fails');
  try {
    await writeCommandFile(
      sandbox.projectCommandsDir,
      'proj-only.md',
      '---\ndescription: proj only\n---\nbody\n',
    );
    const discoveredPath = path.join(
      sandbox.homeDir,
      '.gjc',
      'agent',
      'skills',
      'user-only-skill',
      'SKILL.md',
    );
    await sandbox.writeShim(buildGjcShim({
      // List returns malformed JSON, so the bundled tier fails; the adapter
      // must not fabricate a bundled entry.
      listRawStdout: '{ not-json',
      discoverPayload: {
        entries: [
          {
            name: 'user-only-skill',
            description: 'discovered',
            path: discoveredPath,
            source: 'user',
          },
        ],
      },
    }));

    const commands = await listLiveGjcCommands(sandbox.workspacePath);
    const byName = byCommandName(commands);

    assert.equal(byName.get('/proj-only')?.namespace, 'project');
    assert.equal(byName.get('/user-only-skill')?.namespace, 'skill');
    assert.equal(byName.get('/user-only-skill')?.scope, 'user');
    assert.equal(byName.get('/user-only-skill')?.sourcePath, discoveredPath);
    // No bundled skill leaked through despite the malformed list output, and
    // the raw payload never entered the returned entries.
    assert.equal(
      commands.some((command) => command.namespace === 'skill' && command.scope === 'system'),
      false,
    );
    assert.equal(
      JSON.stringify(commands).includes('not-json'),
      false,
    );
  } finally {
    await sandbox.restore();
  }
});

test('full skill probe failure leaves builtins and project commands with no stale or foreign skill', { concurrency: false }, async () => {
  const sandbox = await createLiveSandbox('probe-full-failure', { installShim: false });
  try {
    // Valid GJC-owned project + user command files must survive.
    const projectPath = await writeCommandFile(
      sandbox.projectCommandsDir,
      'proj-cmd.md',
      '---\ndescription: project keeps working\n---\nbody\n',
    );
    const userPath = await writeCommandFile(
      sandbox.userCommandsDir,
      'usr-cmd.md',
      '---\ndescription: user keeps working\n---\nbody\n',
    );
    // Populate every foreign provider's home skill root. The GJC skills
    // adapter must never scan these; the palette must show zero skill entries.
    for (const foreignRoot of [
      path.join(sandbox.homeDir, '.codex', 'skills'),
      path.join(sandbox.homeDir, '.claude', 'skills'),
      path.join(sandbox.homeDir, '.agents', 'skills'),
      path.join(sandbox.homeDir, '.omp', 'agent', 'skills'),
      path.join(sandbox.homeDir, '.omo', 'agent', 'skills'),
    ]) {
      await fs.mkdir(path.join(foreignRoot, 'foreign-skill'), { recursive: true });
      await fs.writeFile(
        path.join(foreignRoot, 'foreign-skill', 'SKILL.md'),
        '---\nname: foreign-skill\ndescription: MUST-NOT-LEAK\n---\nbody\n',
        'utf8',
      );
    }

    const commands = await listLiveGjcCommands(sandbox.workspacePath);
    const byName = byCommandName(commands);

    // Built-in survivors: sample several to confirm the whole deck remains.
    for (const expected of ['/clear', '/compact', '/model', '/resume', '/help']) {
      assert.equal(byName.get(expected)?.namespace, 'builtin', `${expected} must survive`);
    }
    // File-based commands survive with truthful sourcePaths.
    assert.equal(byName.get('/proj-cmd')?.namespace, 'project');
    assert.equal(byName.get('/proj-cmd')?.sourcePath, projectPath);
    assert.equal(byName.get('/usr-cmd')?.namespace, 'user');
    assert.equal(byName.get('/usr-cmd')?.sourcePath, userPath);
    // Zero skill entries: no stale bundled/discovered and no foreign leak.
    const skillEntries = commands.filter((command) => command.namespace === 'skill');
    assert.deepEqual(skillEntries, [], 'no skill entry may remain when the probe fails');
    assert.equal(
      byName.has('/foreign-skill'),
      false,
      'foreign provider skill must never surface on the GJC palette',
    );
    assert.equal(
      JSON.stringify(commands).includes('MUST-NOT-LEAK'),
      false,
    );
  } finally {
    await sandbox.restore();
  }
});
