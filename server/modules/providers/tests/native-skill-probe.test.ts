import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  NATIVE_SKILL_PROBE_ENTRY_LIMIT,
  NATIVE_SKILL_PROBE_OUTPUT_LIMIT_BYTES,
  NATIVE_SKILL_PROBE_TIMEOUT_MS,
  probeNativeSkillCatalog,
} from '@/modules/providers/shared/skills/native-skill-probe.js';
import type { LLMProvider } from '@/shared/types.js';

type Fixture = {
  root: string;
  script: (source: string) => Promise<string>;
  cleanup: () => Promise<void>;
};

let fixtureCounter = 0;

const createFixture = async (label: string): Promise<Fixture> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `native-skill-probe-${label}-`));
  return {
    root,
    script: async (source: string) => {
      fixtureCounter += 1;
      const scriptPath = path.join(root, `script-${fixtureCounter}.mjs`);
      await fs.writeFile(scriptPath, source, 'utf8');
      return scriptPath;
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
};

const emitScript = (payload: string, extra = ''): string => (
  `process.stdout.write(${JSON.stringify(payload)});\n${extra}`
);

const probe = (scriptPath: string, overrides: { provider?: LLMProvider; workspacePath: string }) => (
  probeNativeSkillCatalog({
    provider: overrides.provider ?? 'gjc',
    workspacePath: overrides.workspacePath,
    command: process.execPath,
    args: [scriptPath],
  })
);

test('native skill probe declares the documented bounds', () => {
  assert.equal(NATIVE_SKILL_PROBE_TIMEOUT_MS, 4000);
  assert.equal(NATIVE_SKILL_PROBE_OUTPUT_LIMIT_BYTES, 1024 * 1024);
  assert.equal(NATIVE_SKILL_PROBE_ENTRY_LIMIT, 500);
});

test('native skill probe normalizes valid JSON output', async () => {
  const fixture = await createFixture('valid');
  try {
    const scriptPath = await fixture.script(
      emitScript(
        JSON.stringify({
          skills: [
            {
              name: 'autoresearch',
              description: 'Bundled research skill',
              path: '/bundled/autoresearch/SKILL.md',
              scope: 'system',
              source: 'bundled',
            },
            {
              name: 'design-interview',
              path: '/home/user/.gjc/agent/skills/design-interview/SKILL.md',
              scope: 'user',
              enabled: false,
              shadowedBy: 'bundled',
              unknownField: { nested: true },
            },
          ],
        }),
      ),
    );

    const result = await probe(scriptPath, { workspacePath: fixture.root });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.truncated, false);
    assert.equal(result.skippedCount, 0);
    assert.deepEqual(result.entries, [
      {
        name: 'autoresearch',
        description: 'Bundled research skill',
        sourcePath: '/bundled/autoresearch/SKILL.md',
        scope: 'system',
        source: 'bundled',
        enabled: true,
        shadowedBy: null,
      },
      {
        name: 'design-interview',
        description: '',
        sourcePath: '/home/user/.gjc/agent/skills/design-interview/SKILL.md',
        scope: 'user',
        source: null,
        enabled: false,
        shadowedBy: 'bundled',
      },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test('native skill probe accepts a bare array payload', async () => {
  const fixture = await createFixture('array');
  try {
    const scriptPath = await fixture.script(
      emitScript(JSON.stringify([{ name: 'solo', sourcePath: '/solo/SKILL.md' }])),
    );
    const result = await probe(scriptPath, { workspacePath: fixture.root });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.entries.map((entry) => entry.name), ['solo']);
    assert.equal(result.entries[0]?.sourcePath, '/solo/SKILL.md');
  } finally {
    await fixture.cleanup();
  }
});

test('native skill probe reports a missing binary without raw output', async () => {
  const fixture = await createFixture('missing');
  try {
    const result = await probeNativeSkillCatalog({
      provider: 'gjc',
      workspacePath: fixture.root,
      command: path.join(fixture.root, 'definitely-not-installed'),
      args: ['skills', 'list', '--json'],
    });
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.failure.category, 'missing-binary');
    assert.equal(result.failure.message, 'The provider skill command is not installed.');
    assert.equal(JSON.stringify(result).includes('definitely-not-installed'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('native skill probe aborts and kills a child that outlives the timeout', async () => {
  const fixture = await createFixture('timeout');
  const pidPath = path.join(fixture.root, 'child.pid');
  try {
    const scriptPath = await fixture.script(
      `import { writeFileSync } from 'node:fs';\n`
      + `process.on('SIGTERM', () => {});\n`
      + `process.on('SIGINT', () => {});\n`
      + `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\n`
      + `setInterval(() => {}, 1000);\n`,
    );

    const startedAt = Date.now();
    const result = await probe(scriptPath, { workspacePath: fixture.root });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.failure.category, 'timeout');
    assert.ok(
      elapsedMs >= NATIVE_SKILL_PROBE_TIMEOUT_MS - 100,
      `probe returned after ${elapsedMs}ms, expected at least the ${NATIVE_SKILL_PROBE_TIMEOUT_MS}ms bound`,
    );
    assert.ok(
      elapsedMs < NATIVE_SKILL_PROBE_TIMEOUT_MS * 2,
      `probe returned after ${elapsedMs}ms, expected well below twice the timeout bound`,
    );

    const childPid = Number.parseInt(await fs.readFile(pidPath, 'utf8'), 10);
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
  } finally {
    await fixture.cleanup();
  }
});

test('native skill probe reports a nonzero exit without leaking stderr', async () => {
  const fixture = await createFixture('exit');
  try {
    const scriptPath = await fixture.script(
      `process.stderr.write('SECRET-STDERR-TOKEN /home/user/private/path');\nprocess.exit(3);\n`,
    );
    const result = await probe(scriptPath, { workspacePath: fixture.root });
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.failure.category, 'nonzero-exit');
    assert.equal(result.failure.exitCode, 3);
    assert.equal(JSON.stringify(result).includes('SECRET-STDERR-TOKEN'), false);
    assert.equal(JSON.stringify(result).includes('/home/user/private/path'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('native skill probe rejects malformed JSON without echoing it', async () => {
  const fixture = await createFixture('malformed');
  try {
    const scriptPath = await fixture.script(emitScript('{"skills": [ SECRET-BROKEN-JSON'));
    const result = await probe(scriptPath, { workspacePath: fixture.root });
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.failure.category, 'invalid-json');
    assert.equal(JSON.stringify(result).includes('SECRET-BROKEN-JSON'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('native skill probe rejects a non-list JSON payload', async () => {
  const fixture = await createFixture('shape');
  try {
    const scriptPath = await fixture.script(emitScript(JSON.stringify({ total: 2 })));
    const result = await probe(scriptPath, { workspacePath: fixture.root });
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.failure.category, 'invalid-json');
  } finally {
    await fixture.cleanup();
  }
});

test('native skill probe caps stdout and stderr independently', async () => {
  const fixture = await createFixture('caps');
  try {
    const underCapBytes = 900 * 1024;
    const overCapBytes = NATIVE_SKILL_PROBE_OUTPUT_LIMIT_BYTES + 4096;

    const bothUnderCapScript = await fixture.script(
      `const noise = 'n'.repeat(${underCapBytes});\n`
      + `process.stderr.write(noise);\n`
      + `process.stdout.write(JSON.stringify({ skills: [{ name: 'padded', description: 'x'.repeat(${underCapBytes}), path: '/padded/SKILL.md' }] }));\n`,
    );
    const bothUnderCap = await probe(bothUnderCapScript, { workspacePath: fixture.root });
    assert.equal(bothUnderCap.ok, true, 'independent caps must allow ~900 KiB on each stream');
    if (bothUnderCap.ok) {
      assert.deepEqual(bothUnderCap.entries.map((entry) => entry.name), ['padded']);
    }

    const stdoutOverCapScript = await fixture.script(
      `process.stdout.write('s'.repeat(${overCapBytes}));\n`,
    );
    const stdoutOverCap = await probe(stdoutOverCapScript, { workspacePath: fixture.root });
    assert.equal(stdoutOverCap.ok, false);
    if (!stdoutOverCap.ok) {
      assert.equal(stdoutOverCap.failure.category, 'output-too-large');
      assert.equal(stdoutOverCap.failure.stream, 'stdout');
      assert.equal(JSON.stringify(stdoutOverCap).includes('ssss'), false);
    }

    const stderrOverCapScript = await fixture.script(
      `process.stderr.write('e'.repeat(${overCapBytes}));\n`
      + `setInterval(() => {}, 1000);\n`,
    );
    const stderrOverCap = await probe(stderrOverCapScript, { workspacePath: fixture.root });
    assert.equal(stderrOverCap.ok, false);
    if (!stderrOverCap.ok) {
      assert.equal(stderrOverCap.failure.category, 'output-too-large');
      assert.equal(stderrOverCap.failure.stream, 'stderr');
      assert.equal(JSON.stringify(stderrOverCap).includes('eeee'), false);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('native skill probe caps normalized entries at 500', async () => {
  const fixture = await createFixture('cap-entries');
  try {
    const scriptPath = await fixture.script(
      `const skills = Array.from({ length: 620 }, (_, index) => ({\n`
      + `  name: 'skill-' + String(index).padStart(4, '0'),\n`
      + `  path: '/skills/' + index + '/SKILL.md',\n`
      + `}));\n`
      + `process.stdout.write(JSON.stringify({ skills }));\n`,
    );
    const result = await probe(scriptPath, { workspacePath: fixture.root });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.entries.length, NATIVE_SKILL_PROBE_ENTRY_LIMIT);
    assert.equal(result.truncated, true);
    assert.equal(result.entries[0]?.name, 'skill-0000');
    assert.equal(result.entries.at(-1)?.name, 'skill-0499');
  } finally {
    await fixture.cleanup();
  }
});

test('native skill probe drops partially invalid records and keeps valid siblings', async () => {
  const fixture = await createFixture('partial');
  try {
    const scriptPath = await fixture.script(
      emitScript(
        JSON.stringify({
          entries: [
            { name: 'valid-one', path: '/valid-one/SKILL.md' },
            { name: '   ', path: '/blank/SKILL.md' },
            { description: 'no name at all' },
            'not-an-object',
            null,
            { name: 'valid-two', description: 42, path: 17 },
          ],
        }),
      ),
    );
    const result = await probe(scriptPath, { workspacePath: fixture.root });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.entries.map((entry) => entry.name), ['valid-one', 'valid-two']);
    assert.equal(result.skippedCount, 4);
    assert.equal(result.entries[1]?.description, '');
    assert.equal(result.entries[1]?.sourcePath, null);
  } finally {
    await fixture.cleanup();
  }
});

test('native skill probe orders entries deterministically and preserves native precedence on ties', async () => {
  const fixture = await createFixture('order');
  try {
    const scriptPath = await fixture.script(
      emitScript(
        JSON.stringify({
          skills: [
            { name: 'zeta', path: '/zeta/SKILL.md', source: 'user' },
            { name: 'alpha', path: '/alpha-bundled/SKILL.md', source: 'bundled' },
            { name: 'Beta', path: '/beta/SKILL.md', source: 'bundled' },
            { name: 'alpha', path: '/alpha-user/SKILL.md', source: 'user' },
          ],
        }),
      ),
    );
    const result = await probe(scriptPath, { workspacePath: fixture.root });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(
      result.entries.map((entry) => `${entry.name}@${entry.sourcePath}`),
      [
        'alpha@/alpha-bundled/SKILL.md',
        'alpha@/alpha-user/SKILL.md',
        'Beta@/beta/SKILL.md',
        'zeta@/zeta/SKILL.md',
      ],
    );
  } finally {
    await fixture.cleanup();
  }
});

test('native skill probe single-flights identical provider and workspace requests', async () => {
  const fixture = await createFixture('single-flight');
  try {
    const invocationLogPath = path.join(fixture.root, 'invocations.log');
    const otherWorkspacePath = path.join(fixture.root, 'other-workspace');
    await fs.mkdir(otherWorkspacePath, { recursive: true });
    const scriptPath = await fixture.script(
      `import { appendFileSync } from 'node:fs';\n`
      + `appendFileSync(${JSON.stringify(invocationLogPath)}, process.pid + '\\n');\n`
      + emitScript(JSON.stringify({ skills: [{ name: 'shared', path: '/shared/SKILL.md' }] })),
    );

    const [first, second] = await Promise.all([
      probe(scriptPath, { workspacePath: fixture.root }),
      probe(scriptPath, { workspacePath: fixture.root }),
    ]);
    assert.equal(first, second, 'identical in-flight requests must share one result');
    assert.equal(first.ok, true);
    assert.equal((await fs.readFile(invocationLogPath, 'utf8')).trim().split('\n').length, 1);

    const [sameKeyAgain, otherWorkspace, otherProvider] = await Promise.all([
      probe(scriptPath, { workspacePath: fixture.root }),
      probe(scriptPath, { workspacePath: otherWorkspacePath }),
      probe(scriptPath, { provider: 'omo', workspacePath: fixture.root }),
    ]);
    assert.equal(sameKeyAgain.ok, true);
    assert.equal(otherWorkspace.ok, true);
    assert.equal(otherProvider.ok, true);
    assert.notEqual(sameKeyAgain, first, 'a settled probe must not be reused as a cache');
    assert.equal((await fs.readFile(invocationLogPath, 'utf8')).trim().split('\n').length, 4);
  } finally {
    await fixture.cleanup();
  }
});
