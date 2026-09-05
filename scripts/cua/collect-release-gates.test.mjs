import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('CUA source integrity accepts committed hook changes and rejects uncommitted mutations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatmux-cua-source-integrity-'));
  const evidence = path.join(root, 'evidence');
  const run = (command, args, env = {}) => spawnSync(command, args, {
    cwd: root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...env },
  });
  const git = (...args) => {
    const result = run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=CUA Test', '-c', 'user.email=cua@example.invalid', ...args]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    await mkdir(path.join(root, 'scripts/cua'), { recursive: true });
    await mkdir(path.join(root, 'src/components/chat/hooks'), { recursive: true });
    await mkdir(path.join(evidence, 'ci'), { recursive: true });
    await copyFile(new URL('./collect-release-gates.mjs', import.meta.url), path.join(root, 'scripts/cua/collect-release-gates.mjs'));
    await writeFile(path.join(root, '.gitignore'), 'evidence/\n');
    const hook = path.join(root, 'src/components/chat/hooks/useChatComposerState.ts');
    await writeFile(hook, 'export const fixture = "approved composer revision";\n');
    await writeFile(path.join(root, 'src/components/chat/hooks/useChatSessionState.ts'), 'export const fixture = "approved session revision";\n');
    git('init', '--quiet');
    git('add', '.');
    git('commit', '--quiet', '-m', 'Fixture source');
    const commit = git('rev-parse', 'HEAD');
    const fixtures = {
      'ci/verify-node22.json': { ok: true, exitCode: 0, node: 'v22.22.2' },
      'ci/verify-node24.json': { ok: true, exitCode: 0, node: 'v24.15.0' },
      'ci/bundle-node22.json': { ok: true, exitCode: 0, bytes: 1, sha256: 'a'.repeat(64) },
      'focused-terminal.json': { ok: true, tests: 1 },
      'stopped.json': { cleanupError: null },
    };
    for (const [name, value] of Object.entries(fixtures)) {
      await writeFile(path.join(evidence, name), JSON.stringify(value));
    }
    const collect = async () => {
      const result = run(process.execPath, ['scripts/cua/collect-release-gates.mjs'], {
        CUA_EVIDENCE_DIR: evidence, CUA_VITE_PORT: '0', CUA_CDP_PORT: '0',
      });
      assert.equal(result.error, undefined, result.stderr);
      return { result, report: JSON.parse(await readFile(path.join(evidence, 'release-gates.json'), 'utf8')) };
    };
    const approved = await collect();
    assert.equal(approved.result.status, 0, approved.result.stderr || approved.result.stdout);
    assert.equal(approved.report.checks.protectedHooks, true);
    assert.equal(approved.report.protectedHooks.referenceCommit, commit);

    await writeFile(hook, 'export const fixture = "unexpected harness mutation";\n');
    const modified = await collect();
    assert.equal(modified.result.status, 1);
    assert.equal(modified.report.checks.protectedHooks, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
