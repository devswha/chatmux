import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import type {
  LLMProvider,
  ProviderSkill,
  ProviderSkillScope,
} from '@/shared/types.js';

/**
 * Hermetic seven-provider native-skill contract fixture (plan Task 1, RED stage).
 *
 * This file locks the machine-consumable contract for every provider skill
 * adapter: source order, collision key, toggles, command syntax, scope mapping,
 * fallback, and managed write/list visibility. It deliberately reproduces two
 * current defects as failing assertions - OMO must reject a Codex-only home and
 * GJC must surface its bundled/discovered native inventory - while the other
 * five providers are characterized against their existing behavior without
 * changing product code. Only machine values (commands, scopes, presence) are
 * asserted; no natural-language description is pinned.
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

const makeSandbox = async (label: string): Promise<{
  homeDir: string;
  workspacePath: string;
  restore: () => Promise<void>;
}> => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `provider-native-${label}-`));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  return {
    homeDir: tempRoot,
    workspacePath,
    restore: async () => {
      restoreHomeDir();
      await fs.rm(tempRoot, { recursive: true, force: true });
    },
  };
};

const byName = (skills: ProviderSkill[]): Map<string, ProviderSkill> =>
  new Map(skills.map((skill) => [skill.name, skill]));

/**
 * Per-provider native contract row. Every value here is machine-consumed:
 * command prefixes, scope mapping, and the managed write/list visibility flag
 * are compared against the running adapter, never printed as documentation.
 */
type ProviderContract = {
  provider: LLMProvider;
  /** Exact command produced for a bare skill named `sample`. */
  sampleCommand: string;
  /** Directory (under workspace) whose skills map to a project/repo scope. */
  projectSkillDir: string[];
  /** Scope the adapter assigns to that project directory. */
  projectScope: ProviderSkillScope;
  /** Directory (under home) whose skills map to a user scope. */
  userSkillDir: string[];
  /** Scope the adapter assigns to that user directory. */
  userScope: ProviderSkillScope;
  /** True when project source order wins a same-name collision over user. */
  projectWinsCollision: boolean;
  /** True when addProviderSkills round-trips to a visible managed skill. */
  managedWriteVisible: boolean;
};

const PROVIDER_CONTRACTS: Record<LLMProvider, ProviderContract> = {
  claude: {
    provider: 'claude',
    sampleCommand: '/sample',
    projectSkillDir: ['.claude', 'skills'],
    projectScope: 'project',
    userSkillDir: ['.claude', 'skills'],
    userScope: 'user',
    projectWinsCollision: false, // user source is listed before project
    managedWriteVisible: true,
  },
  codex: {
    provider: 'codex',
    sampleCommand: '$sample',
    projectSkillDir: ['.agents', 'skills'],
    projectScope: 'repo',
    userSkillDir: ['.agents', 'skills'],
    userScope: 'user',
    projectWinsCollision: true, // repo source is listed before user
    managedWriteVisible: true,
  },
  cursor: {
    provider: 'cursor',
    sampleCommand: '/sample',
    projectSkillDir: ['.cursor', 'skills'],
    projectScope: 'project',
    userSkillDir: ['.cursor', 'skills'],
    userScope: 'user',
    projectWinsCollision: true,
    managedWriteVisible: true,
  },
  opencode: {
    provider: 'opencode',
    sampleCommand: '/sample',
    projectSkillDir: ['.opencode', 'skills'],
    projectScope: 'project',
    userSkillDir: ['.config', 'opencode', 'skills'],
    userScope: 'user',
    projectWinsCollision: true,
    managedWriteVisible: false, // opencode reuses foreign roots; no managed write
  },
  omp: {
    provider: 'omp',
    sampleCommand: '/skill:sample',
    projectSkillDir: ['.omp', 'skills'],
    projectScope: 'project',
    userSkillDir: ['.omp', 'agent', 'skills'],
    userScope: 'user',
    projectWinsCollision: true,
    managedWriteVisible: true,
  },
  omo: {
    provider: 'omo',
    sampleCommand: '/skill:sample',
    projectSkillDir: ['.omo', 'skills'],
    projectScope: 'project',
    userSkillDir: ['.omo', 'agent', 'skills'],
    userScope: 'user',
    projectWinsCollision: true,
    managedWriteVisible: true,
  },
  gjc: {
    provider: 'gjc',
    sampleCommand: '/sample',
    projectSkillDir: ['.gjc', 'skills'],
    projectScope: 'project',
    userSkillDir: ['.gjc', 'agent', 'skills'],
    userScope: 'user',
    projectWinsCollision: true,
    managedWriteVisible: false, // no native bundled inventory today (defect below)
  },
};

