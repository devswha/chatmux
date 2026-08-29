#!/usr/bin/env node

import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const evidence = path.resolve(process.env.CUA_EVIDENCE_DIR);
const chromePid = Number.parseInt(process.env.CUA_ACTIVE_CHROME_PID, 10);
if (!Number.isInteger(chromePid) || chromePid <= 0) {
  throw new Error('CUA_ACTIVE_CHROME_PID must identify the task-owned Chrome process.');
}

const notificationPath = path.join(evidence, 'os-notification-dbus.txt');
if ((await stat(notificationPath)).size === 0) {
  throw new Error('The pre-armed DBus monitor did not record an OS notification.');
}

const notificationFile = path.join(evidence, 'pwa-notification-browser.json');
const notification = JSON.parse(await readFile(notificationFile, 'utf8'));
notification.osNotifyDbusObserved = true;
await writeFile(notificationFile, `${JSON.stringify(notification, null, 2)}\n`);

const mcp = JSON.parse(await readFile(path.join(evidence, 'computer-use-mcp.json'), 'utf8'));
const call = (name) => mcp.calls.find((entry) => entry.name === name);
const structured = (name) => call(name)?.result?.structuredContent;
const windows = structured('list_windows')?.windows ?? [];
const window = windows.find((entry) => entry.pid === chromePid || entry.title === 'ChatMux');
const focused = structured('focused_window')?.focused_window;
const report = {
  activeSession: true,
  existingBackend: true,
  taskOwnedChromePid: chromePid,
  checks: {
    atSpi: structured('get_app_state')?.accessibility_tree_raw_count > 0,
    canQueryWindows: structured('doctor')?.readiness?.can_query_windows === true,
    canFocusWindows: structured('doctor')?.readiness?.can_focus_windows === true,
    chatMuxWindow: Boolean(window),
    chatMuxFocused: Boolean(
      focused && window
      && (focused.window_id === window.window_id || focused.pid === chromePid),
    ),
  },
};
report.ok = Object.values(report.checks).every(Boolean);
await writeFile(path.join(evidence, 'isolated-desktop.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
