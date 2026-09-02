import { spawn } from 'node:child_process';

/**
 * Where a ChatMux-initiated `tmux new-session` may run.
 *
 * Under systemd the server process lives in chatmux.service's control group,
 * and the default KillMode=control-group kills every process in that group
 * on stop or restart. When ChatMux is the first client to talk to a tmux
 * socket, the tmux client forks the tmux *server*, which then inherits the
 * service cgroup: the next self-update restart would take the server and
 * every agent inside it down with ChatMux, violating the invariant that a
 * ChatMux restart never terminates tmux work.
 *
 * Running the spawn through `systemd-run --user --scope` puts the client, and
 * therefore any server it forks, in a transient scope unit of its own. The
 * scope outlives chatmux.service and is collected once its processes exit.
 */
export const SYSTEMD_RUN_SCOPE_ARGS = ['--user', '--scope', '--collect', '--quiet', '--'] as const;

export type TmuxSpawnLaunch = Readonly<{
  readonly command: string;
  readonly prefixArgs: readonly string[];
}>;

const PROBE_TIMEOUT_MS = 5_000;

/** True when this process runs as a systemd service, i.e. inside a unit cgroup. */
export function runsInsideSystemdUnit(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'linux' && typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID.length > 0;
}

export function tmuxSpawnLaunch(isolate: boolean): TmuxSpawnLaunch {
  return isolate
    ? { command: 'systemd-run', prefixArgs: [...SYSTEMD_RUN_SCOPE_ARGS, 'tmux'] }
    : { command: 'tmux', prefixArgs: [] };
}

/** One cheap end-to-end check that transient scopes work for this user manager. */
export function probeSystemdRunScope(): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('systemd-run', [...SYSTEMD_RUN_SCOPE_ARGS, 'true'], { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); settle(false); }, PROBE_TIMEOUT_MS);
    child.on('error', () => settle(false));
    child.on('close', (code) => settle(code === 0));
  });
}

let probe: Promise<boolean> | undefined;

/**
 * Decides once per process whether spawns go through a transient scope.
 * Outside systemd, or when systemd-run is missing or the user manager refuses
 * scopes, the plain tmux command is used so spawning keeps working.
 */
export function resolveTmuxSpawnLaunch(deps: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  probe?: () => Promise<boolean>;
} = {}): Promise<TmuxSpawnLaunch> {
  if (!runsInsideSystemdUnit(deps.env, deps.platform)) {
    return Promise.resolve(tmuxSpawnLaunch(false));
  }
  probe ??= (deps.probe ?? probeSystemdRunScope)().catch(() => false);
  return probe.then(tmuxSpawnLaunch);
}

/** Test seam: forget the cached probe result. */
export function resetTmuxSpawnLaunchForTests(): void {
  probe = undefined;
}
