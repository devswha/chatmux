import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import express, { type Request, type Response, type Router } from 'express';

import { getTailscaleAccessInfo, type TailscaleAccessInfo } from './tailscale-access.js';

/**
 * One-click self-update (관제탑 큐 #282).
 *
 * The update itself is the ALREADY-VERIFIED machinery — `scripts/deploy.sh`
 * (candidate build → service restart → health check → automatic rollback to
 * the last good deployment). This module only adds the trigger: a guarded
 * endpoint that launches that script OUTSIDE the service's own cgroup, because
 * `systemctl restart` kills every process inside it — an updater spawned as a
 * plain child would be murdered by the very restart it initiates. systemd-run
 * puts the updater in its own transient unit so it survives.
 *
 * Fail-closed properties:
 * - Only the source-checkout install mode may self-update; release-artifact
 *   installs keep their checksum-verified manual cutover (docs/SELF-HOST.md).
 * - One update at a time; a stale in-flight marker expires instead of wedging.
 * - A dependency change is honored (`npm ci`) only when the pull actually
 *   touched package-lock.json — otherwise the running server's node_modules
 *   is never yanked out from under it.
 * - Build failures never touch the running service (deploy.sh contract), and
 *   a failed health check auto-rolls back.
 */

export type InstallMode = 'source' | 'release' | 'unknown';

/** How the running app was installed, from its resolved app root. */
export function detectInstallMode(appRoot: string, home: string = homedir()): InstallMode {
  const root = path.resolve(appRoot);
  const releasesRoot = path.resolve(home, '.gajae-app', 'releases') + path.sep;
  if (root.startsWith(releasesRoot) || root === path.resolve(home, '.gajae-app', 'current')) {
    return 'release';
  }
  if (existsSync(path.join(root, '.git')) && existsSync(path.join(root, 'scripts', 'deploy.sh'))) {
    return 'source';
  }
  return 'unknown';
}

/** Single-quote a value for safe embedding in a bash script. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The update script run inside the transient unit. Pull fast-forward only,
 * reinstall dependencies only when the pull changed package-lock.json, then
 * hand over to deploy.sh (build → restart → health → auto-rollback).
 */
export function buildSelfUpdateScript(appRoot: string, healthUrl: string, logPath: string): string {
  return [
    `exec >>${shellQuote(logPath)} 2>&1`,
    'set -euo pipefail',
    // The transient unit inherits the SERVICE's minimal PATH, which typically
    // lacks the Rust toolchain the full build needs (실측: `spawn cargo ENOENT`
    // while deploy.sh built the native core — fail-closed as designed, but the
    // update can never succeed without this).
    'export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"',
    `echo "[self-update] $(date -u +%FT%TZ) starting"`,
    `cd ${shellQuote(appRoot)}`,
    'before="$(git rev-parse HEAD)"',
    'git pull --ff-only origin main',
    'after="$(git rev-parse HEAD)"',
    // Yank node_modules only when the update actually changed dependencies —
    // the running server still lazy-loads from it until the restart.
    'if ! git diff --quiet "$before" "$after" -- package-lock.json; then npm ci; fi',
    `DEPLOY_HEALTH_URL=${shellQuote(healthUrl)} scripts/deploy.sh`,
    `echo "[self-update] $(date -u +%FT%TZ) finished"`,
  ].join('\n');
}

/** systemd-run argv that detaches the updater from the service's cgroup. */
export function buildSystemdRunArgs(unitName: string, script: string, environmentPath: string): string[] {
  return [
    '--user',
    '--collect',
    `--unit=${unitName}`,
    `--setenv=PATH=${environmentPath}`,
    '--setenv=DEPLOY_TRIGGER=self-update',
    'bash',
    '-c',
    script,
  ];
}

/** In-flight marker; stale entries expire so a crashed updater cannot wedge the button. */
export const SELF_UPDATE_STALE_MS = 15 * 60 * 1000;

export type SelfUpdateState = { unit: string; startedAt: number } | null;

export type SelfUpdatePlan =
  | { action: 'reject'; statusCode: number; error: string }
  | { action: 'start' };

