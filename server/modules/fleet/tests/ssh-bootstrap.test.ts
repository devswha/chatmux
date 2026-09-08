import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';

import { SSH_MINT_TOKEN_COMMAND, sshBootstrapCommand, sshBootstrapVersion } from '@/modules/fleet/services/ssh-bootstrap.js';

async function remote(context: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'chatmux-bootstrap-shell-'));
  context.after(async () => {
    try {
      assert.deepEqual((await readdir(home, { recursive: true })).filter(path => path.includes('.chatmux-fleet-ssh.')), [], 'no staging file remains');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
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
override="$HOME/.config/systemd/user/chatmux.service.d/90-chatmux-fleet-ssh.conf"
if [ -f "$override" ]; then cp "$override" "$HOME/service-override-at-install"; fi
exit "\${TEST_INSTALL_EXIT:-0}"
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

async function entryIdentity(path: string) {
  const entry = await lstat(path);
  return [entry.dev, entry.ino, entry.mode, entry.size, entry.mtimeMs, entry.ctimeMs];
}

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

test('SSH bootstrap configures the canonical peer transport and loopback bind before the installer starts its service', async (context) => {
  const subject = await remote(context);
  const result = subject.run(command());
  assert.equal(result.status, 0, result.stderr);
  const override = await readFile(join(subject.home, 'service-override-at-install'), 'utf8');
  const environment = Object.fromEntries(override.split('\n').filter(line => line.startsWith('Environment=')).map(line => {
    const assignment = line.slice('Environment='.length);
    const index = assignment.indexOf('=');
    return [assignment.slice(0, index), assignment.slice(index + 1)];
  }));
  assert.deepEqual(environment, { HOST: '127.0.0.1', CHATMUX_FLEET_TRANSPORT_MODE: 'ssh-loopback' });
  assert.equal(override.split('\n')[0], '[Service]');
  const published = await lstat(join(subject.home, '.config/systemd/user/chatmux.service.d/90-chatmux-fleet-ssh.conf'));
  assert.ok(published.isFile());
  assert.equal(published.mode & 0o777, 0o600);
  assert.equal(published.nlink, 1, 'the staging link is removed');
  assert.equal((await stat(join(subject.home, '.chatmux'))).mode & 0o777, 0o700);
});

test('SSH bootstrap never overwrites an existing service override or executes the installer after that conflict', async (context) => {
  const subject = await remote(context);
  const directory = join(subject.home, '.config/systemd/user/chatmux.service.d');
  await mkdir(directory, { recursive: true });
  const override = join(directory, '90-chatmux-fleet-ssh.conf');
  await writeFile(override, '[Service]\nEnvironment=HOST=127.0.0.2\n');
  assert.equal(subject.run(command()).status, 70);
  assert.equal(await readFile(override, 'utf8'), '[Service]\nEnvironment=HOST=127.0.0.2\n');
  assert.equal(await exists(join(subject.home, 'installed-args')), false);
});

test('SSH bootstrap refuses an existing /dev/null systemd mask without invoking the installer', async (context) => {
  const subject = await remote(context);
  const directory = join(subject.home, '.config/systemd/user/chatmux.service.d');
  await mkdir(directory, { recursive: true });
  const override = join(directory, '90-chatmux-fleet-ssh.conf');
  await symlink('/dev/null', override);
  const before = await entryIdentity(override);
  const targetBefore = await stat('/dev/null');
  const result = subject.run(command());
  assert.equal(result.error, undefined, 'the real shell completes within its bound');
  assert.deepEqual({
    status: result.status,
    installerExecuted: await exists(join(subject.home, 'installed-args')),
    linkTarget: await readlink(override),
    effectiveDropInBytes: (await readFile(override)).length,
  }, { status: 70, installerExecuted: false, linkTarget: '/dev/null', effectiveDropInBytes: 0 });
  assert.deepEqual(await entryIdentity(override), before, 'the mask entry is unchanged');
  const targetAfter = await stat('/dev/null');
  assert.deepEqual([targetAfter.dev, targetAfter.ino, targetAfter.mode, targetAfter.rdev],
    [targetBefore.dev, targetBefore.ino, targetBefore.mode, targetBefore.rdev]);
});

for (const [kind, setup] of [
  ['dangling symlink', 'ln -s "$HOME/missing" "$override"'],
  ['regular-file symlink', 'ln -s "$HOME/operator-file" "$override"'],
  ['directory symlink', 'ln -s "$HOME/operator-directory" "$override"'],
  ['FIFO', 'mkfifo "$override"'],
  ['directory', 'mkdir "$override"'],
  ['socket', ''],
] as const) {
  test(`SSH bootstrap refuses an existing ${kind} without changing its entry or target`, async (context) => {
    const subject = await remote(context);
    const directory = join(subject.home, '.config/systemd/user/chatmux.service.d');
    await mkdir(directory, { recursive: true });
    await writeFile(join(subject.home, 'operator-file'), 'untouched');
    await mkdir(join(subject.home, 'operator-directory'));
    const override = join(directory, '90-chatmux-fleet-ssh.conf');
    const created = kind === 'socket'
      ? spawnSync(process.execPath, ['-e', "require('node:net').createServer().listen('90-chatmux-fleet-ssh.conf', () => process.exit(0))"], { cwd: directory, timeout: 5_000 })
      : subject.run(`override="$HOME/.config/systemd/user/chatmux.service.d/90-chatmux-fleet-ssh.conf"; ${setup}`);
    assert.equal(created.error, undefined);
    assert.equal(created.status, 0);
    const before = await entryIdentity(override);
    const targetBefore = await entryIdentity(join(subject.home, 'operator-file'));
    const linkBefore = (await lstat(override)).isSymbolicLink() ? await readlink(override) : undefined;
    const result = subject.run(command());
    assert.equal(result.error, undefined, 'special files must not block');
    assert.equal(result.status, 70, result.stderr);
    assert.equal(await exists(join(subject.home, 'installed-args')), false);
    assert.deepEqual(await entryIdentity(override), before);
    if (linkBefore !== undefined) assert.equal(await readlink(override), linkBefore);
    assert.deepEqual(await entryIdentity(join(subject.home, 'operator-file')), targetBefore);
    assert.equal(await readFile(join(subject.home, 'operator-file'), 'utf8'), 'untouched');
    assert.deepEqual(await readdir(join(subject.home, 'operator-directory')), []);
    assert.equal(await exists(join(subject.home, 'missing')), false);
    if (kind === 'directory') assert.deepEqual(await readdir(override), []);
    assert.equal(await exists(await readFile(join(subject.home, 'download-path'), 'utf8')), false);
  });
}

for (const [event, action] of [
  ['mask conflict', '/bin/ln -s /dev/null "$target"'],
  ['directory conflict', '/bin/mkdir "$target"'],
  ['HUP', 'kill -HUP "$PPID"; exit 0'],
  ['INT', 'kill -INT "$PPID"; exit 0'],
  ['TERM', 'kill -TERM "$PPID"; exit 0'],
] as const) {
  test(`SSH bootstrap refuses a publication-boundary ${event} and removes staging`, async (context) => {
    const subject = await remote(context);
    // The seam injects the event after staging, then delegates publication to real ln.
    await writeFile(join(subject.bin, 'ln'), `#!/bin/sh
set -eu
stage= target=
for argument do stage=$target; target=$argument; done
[ -f "$stage" ] && [ ! -L "$stage" ]
cp "$stage" "$HOME/staged-config"
stat -c '%a' "$HOME/.chatmux" "$stage" > "$HOME/staged-modes"
${action}
exec /bin/ln "$@"
`, { mode: 0o700 });
    const result = subject.run(command());
    assert.equal(result.error, undefined);
    assert.equal(result.status, 70, result.stderr);
    assert.equal(await exists(join(subject.home, 'installed-args')), false);
    assert.equal(await readFile(join(subject.home, 'staged-config'), 'utf8'), '[Service]\nEnvironment=HOST=127.0.0.1\nEnvironment=CHATMUX_FLEET_TRANSPORT_MODE=ssh-loopback\n');
    assert.equal(await readFile(join(subject.home, 'staged-modes'), 'utf8'), '700\n600\n');
    const override = join(subject.home, '.config/systemd/user/chatmux.service.d/90-chatmux-fleet-ssh.conf');
    if (event === 'mask conflict') assert.equal(await readlink(override), '/dev/null');
    else if (event === 'directory conflict') assert.deepEqual(await readdir(override), []);
    else assert.equal(await exists(override), false);
    assert.equal(await exists(await readFile(join(subject.home, 'download-path'), 'utf8')), false);
  });
}

test('SSH bootstrap removes temporary files when the installer fails without deleting its claimed root or drop-in', async (context) => {
  const subject = await remote(context);
  const result = subject.run(command(), { TEST_INSTALL_EXIT: '23' });
  assert.equal(result.status, 23, result.stderr);
  assert.ok(await exists(join(subject.home, '.chatmux')));
  assert.equal(await exists(await readFile(join(subject.home, 'download-path'), 'utf8')), false);
  assert.equal(await readFile(join(subject.home, '.config/systemd/user/chatmux.service.d/90-chatmux-fleet-ssh.conf'), 'utf8'),
    await readFile(join(subject.home, 'service-override-at-install'), 'utf8'));
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
