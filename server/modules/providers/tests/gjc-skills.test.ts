import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import type { ProviderSkill, ProviderSkillScope } from '@/shared/types.js';

/**
 * GJC provider skill contract (plan Task 5).
 *
 * The provider replaces the raw filesystem union with two bounded native JSON
 * inventories invoked through the no-shell probe:
 *   - `gjc skills list --json`     -> bundled workflow skills (scope=system,
 *                                     embedded:gjc/skills/<name>/SKILL.md)
 *   - `gjc skills discover --json` -> effective filesystem candidates
 *                                     (scope=user|project, real fs path)
 *
 * These tests are hermetic: they never spawn the real `gjc` binary. A temporary
 * `gjc` shim written to a temp bin directory is prepended to `PATH`, and each
 * scenario controls that shim's exit code, stdout shape, and byte volume. Real
 * discover output uses a `{ candidates, diagnostics }` envelope that the probe
 * intentionally rejects; those scenarios prove the safe filesystem fallback
 * scans only GJC's own documented roots and never a foreign provider's tree.
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
  listStdoutFillBytes?: number;
  discoverStdoutFillBytes?: number;
  hangOn?: 'list' | 'discover';
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
  const encodeExit = (exitCode: number | undefined, mode: 'list' | 'discover'): string => {
    if (options.hangOn === mode) {
      return `setInterval(() => {}, 60000);`;
    }
    return `process.exit(${exitCode ?? 0});`;
  };
  const encodeFill = (bytes: number | undefined): string => (
    bytes && bytes > 0
      ? `process.stdout.write('x'.repeat(${bytes}));`
      : ''
  );

  // Absolute-path shebang so the shim never depends on PATH containing
  // node/env: the test scenarios routinely clear PATH to isolate the probe.
  return [
    `#!${process.execPath}`,
    "const argv = process.argv.slice(2).join(' ');",
    // list --json branch
    "if (argv === 'skills list --json') {",
    encodeStdout(options.listPayload, options.listRawStdout),
    encodeFill(options.listStdoutFillBytes),
    encodeStderr(options.listStderr),
    encodeExit(options.listExitCode, 'list'),
    "}",
    // discover --json branch
    "if (argv === 'skills discover --json') {",
    encodeStdout(options.discoverPayload, options.discoverRawStdout),
    encodeFill(options.discoverStdoutFillBytes),
    encodeStderr(options.discoverStderr),
    encodeExit(options.discoverExitCode, 'discover'),
    "}",
    // Fallback: unexpected argv must fail loudly so the adapter can never
    // consume it as a valid payload.
    "process.stderr.write('unexpected argv: ' + argv);",
    "process.exit(64);",
    "",
  ].join('\n');
};

type GjcSandbox = {
  homeDir: string;
  workspacePath: string;
  binDir: string;
  writeShim: (source: string) => Promise<void>;
  restore: () => Promise<void>;
};

const createGjcSandbox = async (
  label: string,
  options: { installShim?: boolean } = {},
): Promise<GjcSandbox> => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-skills-${label}-`));
  const workspacePath = path.join(homeDir, 'workspace');
  const binDir = path.join(homeDir, 'bin');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });

  const restoreHomeDir = patchHomeDir(homeDir);
  const originalPath = process.env.PATH;
  // Replace PATH so the workstation's real `gjc` binary can never win the
  // shim lookup by accident. If a shim is not installed, the probe must fail
  // with the missing-binary category.
  process.env.PATH = options.installShim === false ? '' : binDir;

  const writeShim = async (source: string): Promise<void> => {
    const shimPath = path.join(binDir, 'gjc');
    await fs.writeFile(shimPath, source, 'utf8');
    await fs.chmod(shimPath, 0o755);
  };

  return {
    homeDir,
    workspacePath,
    binDir,
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

const bySkillName = (skills: ProviderSkill[]): Map<string, ProviderSkill> =>
  new Map(skills.map((skill) => [skill.name, skill]));

const scopeOf = (skills: ProviderSkill[], name: string): ProviderSkillScope | undefined => (
  bySkillName(skills).get(name)?.scope
);

// ----------------------------------------------------------------------------
// Happy paths: native probes drive the effective catalog.
// ----------------------------------------------------------------------------

test('GJC surfaces bundled autoresearch from gjc skills list --json', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('bundled-autoresearch');
  try {
    await sandbox.writeShim(buildGjcShim({
      listPayload: {
        skills: [
          {
            name: 'autoresearch',
            description: 'Goal-directed research',
            path: 'embedded:gjc/skills/autoresearch/SKILL.md',
            source: 'bundled:default',
          },
        ],
      },
      // Real gjc discover emits { candidates, diagnostics } which the probe
      // intentionally rejects; we mimic that here to prove the bundled path
      // still succeeds even when discover fails.
      discoverPayload: { candidates: [], diagnostics: [] },
    }));

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });
    const autoresearch = bySkillName(skills).get('autoresearch');

    assert.ok(autoresearch, 'bundled autoresearch must surface');
    assert.equal(autoresearch.provider, 'gjc');
    assert.equal(autoresearch.command, '/autoresearch');
    assert.equal(autoresearch.scope, 'system');
    assert.equal(autoresearch.sourcePath, 'embedded:gjc/skills/autoresearch/SKILL.md');
  } finally {
    await sandbox.restore();
  }
});

test('GJC surfaces the custom design-interview candidate from discover --json', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('custom-design-interview');
  try {
    const designInterviewPath = '/home/devswha/.gjc/agent/skills/design-interview/SKILL.md';
    await sandbox.writeShim(buildGjcShim({
      listPayload: { skills: [] },
      // Use the probe's recognized `entries` envelope so the discover path
      // is exercised end-to-end. The real CLI emits `candidates`; that shape
      // is proven separately below.
      discoverPayload: {
        entries: [
          {
            name: 'design-interview',
            description: 'Custom interview-driven skill',
            path: designInterviewPath,
            source: 'user',
          },
        ],
      },
    }));

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });
    const designInterview = bySkillName(skills).get('design-interview');

    assert.ok(designInterview, 'custom design-interview must surface via discover');
    assert.equal(designInterview.provider, 'gjc');
    assert.equal(designInterview.command, '/design-interview');
    assert.equal(designInterview.scope, 'user');
    assert.equal(designInterview.sourcePath, designInterviewPath);
  } finally {
    await sandbox.restore();
  }
});

test('GJC bundled entry shadows a same-name discovered candidate', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('shadow-collision');
  try {
    const bundledPath = 'embedded:gjc/skills/deep-interview/SKILL.md';
    const shadowedPath = path.join(sandbox.homeDir, '.gjc', 'agent', 'skills', 'deep-interview', 'SKILL.md');
    await sandbox.writeShim(buildGjcShim({
      listPayload: {
        skills: [
          { name: 'deep-interview', description: 'bundled variant', path: bundledPath, source: 'bundled:default' },
        ],
      },
      discoverPayload: {
        entries: [
          { name: 'deep-interview', description: 'user copy', path: shadowedPath, source: 'user' },
        ],
      },
    }));

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });
    const winners = skills.filter((skill) => skill.name === 'deep-interview');

    assert.equal(winners.length, 1, 'bundled must shadow the same-name discovered candidate');
    assert.equal(winners[0]?.scope, 'system');
    assert.equal(winners[0]?.command, '/deep-interview');
    assert.equal(winners[0]?.sourcePath, bundledPath);
  } finally {
    await sandbox.restore();
  }
});

test('GJC honors explicit native shadow diagnostics on discovered candidates', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('native-shadow-marker');
  try {
    const activePath = path.join(sandbox.homeDir, '.gjc', 'agent', 'skills', 'kept', 'SKILL.md');
    const shadowedPath = path.join(sandbox.homeDir, '.gjc', 'skills', 'kept', 'SKILL.md');
    await sandbox.writeShim(buildGjcShim({
      listPayload: { skills: [] },
      discoverPayload: {
        entries: [
          { name: 'kept', description: 'active winner', path: activePath, source: 'user' },
          {
            name: 'kept',
            description: 'the CLI already marked this shadowed',
            path: shadowedPath,
            source: 'project',
            shadowedBy: 'user',
          },
        ],
      },
    }));

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });
    const kept = skills.filter((skill) => skill.name === 'kept');

    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.sourcePath, activePath);
    assert.equal(kept[0]?.scope, 'user');
  } finally {
    await sandbox.restore();
  }
});

test('GJC preserves truthful paths and scopes for bundled and discovered tiers', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('truthful-paths');
  try {
    const projectSkillPath = path.join(sandbox.workspacePath, '.gjc', 'skills', 'proj-tool', 'SKILL.md');
    const userSkillPath = path.join(sandbox.homeDir, '.gjc', 'agent', 'skills', 'user-tool', 'SKILL.md');
    await sandbox.writeShim(buildGjcShim({
      listPayload: {
        skills: [
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
          { name: 'proj-tool', description: 'project tool', path: projectSkillPath, source: 'project' },
          { name: 'user-tool', description: 'user tool', path: userSkillPath, source: 'user' },
          // A candidate without a path is untruthful and must be dropped.
          { name: 'no-path', description: 'invalid', source: 'user' },
        ],
      },
    }));

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });
    const found = bySkillName(skills);

    assert.equal(found.get('ultragoal')?.scope, 'system');
    assert.equal(found.get('ultragoal')?.sourcePath, 'embedded:gjc/skills/ultragoal/SKILL.md');
    assert.equal(found.get('proj-tool')?.scope, 'project');
    assert.equal(found.get('proj-tool')?.sourcePath, projectSkillPath);
    assert.equal(found.get('user-tool')?.scope, 'user');
    assert.equal(found.get('user-tool')?.sourcePath, userSkillPath);
    assert.equal(found.has('no-path'), false, 'untruthful path candidate must be dropped');
  } finally {
    await sandbox.restore();
  }
});

test('GJC returns skills in deterministic alphabetical order per tier', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('deterministic-order');
  try {
    const alphaPath = path.join(sandbox.homeDir, '.gjc', 'agent', 'skills', 'alpha', 'SKILL.md');
    const betaPath = path.join(sandbox.homeDir, '.gjc', 'agent', 'skills', 'beta', 'SKILL.md');
    const gammaPath = path.join(sandbox.homeDir, '.gjc', 'agent', 'skills', 'gamma', 'SKILL.md');
    await sandbox.writeShim(buildGjcShim({
      // Emit bundled skills in non-alphabetical order to prove the adapter
      // depends on the probe's deterministic sort rather than the CLI's
      // insertion order.
      listPayload: {
        skills: [
          { name: 'ralplan', description: 'ralplan', path: 'embedded:gjc/skills/ralplan/SKILL.md', source: 'bundled:default' },
          { name: 'autoresearch', description: 'autoresearch', path: 'embedded:gjc/skills/autoresearch/SKILL.md', source: 'bundled:default' },
          { name: 'ultragoal', description: 'ultragoal', path: 'embedded:gjc/skills/ultragoal/SKILL.md', source: 'bundled:default' },
        ],
      },
      discoverPayload: {
        entries: [
          { name: 'gamma', description: 'gamma', path: gammaPath, source: 'user' },
          { name: 'alpha', description: 'alpha', path: alphaPath, source: 'user' },
          { name: 'beta', description: 'beta', path: betaPath, source: 'user' },
        ],
      },
    }));

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });
    const bundledNames = skills
      .filter((skill) => skill.scope === 'system')
      .map((skill) => skill.name);
    const discoveredNames = skills
      .filter((skill) => skill.scope !== 'system')
      .map((skill) => skill.name);

    assert.deepEqual(bundledNames, ['autoresearch', 'ralplan', 'ultragoal']);
    assert.deepEqual(discoveredNames, ['alpha', 'beta', 'gamma']);
  } finally {
    await sandbox.restore();
  }
});

// ----------------------------------------------------------------------------
// Safe-failure paths: probe fails, filesystem fallback preserves GJC roots.
// ----------------------------------------------------------------------------

test('GJC falls back to its documented filesystem roots when the gjc binary is missing', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('missing-binary', { installShim: false });
  try {
    const projectSkillPath = await writeSkill(
      path.join(sandbox.workspacePath, '.gjc', 'skills'),
      'project-only',
      'project-only',
      'project only skill',
    );
    const userSkillPath = await writeSkill(
      path.join(sandbox.homeDir, '.gjc', 'agent', 'skills'),
      'user-only',
      'user-only',
      'user only skill',
    );

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });
    const found = bySkillName(skills);

    assert.equal(found.get('project-only')?.scope, 'project');
    assert.equal(found.get('project-only')?.sourcePath, projectSkillPath);
    assert.equal(found.get('project-only')?.command, '/project-only');
    assert.equal(found.get('user-only')?.scope, 'user');
    assert.equal(found.get('user-only')?.sourcePath, userSkillPath);
    assert.equal(
      skills.some((skill) => skill.scope === 'system'),
      false,
      'no bundled entries when the CLI is not installed',
    );
  } finally {
    await sandbox.restore();
  }
});

test('GJC falls back on malformed JSON output without echoing the raw payload', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('malformed-json');
  try {
    const projectSkillPath = await writeSkill(
      path.join(sandbox.workspacePath, '.gjc', 'skills'),
      'still-visible',
      'still-visible',
      'still visible after malformed probe',
    );
    await sandbox.writeShim(buildGjcShim({
      listRawStdout: '{ SECRET-BROKEN-JSON-TOKEN',
      discoverRawStdout: 'not-json-at-all SECRET-BROKEN-JSON-TOKEN',
    }));

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });
    const found = bySkillName(skills);

    assert.ok(found.get('still-visible'), 'filesystem fallback surfaces valid siblings');
    assert.equal(found.get('still-visible')?.scope, 'project');
    assert.equal(found.get('still-visible')?.sourcePath, projectSkillPath);
    assert.equal(
      skills.some((skill) => skill.scope === 'system'),
      false,
      'malformed bundled output must not surface as a bundled skill',
    );
    // The probe strips raw stdout from failure diagnostics; the provider must
    // not reintroduce the secret token anywhere in the returned skills either.
    assert.equal(
      JSON.stringify(skills).includes('SECRET-BROKEN-JSON-TOKEN'),
      false,
      'raw malformed stdout must not leak into skill entries',
    );
  } finally {
    await sandbox.restore();
  }
});

test('GJC falls back when discover output exceeds the 1 MiB probe stdout cap', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('oversized');
  try {
    await writeSkill(
      path.join(sandbox.workspacePath, '.gjc', 'skills'),
      'still-visible',
      'still-visible',
      'still visible after oversized probe',
    );
    const oversized = (1024 * 1024) + 4096;
    await sandbox.writeShim(buildGjcShim({
      listPayload: {
        skills: [
          { name: 'autoresearch', description: 'auto', path: 'embedded:gjc/skills/autoresearch/SKILL.md', source: 'bundled:default' },
        ],
      },
      // Emit >1 MiB of garbage before any JSON. The probe must abort before
      // parsing any records and the adapter must fall back.
      discoverStdoutFillBytes: oversized,
    }));

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });
    const found = bySkillName(skills);

    // Bundled path still worked because it never exceeded the cap.
    assert.equal(found.get('autoresearch')?.scope, 'system');
    // Discover failed under the cap so the filesystem fallback still surfaces
    // the project skill.
    assert.equal(found.get('still-visible')?.scope, 'project');
  } finally {
    await sandbox.restore();
  }
});

test('GJC keeps partial-valid discover records and skips the rest', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('partial-json');
  try {
    const validPath = path.join(sandbox.homeDir, '.gjc', 'agent', 'skills', 'valid-one', 'SKILL.md');
    await sandbox.writeShim(buildGjcShim({
      listPayload: { skills: [] },
      discoverPayload: {
        entries: [
          { name: 'valid-one', description: 'valid one', path: validPath, source: 'user' },
          { name: '   ', description: 'blank name', path: '/blank/SKILL.md' },
          { description: 'no name at all', path: '/nameless/SKILL.md' },
          'not-an-object',
          null,
          { name: 'no-path-here', description: 'missing path' },
        ],
      },
    }));

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });
    const names = skills.map((skill) => skill.name);

    assert.deepEqual(names, ['valid-one']);
    assert.equal(scopeOf(skills, 'valid-one'), 'user');
  } finally {
    await sandbox.restore();
  }
});

test('GJC never returns a foreign provider skill on probe failure', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('no-foreign-fallback', { installShim: false });
  try {
    // Populate every other provider's user root; GJC must ignore all of them.
    await writeSkill(
      path.join(sandbox.homeDir, '.codex', 'skills'),
      'foreign-codex',
      'foreign-codex',
      'foreign codex skill',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.claude', 'skills'),
      'foreign-claude',
      'foreign-claude',
      'foreign claude skill',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.agents', 'skills'),
      'foreign-agents',
      'foreign-agents',
      'foreign agents skill',
    );
    await writeSkill(
      path.join(sandbox.homeDir, '.omp', 'agent', 'skills'),
      'foreign-omp',
      'foreign-omp',
      'foreign omp skill',
    );

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });

    assert.deepEqual(skills, [], 'a GJC catalog without any GJC roots must be empty');
  } finally {
    await sandbox.restore();
  }
});

test('GJC returns bundled + fallback when discover uses the real CLI candidates shape', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('real-candidates-shape');
  try {
    const projectSkillPath = await writeSkill(
      path.join(sandbox.workspacePath, '.gjc', 'skills'),
      'design-interview-dir',
      'design-interview',
      'authored design interview',
    );
    await sandbox.writeShim(buildGjcShim({
      listPayload: {
        skills: [
          {
            name: 'autoresearch',
            description: 'autoresearch',
            path: 'embedded:gjc/skills/autoresearch/SKILL.md',
            source: 'bundled:default',
          },
        ],
      },
      // Real gjc's `discover --json` output shape. The probe intentionally
      // does not parse `candidates`, so it fails invalid-json and the
      // adapter must fall back to its own documented filesystem roots.
      discoverPayload: {
        candidates: [
          {
            name: 'design-interview',
            description: 'real discovery',
            source: 'user',
            path: path.join(sandbox.homeDir, '.gjc', 'agent', 'skills', 'design-interview', 'SKILL.md'),
          },
        ],
        diagnostics: [
          "skill \"auto\" found at /home/other/.codex/skills/ouroboros-auto/SKILL.md (Codex convention)",
        ],
      },
    }));

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });
    const found = bySkillName(skills);

    // Bundled parses cleanly through the probe.
    assert.equal(found.get('autoresearch')?.scope, 'system');
    // Discover fails; the filesystem fallback surfaces the workspace skill.
    assert.equal(found.get('design-interview')?.scope, 'project');
    assert.equal(found.get('design-interview')?.sourcePath, projectSkillPath);
    // Diagnostic-only Codex entries must never be imported.
    assert.equal(found.has('auto'), false, 'diagnostic-only Codex convention entry must not leak');
  } finally {
    await sandbox.restore();
  }
});

test('GJC drops shadowed and disabled discovered candidates', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('disabled-and-shadowed');
  try {
    const activePath = path.join(sandbox.homeDir, '.gjc', 'agent', 'skills', 'active', 'SKILL.md');
    const disabledPath = path.join(sandbox.homeDir, '.gjc', 'agent', 'skills', 'disabled', 'SKILL.md');
    await sandbox.writeShim(buildGjcShim({
      listPayload: {
        skills: [
          { name: 'off', description: 'disabled bundled', path: 'embedded:gjc/skills/off/SKILL.md', source: 'bundled:default', enabled: false },
        ],
      },
      discoverPayload: {
        entries: [
          { name: 'active', description: 'active', path: activePath, source: 'user' },
          { name: 'disabled', description: 'disabled', path: disabledPath, source: 'user', disabled: true },
        ],
      },
    }));

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });
    const names = new Set(skills.map((skill) => skill.name));

    assert.equal(names.has('active'), true);
    assert.equal(names.has('disabled'), false, 'discover-side disabled entry must be dropped');
    assert.equal(names.has('off'), false, 'bundled entry marked enabled:false must be dropped');
  } finally {
    await sandbox.restore();
  }
});

test('GJC returns nothing on nonzero probe exit with no filesystem candidates', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('nonzero-exit');
  try {
    await sandbox.writeShim(buildGjcShim({
      listExitCode: 3,
      listStderr: 'SECRET-STDERR-TOKEN',
      discoverExitCode: 5,
      discoverStderr: 'SECRET-STDERR-TOKEN',
    }));

    const skills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });

    assert.deepEqual(skills, [], 'nonzero exit with no fs candidates yields an empty catalog');
    assert.equal(
      JSON.stringify(skills).includes('SECRET-STDERR-TOKEN'),
      false,
      'stderr diagnostics must not leak into the returned skills',
    );
  } finally {
    await sandbox.restore();
  }
});

test('GJC rejects addSkills because the provider does not manage a global root', { concurrency: false }, async () => {
  const sandbox = await createGjcSandbox('write-unsupported', { installShim: false });
  try {
    await assert.rejects(
      providerSkillsService.addProviderSkills('gjc', {
        entries: [
          {
            directoryName: 'never-created',
            content: '---\nname: never-created\ndescription: never created\n---\n\nBody.\n',
          },
        ],
      }),
      /does not support managed global skills/i,
    );

    // The failing write must not create any filesystem artifact.
    const managedRoot = path.join(sandbox.homeDir, '.gjc', 'agent', 'skills', 'never-created');
    await assert.rejects(fs.stat(managedRoot), /ENOENT/);
  } finally {
    await sandbox.restore();
  }
});
