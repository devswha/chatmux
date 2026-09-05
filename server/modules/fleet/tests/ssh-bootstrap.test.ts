import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';

import { SSH_MINT_TOKEN_COMMAND, sshBootstrapCommand, sshBootstrapVersion } from '@/modules/fleet/services/ssh-bootstrap.js';

async function remote(context: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'chatmux-bootstrap-shell-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) printf Linux;; -m) printf x86_64;; esac\n', { mode: 0o700 });
  const curl = `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/curl-args"
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; output=$1; fi
  shift
done
printf '%s' "$output" > "$HOME/download-path"
[ "\${TEST_FETCH_FAIL:-}" != yes ] || exit 23
if [ "\${TEST_RACE:-}" = yes ]; then mkdir "$HOME/.chatmux"; printf untouched > "$HOME/.chatmux/owner-data"; fi
cat > "$output" <<'INSTALLER'
#!/bin/sh
printf '%s\\n' "$CHATMUX_VERSION" "$CHATMUX_REPOSITORY" "$CHATMUX_INSTALL_ROOT" "$@" > "$HOME/installed-args"
printf '%s' "\${CHATMUX_NODE-unset}:\${CHATMUX_NODE_BASE_URL-unset}:\${CHATMUX_RELEASE_BASE_URL-unset}" > "$HOME/overrides"
INSTALLER
`;
  await writeFile(join(bin, 'curl'), curl, { mode: 0o700 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: home };
  const run = (command: string, extra: Record<string, string> = {}) => spawnSync('/bin/sh', ['-c', command], {
    env: { ...env, ...extra }, encoding: 'utf8', timeout: 5_000,
  });
  return { home, bin, run };
}

function command(): string {
  const value = sshBootstrapCommand('1.9.1'); assert.ok(value); return value;
}

async function exists(path: string): Promise<boolean> { return stat(path).then(() => true, () => false); }

test('the actual shell command pins canonical artifacts, clears overrides and requests port 3001', async (context) => {
  const subject = await remote(context);
  const result = subject.run(command(), {
    CHATMUX_VERSION: '9.9.9', CHATMUX_REPOSITORY: 'https://invalid.example', CHATMUX_INSTALL_ROOT: '/do-not-use',
    CHATMUX_NODE: '/untrusted/node', CHATMUX_NODE_BASE_URL: 'http://invalid.example', CHATMUX_RELEASE_BASE_URL: 'http://invalid.example',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readFile(join(subject.home, 'installed-args'), 'utf8')).trim().split('\n'), [
    '1.9.1', 'https://github.com/devswha/chatmux', join(subject.home, '.chatmux'), '--port', '3001',
  ]);
  assert.equal(await readFile(join(subject.home, 'overrides'), 'utf8'), 'unset:unset:unset');
  const args = (await readFile(join(subject.home, 'curl-args'), 'utf8')).trim().split('\n');
  assert.ok(args.includes('https://github.com/devswha/chatmux/releases/download/v1.9.1/install.sh'));
  assert.equal(args[args.indexOf('--proto') + 1], '=https');
  assert.equal(args[args.indexOf('--proto-redir') + 1], '=https');
  assert.equal(args[args.indexOf('--max-time') + 1], '120');
  assert.equal(await exists(await readFile(join(subject.home, 'download-path'), 'utf8')), false, 'downloaded script is removed');
});

test('an existing managed root or broken wrapper prevents both bootstrap and a missing-CLI marker', async (context) => {
  for (const kind of ['directory', 'root-symlink', 'wrapper-symlink', 'broken-wrapper']) {
    const subject = await remote(context);
    if (kind === 'directory') await mkdir(join(subject.home, '.chatmux'));
    else if (kind === 'root-symlink') await symlink(join(subject.home, 'missing'), join(subject.home, '.chatmux'));
    else {
      await mkdir(join(subject.home, '.local/bin'), { recursive: true });
      const wrapper = join(subject.home, '.local/bin/chatmux');
      if (kind === 'wrapper-symlink') await symlink(join(subject.home, 'missing'), wrapper);
      else await writeFile(wrapper, 'incomplete', { mode: 0o600 });
    }
    assert.equal(subject.run(command()).status, 70, kind);
    assert.equal(await exists(join(subject.home, 'curl-args')), false, kind);
    const mint = subject.run(SSH_MINT_TOKEN_COMMAND);
    assert.equal(mint.status, 126, kind);
    assert.doesNotMatch(mint.stderr, /chatmux-fleet-cli-missing/, kind);
  }
});

test('an installation appearing during download is preserved and the installer never executes', async (context) => {
  const subject = await remote(context);
  assert.equal(subject.run(command(), { TEST_RACE: 'yes' }).status, 70);
  assert.equal(await readFile(join(subject.home, '.chatmux/owner-data'), 'utf8'), 'untouched');
  assert.equal(await exists(join(subject.home, 'installed-args')), false);
  assert.equal(await exists(await readFile(join(subject.home, 'download-path'), 'utf8')), false);
});

test('an install root claimed at the action boundary prevents a concurrent bootstrap', async (context) => {
  const subject = await remote(context);
  await writeFile(join(subject.bin, 'mkdir'), '#!/bin/sh\n/bin/mkdir -m 700 "$HOME/.chatmux"\nprintf concurrent > "$HOME/.chatmux/owner-data"\nexec /bin/mkdir "$@"\n', { mode: 0o700 });
  assert.equal(subject.run(command()).status, 70);
  assert.equal(await readFile(join(subject.home, '.chatmux/owner-data'), 'utf8'), 'concurrent');
  assert.equal(await exists(join(subject.home, 'installed-args')), false);
});

test('a failed download never executes its partial file and an unsupported OS never downloads', async (context) => {
  const subject = await remote(context);
  assert.equal(subject.run(command(), { TEST_FETCH_FAIL: 'yes' }).status, 70);
  assert.equal(await exists(join(subject.home, 'installed-args')), false);
  assert.equal(await exists(await readFile(join(subject.home, 'download-path'), 'utf8')), false);
  const unsupported = await remote(context);
  await writeFile(join(unsupported.bin, 'uname'), '#!/bin/sh\nprintf Darwin\n', { mode: 0o700 });
  assert.equal(unsupported.run(command()).status, 70);
  assert.equal(await exists(join(unsupported.home, 'curl-args')), false);
});

test('missing, prerelease and command-like versions cannot create an installation command', async () => {
  for (const version of [undefined, '', 'v1.9.1', '1.9.1-beta', '1.9.1;id', '01.9.1', '1.9.1\n']) {
    assert.equal(sshBootstrapCommand(version), undefined, String(version));
  }
  assert.ok(sshBootstrapCommand(await sshBootstrapVersion()), 'the running package version resolves through source/runtime app-root handling');
});
