#!/usr/bin/env node

import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.env.CUA_EVIDENCE_DIR ?? path.join(import.meta.dirname, '../..', '.cua-release-evidence'));
async function json(name) {
  try { return JSON.parse(await readFile(path.join(root, name), 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
async function artifact(name) {
  try { const value = await stat(path.join(root, name)); return { name, exists: value.isFile(), bytes: value.size }; } catch (error) {
    if (error?.code === 'ENOENT') return { name, exists: false, bytes: 0 };
    throw error;
  }
}
function requirement(id, ok, present, evidence, detail = null) {
  return { id, status: ok ? 'passed' : present ? 'failed' : 'not_run', evidence, ...(detail ? { detail } : {}) };
}
function call(report, name) { return report?.calls?.find((entry) => entry.name === name) ?? null; }

const [fixture, ui, fleet, interactions, mobile, release, regressions, mcp, pwa, desktop, gates, stopped] = await Promise.all([
  json('fixture.json'), json('ui-scenarios.json'), json('fleet-ui-scenarios.json'),
  json('ui-interactions.json'), json('mobile-interactions.json'), json('release-summary.json'), json('regressions.json'),
  json('computer-use-mcp.json'), json('pwa-environment.json'), json('isolated-desktop.json'),
  json('release-gates.json'), json('stopped.json'),
]);
const requiredNames = [
  'fixture.json', 'ui-scenarios.json', 'fleet-ui-scenarios.json', 'ui-interactions.json',
  'mobile-interactions.json', 'mobile-chromium-320-chat.png', 'mobile-chromium-390-chat.png',
  'release-summary.json', 'desktop-chat.png', 'desktop-cli.png', 'mobile-chat.png', 'mobile-agents.png',
  'desktop-interactions.png', 'desktop-session-switch.png', 'fleet-desktop-host-groups.png',
  'fleet-desktop-ax.json', 'fleet-mobile-host-groups.png', 'fleet-mobile-ax.json',
  'fleet-remote-terminal.png', 'regressions.json', 'computer-use-provision.json',
  'computer-use-mcp.json', 'screenshot-0.png', 'isolated-desktop.json',
  'pwa-notification-browser.json', 'pwa-environment.json', 'os-notification-delivered.png',
  'ci/verify-node22.json', 'ci/verify-node24.json', 'ci/bundle-node22.json',
  'focused-terminal.json', 'release-gates.json', 'stopped.json',
];
const artifacts = await Promise.all(requiredNames.map(artifact));
const artifactsOk = artifacts.every(({ exists, bytes }) => exists && bytes > 0);
const doctor = call(mcp, 'doctor')?.result?.structuredContent;
const appState = call(mcp, 'get_app_state')?.result?.structuredContent;
const windows = call(mcp, 'list_windows')?.result?.structuredContent;
const focused = call(mcp, 'focused_window')?.result?.structuredContent;
const screenshot = call(mcp, 'screenshot');
const requirements = [
  requirement('browser-release-scenarios', release?.ok === true, release !== null, 'release-summary.json', release?.requirements),
  requirement('fleet-enrollment-host-groups-collisions', fleet?.checks?.enrollment_and_host_disambiguation?.ok === true, fleet !== null, 'fleet-ui-scenarios.json'),
  requirement('local-remote-chat-terminal-actions-states-deep-links', fleet?.ok === true && ui?.ok === true, fleet !== null && ui !== null, 'ui-scenarios.json and fleet-ui-scenarios.json'),
  requirement('create-switch-reorder-interrupt-error-command-menus', interactions?.ok === true, interactions !== null, 'ui-interactions.json', interactions?.checks),
  requirement('mobile-touch-long-draft-rotation-and-pane-isolation', mobile?.ok === true && mobile?.cases?.length >= 2, mobile !== null, 'mobile-interactions.json'),
  requirement('desktop-mobile-visual-accessibility', ui?.checks?.desktop_layout?.ok === true && ui?.checks?.mobile_layout?.ok === true && fleet?.checks?.mobile_layout_and_ax?.ok === true, ui !== null && fleet !== null, 'browser screenshots and accessibility trees'),
  requirement('full-regressions-and-build', regressions?.ok === true, regressions !== null, 'regressions.json'),
  requirement('official-computer-use-task-owned-window-focus', desktop?.ok === true && doctor?.readiness?.can_query_windows === true && doctor?.readiness?.can_focus_windows === true && appState?.accessibility_tree_raw_count > 0 && windows?.windows?.length > 0 && focused?.focused_window && screenshot?.images?.length > 0, desktop !== null && mcp !== null, 'computer-use-provision.json, isolated-desktop.json, computer-use-mcp.json'),
  requirement('installed-pwa-service-worker-deep-link-notification', pwa?.actualEnvironmentOk === true, pwa !== null, 'pwa-environment.json and pwa-notification-browser.json', pwa?.checks),
  requirement('node-parity-bundle-focused-integrity-cleanup', gates?.ok === true, gates !== null, 'release-gates.json', gates?.checks),
  requirement('artifact-integrity', artifactsOk, true, 'required artifacts', artifacts),
  requirement('owned-resources-stopped', stopped?.cleanupError === null && gates?.checks?.cleanup === true, stopped !== null && gates !== null, 'stopped.json and release-gates.json'),
];
const blockers = requirements.filter(({ status }) => status !== 'passed').map(({ id, status }) => ({ id, status }));
const summary = {
  generatedAt: new Date().toISOString(),
  runId: fixture?.runId ?? path.basename(root),
  evidenceRoot: root,
  functionalValidationOk: requirements.every(({ status }) => status === 'passed'),
  complete: blockers.length === 0,
  requirements,
  blockers,
};
await writeFile(path.join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ complete: summary.complete, functionalValidationOk: summary.functionalValidationOk, blockers }, null, 2)}\n`);
if (!summary.complete || !summary.functionalValidationOk || blockers.length > 0) process.exitCode = 1;
