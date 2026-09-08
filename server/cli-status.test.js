import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
const source = await fs.access(new URL('./install-cli.ts', import.meta.url)).then(() => true, () => false);

// Exercise the real CLI, but never the operator's service manager, environment,
// network interfaces, or HOME. The managed PID has a real launch environment;
// systemctl is the only simulated service-manager boundary.
async function statusFixture(t, { managed = true, host = '127.0.0.1', auth = 'password', port = '3001', systemctlFailure = false, stopped = false, shellHost = '0.0.0.0', allowUnauthRemote = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmux-status-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  await fs.mkdir(bin);
  const config = path.join(home, 'chatmux.env');
  await fs.writeFile(config, 'CHATMUX_AUTH=password\nSERVER_PORT=3001\n');
  const preload = path.join(home, 'interfaces.mjs');
  await fs.writeFile(preload, `import os from 'node:os';
os.networkInterfaces = () => ({
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [{ address: '10.0.2.15', family: 'IPv4', internal: false }],
  tailscale0: [{ address: '100.64.0.7', family: 'IPv4', internal: false }],
  docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
});\n`);
  const childEnvironment = {
    HOME: home, PATH: bin, CHATMUX_ENV_FILE: config,
    TSX_TSCONFIG_PATH: fileURLToPath(new URL('./tsconfig.json', import.meta.url)),
    CHATMUX_AUTH: 'password', SERVER_PORT: '3001',
    ...(shellHost === undefined ? {} : { HOST: shellHost }),
  };
  if (managed) {
    const unitDirectory = path.join(home, '.config/systemd/user');
    await fs.mkdir(path.join(unitDirectory, 'chatmux.service.d'), { recursive: true });
    await fs.writeFile(path.join(unitDirectory, 'chatmux.service'), '[Service]\nEnvironment=HOST=0.0.0.0\n');
    await fs.writeFile(path.join(unitDirectory, 'chatmux.service.d/90-chatmux-fleet-ssh.conf'), '[Service]\nEnvironment=HOST=127.0.0.1\nEnvironment=CHATMUX_FLEET_TRANSPORT_MODE=ssh-loopback\n');
    const target = path.join(home, 'managed.cjs');
    await fs.writeFile(target, "process.send('ready'); process.on('message', () => process.exit(0));\n");
    const child = fork(target, [], {
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        HOME: home, CHATMUX_AUTH: auth, SERVER_PORT: port,
        ...(host === null ? {} : { HOST: host }),
        CHATMUX_ALLOW_UNAUTH_REMOTE: allowUnauthRemote ? '1' : '0',
        PRIVATE_STATUS_TEST_SECRET: 'never-print-this-value',
      },
    });
    t.after(async () => {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.send('stop');
      await exited;
    });
    await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    await fs.writeFile(path.join(bin, 'systemctl'), `#!${process.execPath}
const expected = ['--user', 'show', 'chatmux.service', '--property=MainPID', '--value'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(90);
${systemctlFailure ? "process.stderr.write('private service failure never-print-this-value'); process.exit(1);" : `console.log(${stopped ? 0 : child.pid});`}
`, { mode: 0o700 });
  } else {
    // Even accidental unmanaged queries cannot reach the host systemctl.
    await fs.writeFile(path.join(bin, 'systemctl'), `#!${process.execPath}\nprocess.exit(91);\n`, { mode: 0o700 });
  }
  await fs.writeFile(path.join(bin, 'tailscale'), `#!${process.execPath}
console.log('https://peer.example.ts.net:8443 (tailnet only)\\n|-- / proxy http://127.0.0.1:3001');
`, { mode: 0o700 });
  const { stdout, stderr } = await execute(process.execPath, [
    ...(source ? ['--import', 'tsx'] : []), '--import', preload, cli, 'status',
  ], { env: childEnvironment, timeout: 15000 });
  assert.equal(stderr, '');
  assert.ok(!stdout.includes('never-print-this-value'));
  return [...stdout.matchAll(/https?:\/\/[^\s\x1b)]+/g)].map(([url]) => new URL(url).href);
}

test('status password URLs follow the running managed SSH override, not the wildcard base unit or CLI HOST', async (t) => {
  assert.deepEqual(await statusFixture(t), ['http://127.0.0.1:3001/']);
});

test('status preserves wildcard password addresses and hides container interfaces', async (t) => {
  assert.deepEqual(await statusFixture(t, { host: '0.0.0.0', shellHost: '127.0.0.1' }), [
    'http://127.0.0.1:3001/', 'http://10.0.2.15:3001/', 'http://100.64.0.7:3001/',
  ]);
});

test('status follows the launch environment (including EnvironmentFile overrides), port and auth rather than file text', async (t) => {
  assert.deepEqual(await statusFixture(t, { host: '10.20.0.1', port: '4321', auth: 'none', allowUnauthRemote: true }), ['http://10.20.0.1:4321/']);
});

test('status specific password binds do not invent a loopback or other interface URL', async (t) => {
  for (const host of ['10.0.2.15', '127.0.0.2', '::1']) {
    await t.test(host, async (t) => {
      assert.deepEqual(await statusFixture(t, { host }), [`http://${host.includes(':') ? `[${host}]` : host}:3001/`]);
    });
  }
});

test('status preserves Tailscale Serve URLs without publishing backend interfaces', async (t) => {
  assert.deepEqual(await statusFixture(t, { auth: 'tailscale' }), ['https://peer.example.ts.net:8443/']);
});

test('status never guesses URLs from CLI HOST when managed binding is unknown', async (t) => {
  for (const options of [{ systemctlFailure: true }, { stopped: true }, { host: null }]) {
    await t.test(JSON.stringify(options), async (t) => {
      assert.deepEqual(await statusFixture(t, options), []);
    });
  }
});

test('unmanaged status honors HOST and the server loopback default', async (t) => {
  assert.deepEqual(await statusFixture(t, { managed: false, shellHost: '127.0.0.2' }), ['http://127.0.0.2:3001/']);
  assert.deepEqual(await statusFixture(t, { managed: false, shellHost: '' }), ['http://127.0.0.1:3001/']);
});
