import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
const stripAnsi = (value: string) => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');

function status(environment: Record<string, string>): string {
  const result = spawnSync(process.execPath, [cli, 'status'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CHATMUX_AUTH: '',
      CHATMUX_ALLOW_UNAUTH_REMOTE: '',
      CHATMUX_ENV_FILE: '/nonexistent/chatmux-status-test.env',
      ...environment,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return stripAnsi(result.stdout);
}

test('chatmux status redacts Herdr configuration values, including malformed input', () => {
  const alias = 'private-source-alias';
  const selector = 'private-selector';
  const binary = '/private/herdr/bin/herdr';
  const policy = '/private/herdr/policy.json';
  const output = status({
    CHATMUX_HERDR_RUNTIME: '1',
    CHATMUX_HERDR_SOURCES: JSON.stringify([{ alias, selector, binary }]),
    CHATMUX_HERDR_CAPABILITIES: 'discovery,output,actions,attach',
    CHATMUX_HERDR_POLICY_FILE: policy,
  });

  assert.match(output, /Herdr Runtime:/);
  assert.match(output, /Configuration: enabled/);
  assert.match(output, /Configured Sources: 1/);
  assert.match(output, /Capabilities: discovery, output, actions, attach/);
  assert.match(output, /Policy: configured/);
  for (const secret of [alias, selector, binary, policy]) assert.equal(output.includes(secret), false);
  assert.match(output, /Runtime Readiness: not probed by this command/);

  const malformed = 'malformed-herdr-source-secret';
  const malformedOutput = status({
    CHATMUX_HERDR_RUNTIME: '1',
    CHATMUX_HERDR_SOURCES: `{\"alias\":\"${malformed}\"}`,
    CHATMUX_HERDR_CAPABILITIES: 'discovery',
  });
  assert.match(malformedOutput, /Configuration: disabled/);
  assert.match(malformedOutput, /Configured Sources: 0/);
  assert.equal(malformedOutput.includes(malformed), false);
});
