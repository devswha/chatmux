#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const evidence = path.resolve(process.env.CUA_EVIDENCE_DIR ?? path.join(root, '.cua-release-evidence'));
const cdpPort = Number.parseInt(process.env.CUA_CDP_PORT ?? '9333', 10);
const vitePort = Number.parseInt(process.env.CUA_VITE_PORT ?? '4310', 10);
const chromePath = process.env.CUA_CHROME_PATH ?? 'google-chrome';
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const desktopEvidenceMode = process.env.CUA_DESKTOP_EVIDENCE_MODE ?? 'isolated';
if (!['isolated', 'active'].includes(desktopEvidenceMode)) {
  throw new Error('CUA_DESKTOP_EVIDENCE_MODE must be isolated or active.');
}

function outputSignal(child, stream, marker, description) {
  return new Promise((resolve, reject) => {
    let output = '';
    const source = child[stream];
    const timeout = setTimeout(() => reject(new Error(`${description} timed out`)), 90_000);
    const inspect = (chunk) => {
      const text = chunk.toString();
      output += text;
      process[stream === 'stdout' ? 'stdout' : 'stderr'].write(text);
      if (!marker.test(output)) return;
      clearTimeout(timeout);
      source.off('data', inspect);
      child.off('exit', exited);
      resolve();
    };
    const exited = (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`${description} exited before readiness (${code ?? signal})`));
    };
    source.on('data', inspect);
    child.once('exit', exited);
  });
}

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal})`));
    });
  });
}

async function runFocusedTerminal(env) {
  const args = [
    '--import', 'tsx', '--test',
    'server/modules/fleet/tests/task-12-remote-terminal.live.test.ts',
  ];
  let output = '';
  const child = spawn(process.execPath, args, {
    cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: 'server/tsconfig.json', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', (chunk) => { output += chunk; process.stderr.write(chunk); });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  const tests = Number.parseInt(output.match(/(?:#|ℹ)\s*tests\s+(\d+)/u)?.[1] ?? '0', 10);
  const result = { ok: exitCode === 0 && tests >= 1, exitCode, tests, command: [process.execPath, ...args] };
  await writeFile(path.join(evidence, 'focused-terminal.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) throw new Error(`Focused terminal isolation was ineffective (${tests} tests, exit ${exitCode}).`);
}

async function stop(child, signal) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process ${child.pid} did not stop after ${signal}`));
    }, 15_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.kill(signal);
  });
}