const ALL_PROVIDERS: LLMProvider[] = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'omp',
  'omo',
  'gjc',
];

test('the native-skill contract covers all seven provider IDs', () => {
  assert.deepEqual(
    Object.keys(PROVIDER_CONTRACTS).sort(),
    [...ALL_PROVIDERS].sort(),
  );
  for (const provider of ALL_PROVIDERS) {
    const contract = PROVIDER_CONTRACTS[provider];
    assert.equal(contract.provider, provider);
    assert.match(contract.sampleCommand, /^(\/|\$|\/skill:)sample$/);
    assert.ok(contract.projectSkillDir.length > 0);
    assert.ok(contract.userSkillDir.length > 0);
  }
});

/**
 * Characterization: command syntax + scope mapping for each provider's project
 * and user skill directories. This runs for all seven IDs and documents the
 * current, non-defective portions of every adapter.
 */
for (const provider of ALL_PROVIDERS) {
  const contract = PROVIDER_CONTRACTS[provider];

  test(`${provider}: command syntax and scope mapping`, { concurrency: false }, async () => {
    const sandbox = await makeSandbox(`${provider}-scope`);
    try {
      await writeSkill(
        path.join(sandbox.workspacePath, ...contract.projectSkillDir),
        'project-sample-dir',
        'project-sample',
        'project sample',
      );
      await writeSkill(
        path.join(sandbox.homeDir, ...contract.userSkillDir),
        'user-sample-dir',
        'user-sample',
        'user sample',
      );

      const skills = await providerSkillsService.listProviderSkills(provider, {
        workspacePath: sandbox.workspacePath,
      });
      const found = byName(skills);

      const projectSkill = found.get('project-sample');
      assert.ok(projectSkill, `${provider} must list its project-scoped skill`);
      assert.equal(projectSkill.scope, contract.projectScope);
      assert.equal(
        projectSkill.command,
        contract.sampleCommand.replace('sample', 'project-sample'),
      );

      const userSkill = found.get('user-sample');
      assert.ok(userSkill, `${provider} must list its user-scoped skill`);
      assert.equal(userSkill.scope, contract.userScope);
    } finally {
      await sandbox.restore();
    }
  });
}

/**
 * Characterization: same-name collision precedence follows source order and the
 * command-key dedupe. Only providers whose project and user tiers use distinct
 * directories can express this cleanly, so claude (shared `.claude/skills`) is
 * excluded from the collision row.
 */
for (const provider of ALL_PROVIDERS.filter((id) => id !== 'claude')) {
  const contract = PROVIDER_CONTRACTS[provider];

  test(`${provider}: same-name collision resolves by source order`, { concurrency: false }, async () => {
    const sandbox = await makeSandbox(`${provider}-collide`);
    try {
      await writeSkill(
        path.join(sandbox.workspacePath, ...contract.projectSkillDir),
        'dup-project-dir',
        'dup',
        'project variant',
      );
      await writeSkill(
        path.join(sandbox.homeDir, ...contract.userSkillDir),
        'dup-user-dir',
        'dup',
        'user variant',
      );

      const skills = await providerSkillsService.listProviderSkills(provider, {
        workspacePath: sandbox.workspacePath,
      });
      const dupWinners = skills.filter((skill) => skill.name === 'dup');
      assert.equal(dupWinners.length, 1, `${provider} must dedupe same-name skills by command`);
      assert.equal(
        dupWinners[0]?.scope,
        contract.projectWinsCollision ? contract.projectScope : contract.userScope,
      );
    } finally {
      await sandbox.restore();
    }
  });
}

/**
 * Characterization: managed write/list visibility. Writable providers round-trip
 * add -> list -> remove; reuse-only providers reject managed writes before
 * mutating anything.
 */