/** Pure request gate: install mode + single-flight decide whether an update may start. */
export function planSelfUpdate(args: { mode: InstallMode; inFlight: SelfUpdateState; now: number }): SelfUpdatePlan {
  if (args.mode === 'release') {
    return {
      action: 'reject',
      statusCode: 409,
      error: 'Release-artifact installs update via the checksum-verified cutover in docs/SELF-HOST.md — one-click update is for source checkouts.',
    };
  }
  if (args.mode !== 'source') {
    return {
      action: 'reject',
      statusCode: 409,
      error: 'This install is not a git checkout with the update tooling (scripts/deploy.sh); update it the way it was installed.',
    };
  }
  if (args.inFlight && args.now - args.inFlight.startedAt < SELF_UPDATE_STALE_MS) {
    return { action: 'reject', statusCode: 429, error: 'An update is already in progress.' };
  }
  return { action: 'start' };
}

export interface SystemRouterOptions {
  appRoot: string;
  serverPort: number;
  bootId: string;
  /** Injectable for tests. */
  mode?: InstallMode;
  launch?: (unitName: string, script: string) => Promise<void>;
  now?: () => number;
}

async function launchViaSystemdRun(unitName: string, script: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('systemd-run', buildSystemdRunArgs(unitName, script, process.env.PATH ?? ''), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => reject(new Error(`systemd-run unavailable: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`systemd-run exited with ${code}: ${stderr.trim().slice(0, 300)}`));
      }
    });
  });
}

/** `/api/system` router: self-update trigger + status, tailscale access info. */
export function createSystemRouter(options: SystemRouterOptions): Router {
  const router = express.Router();
  const mode = options.mode ?? detectInstallMode(options.appRoot);
  const launch = options.launch ?? launchViaSystemdRun;
  const now = options.now ?? Date.now;
  const logPath = path.join(homedir(), '.gajae-app', 'self-update.log');
  let inFlight: SelfUpdateState = null;
  // Access info is a subprocess probe; settings opens shouldn't hammer it.
  let accessCache: { at: number; info: TailscaleAccessInfo } | null = null;
  const ACCESS_CACHE_MS = 30_000;

  router.get('/access-info', (_req: Request, res: Response) => {
    void (async () => {
      if (!accessCache || now() - accessCache.at > ACCESS_CACHE_MS) {
        accessCache = { at: now(), info: await getTailscaleAccessInfo(options.serverPort) };
      }
      res.json(accessCache.info);
    })().catch(() => {
      if (!res.headersSent) {
        res.json({ installed: false, running: false, dnsName: null, httpsUrls: [], suggestedCommand: null });
      }
    });
  });

  router.get('/update/status', (_req: Request, res: Response) => {
    res.json({
      mode,
      bootId: options.bootId,
      updateInProgress: Boolean(inFlight && now() - inFlight.startedAt < SELF_UPDATE_STALE_MS),
      startedAt: inFlight?.startedAt ?? null,
      logPath,
    });
  });

  router.post('/update', (req: Request, res: Response) => {
    void (async () => {
      const plan = planSelfUpdate({ mode, inFlight, now: now() });
      if (plan.action === 'reject') {
        res.status(plan.statusCode).json({ error: plan.error, mode });
        return;
      }
      const unitName = `gajae-app-self-update-${now()}`;
      const healthUrl = `http://127.0.0.1:${options.serverPort}/`;
      const script = buildSelfUpdateScript(options.appRoot, healthUrl, logPath);
      try {
        await launch(unitName, script);
      } catch (error) {
        // Fail closed: no detached launcher → no update. A plain child would be
        // killed by the restart it triggers and leave a half-applied deployment.
        res.status(500).json({
          error: `Could not launch the detached updater (${error instanceof Error ? error.message : 'unknown error'}). Run scripts/deploy.sh manually.`,
          mode,
        });
        return;
      }
      inFlight = { unit: unitName, startedAt: now() };
      res.json({ started: true, mode, unit: unitName, logPath, bootId: options.bootId });
    })().catch(() => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'self-update failed to start' });
      }
    });
  });

  return router;
}
