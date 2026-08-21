#!/usr/bin/env node

import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const evidenceRoot = path.resolve(
  process.env.CUA_EVIDENCE_DIR
    ?? path.join(repositoryRoot, '.omo', 'cua', 'latest'),
);

async function readJson(relativePath) {
  try {
    return JSON.parse(await readFile(path.join(evidenceRoot, relativePath), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function call(evidence, name) {
  return evidence?.calls?.find((entry) => entry.name === name) ?? null;
}

function requirement(id, status, evidence, detail = null) {
  return { id, status, evidence, ...(detail ? { detail } : {}) };
}

async function artifact(relativePath) {
  try {
    const details = await stat(path.join(evidenceRoot, relativePath));
    return { path: relativePath, exists: details.isFile(), bytes: details.size };
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: relativePath, exists: false, bytes: 0 };
    throw error;
  }
}

const [
  fixture,
  ui,
  interactions,
  mcp,
  setup,
  regressions,
  tailscale,
  pwa,
  osPreflight,
  stopped,
] = await Promise.all([
  readJson('fixture.json'),
  readJson('ui-scenarios.json'),
  readJson('ui-interactions.json'),
  readJson('computer-use-mcp.json'),
  readJson('window-targeting-setup/computer-use-mcp.json'),
  readJson('regressions.json'),
  readJson('tailscale-https.json'),
  readJson('pwa-environment.json'),
  readJson('os-preflight.json'),
  readJson('stopped.json'),
]);
const osRelease = Object.fromEntries(
  (await readFile('/etc/os-release', 'utf8'))
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [
        line.slice(0, separator),
        line.slice(separator + 1).replace(/^"|"$/g, ''),
      ];
    }),
);
const doctor = call(mcp, 'doctor')?.result?.structuredContent;
const getAppState = call(mcp, 'get_app_state')?.result?.structuredContent;
const listWindows = call(mcp, 'list_windows')?.result?.structuredContent;
const focusedWindow = call(mcp, 'focused_window')?.result?.structuredContent;
const screenshot = call(mcp, 'screenshot');
const setupWindowTargeting = call(setup, 'setup_window_targeting')?.result?.structuredContent;
const gnomeVersion = doctor?.platform?.gnome_shell_version?.detail
  ?? osPreflight?.current?.gnome
  ?? null;
const gnomeMajor = Number.parseInt(gnomeVersion?.match(/\d+/)?.[0] ?? '', 10);
const desktopLocked = process.env.CUA_DESKTOP_LOCKED === '1';
const expectedAgents = [
  'Oh My OpenAgent',
  'Claude Code',
  'Codex',
  'Cursor',
  'OpenCode',
  'Gajae Code',
  'Oh My Pi',
];
const actualAgents = fixture?.agents?.map((agent) => agent.displayName) ?? [];
const readiness = doctor?.readiness;
const requiredArtifacts = await Promise.all([
  'fixture.json',
  'ui-scenarios.json',
  'ui-interactions.json',
  'computer-use-mcp.json',
  'window-targeting-setup/computer-use-mcp.json',
  'desktop-chat.png',
  'desktop-cli.png',
  'mobile-chat.png',
  'mobile-agents.png',
  'desktop-interactions.png',
  'desktop-session-switch.png',
  'screenshot-0.png',
  'pane-cua-03-codex.txt',
  'os-preflight.json',
  'tailscale-https.json',
  'pwa-environment.json',
  'regressions.json',
  'stopped.json',
].map(artifact));
const artifactsComplete = requiredArtifacts.every(({ exists, bytes }) => exists && bytes > 0);
const requirements = [
  requirement(
    'isolated-seven-agent-fixture',
    JSON.stringify(actualAgents) === JSON.stringify(expectedAgents) ? 'passed' : 'failed',
    'fixture.json',
    { expectedAgents, actualAgents },
  ),
  requirement(
    'desktop-mobile-agent-and-layout-validation',
    ui?.ok ? 'passed' : ui ? 'failed' : 'not_run',
    'ui-scenarios.json',
  ),
  requirement(
    'single-pane-input-isolation',
    ui?.checks?.pane_input_isolation?.ok ? 'passed' : ui ? 'failed' : 'not_run',
    'ui-scenarios.json',
    ui?.checks?.pane_input_isolation ?? null,
  ),
  requirement(
    'chat-cli-equivalence',
    ui?.checks?.chat_cli_equivalence?.ok ? 'passed' : ui ? 'failed' : 'not_run',
    'ui-scenarios.json',
  ),
  requirement(
    'create-switch-reorder-interrupt-error',
    interactions?.ok ? 'passed' : interactions ? 'failed' : 'not_run',
    'ui-interactions.json',
    interactions?.checks ?? null,
  ),
  requirement(
    'full-regressions-and-build',
    regressions?.ok ? 'passed' : regressions ? 'failed' : 'not_run',
    'regressions.json',
    regressions?.results?.map(({ id, ok, exitCode }) => ({ id, ok, exitCode })) ?? null,
  ),
  requirement(
    'cua-mcp-atspi-and-screenshot',
    (
      mcp?.initialize?.serverInfo
      && getAppState?.backend === 'linux-atspi'
      && getAppState?.accessibility_tree_raw_count > 0
      && screenshot?.images?.length > 0
    ) ? 'passed' : mcp ? 'failed' : 'not_run',
    'computer-use-mcp.json',
    {
      server: mcp?.initialize?.serverInfo ?? null,
      toolCount: mcp?.tools?.length ?? 0,
      accessibilityNodes: getAppState?.accessibility_tree_raw_count ?? 0,
      screenshot: screenshot?.images?.[0] ?? null,
    },
  ),
  requirement(
    'evidence-artifact-integrity',
    artifactsComplete ? 'passed' : 'failed',
    'required run artifacts',
    requiredArtifacts,
  ),
  requirement(
    'ubuntu-24.04-and-gnome-46',
    osRelease.VERSION_ID === '24.04' && gnomeMajor >= 46 ? 'passed' : 'blocked',
    '/etc/os-release, os-preflight.json, and computer-use-mcp.json',
    {
      os: osRelease.PRETTY_NAME,
      gnomeVersion,
      target: osPreflight?.target ?? null,
      preflightReady: osPreflight?.readyForAuthorizedUpgrade ?? null,
      nonInteractiveSudo: osPreflight?.gates?.nonInteractiveSudo ?? null,
    },
  ),
  requirement(
    'cua-window-query-and-focus',
    readiness?.can_query_windows && readiness?.can_focus_windows ? 'passed' : 'blocked',
    'computer-use-mcp.json',
    {
      canQueryWindows: readiness?.can_query_windows ?? false,
      canFocusWindows: readiness?.can_focus_windows ?? false,
      windowCount: listWindows?.windows?.length ?? 0,
      focusedWindow: focusedWindow?.focused_window ?? null,
      setupRequiresShellReload: setupWindowTargeting?.requires_shell_reload ?? null,
    },
  ),
  requirement(
    'unlocked-desktop-cua-capture',
    desktopLocked ? 'blocked' : 'not_run',
    'screenshot-0.png and operator observation',
  ),
  requirement(
    'tailscale-https-auth',
    tailscale?.ok ? 'passed' : tailscale ? 'failed' : 'not_run',
    'tailscale-https.json',
    tailscale ? {
      baseUrl: tailscale.baseUrl,
      endpoints: tailscale.endpoints?.map(({ endpoint, ok, status }) => ({ endpoint, ok, status })),
    } : null,
  ),
  requirement(
    'installed-pwa-and-os-notifications',
    pwa?.actualEnvironmentOk ? 'passed' : pwa?.installable ? 'blocked' : pwa ? 'failed' : 'not_run',
    'pwa-environment.json',
    pwa ? {
      installable: pwa.installable,
      pwaInstalled: pwa.checks?.pwa_installed ?? false,
      notificationPermission: pwa.notifications?.permission ?? null,
      blocker: pwa.blocker ?? null,
    } : null,
  ),
];
const blocking = requirements.filter(({ status }) => status !== 'passed');
const functionalRequirementIds = new Set([
  'isolated-seven-agent-fixture',
  'desktop-mobile-agent-and-layout-validation',
  'single-pane-input-isolation',
  'chat-cli-equivalence',
  'create-switch-reorder-interrupt-error',
  'full-regressions-and-build',
  'cua-mcp-atspi-and-screenshot',
  'evidence-artifact-integrity',
  'tailscale-https-auth',
]);
const summary = {
  generatedAt: new Date().toISOString(),
  runId: fixture?.runId ?? path.basename(evidenceRoot),
  evidenceRoot,
  functionalValidationOk: requirements
    .filter(({ id }) => functionalRequirementIds.has(id))
    .every(({ status }) => status === 'passed'),
  complete: blocking.length === 0,
  stopped: stopped ?? null,
  requirements,
  blockers: blocking.map(({ id, status }) => ({ id, status })),
};
const outputPath = path.join(evidenceRoot, 'summary.json');
await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
  outputPath,
  functionalValidationOk: summary.functionalValidationOk,
  complete: summary.complete,
  blockers: summary.blockers,
}, null, 2)}\n`);