for (const provider of ALL_PROVIDERS) {
  const contract = PROVIDER_CONTRACTS[provider];

  test(`${provider}: managed write/list visibility`, { concurrency: false }, async () => {
    const sandbox = await makeSandbox(`${provider}-write`);
    try {
      if (!contract.managedWriteVisible) {
        await assert.rejects(
          providerSkillsService.addProviderSkills(provider, {
            entries: [
              {
                directoryName: 'unsupported-dir',
                content: '---\nname: unsupported\ndescription: unsupported\n---\n\nBody.\n',
              },
            ],
          }),
          /does not support managed global skills/i,
        );
        return;
      }

      const created = await providerSkillsService.addProviderSkills(provider, {
        entries: [
          {
            directoryName: 'managed-sample-dir',
            content: '---\nname: managed-sample\ndescription: managed sample\n---\n\nBody.\n',
          },
        ],
      });
      assert.equal(created.length, 1);
      assert.equal(
        created[0]?.command,
        contract.sampleCommand.replace('sample', 'managed-sample'),
      );

      const listed = await providerSkillsService.listProviderSkills(provider);
      assert.equal(
        listed.some((skill) => skill.name === 'managed-sample'),
        true,
        `${provider} managed skill must be visible after write`,
      );

      const removed = await providerSkillsService.removeProviderSkill(provider, {
        directoryName: 'managed-sample-dir',
      });
      assert.equal(removed.removed, true);
    } finally {
      await sandbox.restore();
    }
  });
}

/**
 * RED defect #1 - OMO must fail closed on a Codex-only home.
 *
 * OMO currently borrows `~/.codex/skills` (and `~/.claude/skills`) as user
 * sources, so a home that only contains a foreign Codex skill leaks it into the
 * OMO catalog. The native contract requires zero OMO skills here. This assertion
 * fails until OMO stops importing undeclared foreign sources.
 */
test('OMO rejects a Codex-only home (RED: foreign-source leakage)', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('omo-codex-only');
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = '';
    await writeSkill(
      path.join(sandbox.homeDir, '.codex', 'skills'),
      'foreign-codex-dir',
      'foreign-codex',
      'foreign codex skill',
    );

    const omoSkills = await providerSkillsService.listProviderSkills('omo', {
      workspacePath: sandbox.workspacePath,
    });

    assert.equal(
      omoSkills.some((skill) => skill.name === 'foreign-codex'),
      false,
      'OMO must not import ~/.codex/skills',
    );
    assert.equal(
      omoSkills.length,
      0,
      'OMO must return no skills when only a foreign Codex home exists',
    );
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await sandbox.restore();
  }
});

/**
 * RED defect #2 - GJC must surface its native bundled/discovered inventory.
 *
 * GJC currently only scans `.gjc/skills` on disk and never consults the native
 * `gjc skills list --json` (bundled) or `gjc skills discover --json`
 * (effective) inventories. A workspace with a custom discovered skill must also
 * expose the bundled `autoresearch` skill. This assertion fails until GJC unions
 * its native inventories with the filesystem candidates.
 */
test('GJC includes bundled/discovered native inventory (RED: missing native union)', { concurrency: false }, async () => {
  const sandbox = await makeSandbox('gjc-native-inventory');
  try {
    // A discovered custom skill on disk - GJC already surfaces this today.
    await writeSkill(
      path.join(sandbox.workspacePath, '.gjc', 'skills'),
      'design-interview-dir',
      'design-interview',
      'discovered custom skill',
    );

    const gjcSkills = await providerSkillsService.listProviderSkills('gjc', {
      workspacePath: sandbox.workspacePath,
    });
    const names = new Set(gjcSkills.map((skill) => skill.name));

    // Discovered filesystem candidate is present (characterizes current behavior).
    assert.equal(names.has('design-interview'), true, 'GJC must keep discovered custom skills');
    // Native bundled inventory must also be part of the effective union.
    assert.equal(
      names.has('autoresearch'),
      true,
      'GJC must include bundled native inventory (gjc skills list --json)',
    );
  } finally {
    await sandbox.restore();
  }
});