await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'chatmux-cua-chrome-'));
let fixture = null;
let chrome = null;
let failure;
try {
  fixture = spawn(process.execPath, [tsxCli, '--tsconfig', 'server/tsconfig.json', 'scripts/cua/run-fixture.ts'], {
    cwd: root,
    env: {
      ...process.env,
      CUA_RUN_ID: process.env.CUA_RUN_ID ?? 'ci-release-qa',
      CUA_EVIDENCE_DIR: evidence,
      CUA_VITE_PORT: String(vitePort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixture.stderr.pipe(process.stderr);
  await outputSignal(fixture, 'stdout', /CUA_FIXTURE_READY=/, 'CUA fixture readiness');
  chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--force-renderer-accessibility',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--window-size=1600,1000',
    '--no-first-run', '--no-default-browser-check', `http://127.0.0.1:${vitePort}`,
  ], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  await outputSignal(chrome, 'stderr', /DevTools listening on/, 'Chrome DevTools readiness');
  const env = { CUA_CDP_URL: `http://127.0.0.1:${cdpPort}`, CUA_EVIDENCE_DIR: evidence };
  await run('npm', ['run', 'cua:ui:evidence'], env);
  await run('npm', ['run', 'cua:ui:interactions'], env);
} catch (error) {
  failure = error;
} finally {
  const stopped = await Promise.allSettled([stop(chrome, 'SIGTERM'), stop(fixture, 'SIGINT')]);
  const removed = await Promise.allSettled([rm(profile, { recursive: true, force: true })]);
  const cleanupErrors = [...stopped, ...removed]
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (cleanupErrors.length > 0) failure = new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupErrors], 'CUA release cleanup failed');
}
if (failure !== undefined) throw failure;

const readJson = async (name) => JSON.parse(await readFile(path.join(evidence, name), 'utf8'));
const [ui, fleetUi, interactions, stopped] = await Promise.all([
  readJson('ui-scenarios.json'), readJson('fleet-ui-scenarios.json'),
  readJson('ui-interactions.json'), readJson('stopped.json'),
]);
const artifacts = [
  'desktop-chat.png', 'desktop-cli.png', 'mobile-chat.png', 'mobile-agents.png',
  'fleet-desktop-host-groups.png', 'fleet-desktop-ax.json', 'fleet-remote-terminal.png',
  'fleet-mobile-host-groups.png', 'fleet-mobile-ax.json', 'desktop-interactions.png',
  'desktop-session-switch.png',
];
const artifactResults = await Promise.all(artifacts.map(async (name) => ({
  name, bytes: (await stat(path.join(evidence, name))).size,
})));
const requirements = {
  enrollmentHostGroupsAndDuplicateSessions: fleetUi.checks.enrollment_and_host_disambiguation.ok,
  localChatAndTerminal: ui.checks.chat_cli_equivalence.ok && ui.checks.pane_input_isolation.ok,
  remoteChatTerminalAndActions: fleetUi.checks.remote_chat.ok
    && fleetUi.checks.remote_terminal_attach.ok && fleetUi.checks.remote_pane_action.ok,
  notificationsAndDeepLinks: fleetUi.checks.notification_deep_link.ok
    && fleetUi.checks.remote_deep_link.ok,
  offlineResyncIncompatibleUnknownOutcome: fleetUi.checks.offline_fail_closed.ok
    && fleetUi.checks.resync_and_recovery.ok && fleetUi.checks.incompatible_fail_closed.ok
    && fleetUi.checks.unknown_outcome_visible.ok,
  refreshCreateSwitchReorderInterruptError: interactions.ok,
  desktopMobileVisualAndAccessibility: ui.checks.desktop_layout.ok
    && ui.checks.mobile_layout.ok && fleetUi.checks.mobile_layout_and_ax.ok,
  ownedResourcesStopped: stopped.cleanupError === null,
  artifactsComplete: artifactResults.every(({ bytes }) => bytes > 0),
};
const summary = {
  generatedAt: new Date().toISOString(), node: process.version,
  ok: Object.values(requirements).every(Boolean), requirements, artifacts: artifactResults, stopped,
};
await writeFile(path.join(evidence, 'release-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
if (!summary.ok) throw new Error('Fleet browser release summary is incomplete.');

const postFailures = [];
const postStages = [
  ['focused terminal isolation', () => runFocusedTerminal({ CUA_EVIDENCE_DIR: evidence })],
  ['full regressions', () => run('npm', ['run', 'cua:regressions'], { CUA_EVIDENCE_DIR: evidence })],
  [`${desktopEvidenceMode} Computer Use and installed PWA`, () => run('bash', [
    desktopEvidenceMode === 'active'
      ? 'scripts/cua/run-active-desktop.sh'
      : 'scripts/cua/run-isolated-desktop.sh',
  ], {
    CUA_EVIDENCE_DIR: evidence,
  })],
  ['release integrity', () => run(process.execPath, ['scripts/cua/collect-release-gates.mjs'], { CUA_EVIDENCE_DIR: evidence })],
  ['aggregate summary', () => run('npm', ['run', 'cua:summary'], { CUA_EVIDENCE_DIR: evidence })],
];
for (const [name, execute] of postStages) {
  try { await execute(); } catch (error) { postFailures.push(new Error(`${name} failed`, { cause: error })); }
}
if (postFailures.length > 0) throw new AggregateError(postFailures, 'Fleet release evidence is incomplete.');
