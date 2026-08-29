import type { TmuxPaneIdentity } from '../../../../../shared/tmux.js';

import {
  paneKind,
  isGjcProcessArgs,
  SESSION_FILE_RE,
  SESSIONS_SEGMENT,
  TMUX_FIELD_SEP,
} from './process-contracts.js';

export {
  GJC_INTERPRETER_COMMS,
  IDLE_GJC_ID_PREFIX,
  isGjcCommandLine,
  isGjcProcessArgs,
  gjcSessionRoots,
  paneKind,
  parsePsArgsTree,
  SESSION_FILE_RE,
  SESSION_SIDECAR_FILE_RE,
  SESSIONS_SEGMENT,
  TMUX_FIELD_SEP,
} from './process-contracts.js';
export type { LiveGjcSession } from './process-contracts.js';

/**
 * Pure detection: tmux sessions whose pane process subtree contains a gjc
 * process but that NO transcript-holding live session claimed. Subtree
 * membership (pane pid → descendants via the ps snapshot) is the same evidence
 * a lineage claim rests on, so tmux actions (kill/relay) remain safe for these
 * rows. Exclusion is LINEAGE names only: a cwd label is weaker evidence than
 * the subtree proof, so it must not hide a real idle gjc pane. Both rows may
 * coexist when they share a name because they represent different evidence.
 * Sorted by name for stable rendering; dedupe keeps the first pane's sid.
 */
export function findIdleGjcTmuxSessions(args: {
  panes: Array<{ name: string; tmux: TmuxPaneIdentity; pid: number; cmd?: string }>;
  /** From `ps -eo pid,ppid,args` — argv, not comm: an interpreter-launched gjc reports comm 'bun'/'node' (#1). */
  procs: Array<{ pid: number; ppid: number; args: string }>;
  excludedPaneIds: ReadonlySet<string>;
}): Array<{
  name: string;
  tmux: TmuxPaneIdentity;
  agentPid: number;
  kind: 'interactive' | 'batch' | null;
}> {
  const children = new Map<number, number[]>();
  const argsByPid = new Map<number, string>();
  for (const proc of args.procs) {
    const siblings = children.get(proc.ppid);
    if (siblings) {
      siblings.push(proc.pid);
    } else {
      children.set(proc.ppid, [proc.pid]);
    }
    argsByPid.set(proc.pid, proc.args);
  }

  const subtreeGjcPid = (rootPid: number): number | null => {
    const seen = new Set<number>();
    const queue: number[] = [rootPid];
    while (queue.length > 0 && seen.size < 4096) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (isGjcProcessArgs(argsByPid.get(pid) ?? '')) return pid;
      queue.push(...(children.get(pid) ?? []));
    }
    return null;
  };

  const idle = [];
  for (const pane of args.panes) {
    if (args.excludedPaneIds.has(pane.tmux.paneId)) {
      continue;
    }
    const agentPid = subtreeGjcPid(pane.pid);
    if (agentPid !== null) {
      idle.push({
        name: pane.name,
        tmux: pane.tmux,
        agentPid,
        kind: paneKind(pane.cmd),
      });
    }
  }
  return idle.sort((a, b) => (
    a.name.localeCompare(b.name) || a.tmux.paneId.localeCompare(b.tmux.paneId)
  ));
}

/** True when `tmux list-panes` reported at least one pane (a tmux server is up). */
export function tmuxHasPanes(output: string): boolean {
  return output.split(/\r?\n/).some((line) => line.trim().length > 0);
}

/** Parses one exact tmux pane identity plus its process metadata. */
export function parseTmuxPanes(output: string): Array<{
  name: string;
  tmux: TmuxPaneIdentity;
  pid: number;
  cmd: string;
  cwd: string;
}> {
  const panes: Array<{
    name: string;
    tmux: TmuxPaneIdentity;
    pid: number;
    cmd: string;
    cwd: string;
  }> = [];
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const fields = raw.split(TMUX_FIELD_SEP);
    if (fields.length < 8) continue;
    const [socketPath, sessionId, windowId, paneId, rawName, rawPid, rawCmd, ...cwdFields] = fields;
    const tmux = {
      socketPath: socketPath.trim(),
      sessionId: sessionId.trim(),
      windowId: windowId.trim(),
      paneId: paneId.trim(),
    };
    const name = rawName.trim();
    const pid = Number.parseInt(rawPid.trim(), 10);
    const cmd = rawCmd.trim();
    const cwd = cwdFields.join(TMUX_FIELD_SEP).trim();
    if (
      tmux.socketPath
      && /^\$\d+$/.test(tmux.sessionId)
      && /^@\d+$/.test(tmux.windowId)
      && /^%\d+$/.test(tmux.paneId)
      && name
      && Number.isFinite(pid)
      && cwd
    ) {
      panes.push({ name, tmux, pid, cmd, cwd });
    }
  }
  return panes;
}

/** Parses `lsof -F pn` output into {session-id, holder pid} pairs (path-agnostic). */
export function parseLsofPidSessions(output: string): Array<{ id: string; pid: number }> {
  const out: Array<{ id: string; pid: number }> = [];
  const seen = new Set<string>();
  let pid: number | null = null;
  for (const raw of output.split(/\r?\n/)) {
    if (raw.startsWith('p')) {
      const parsed = Number.parseInt(raw.slice(1), 10);
      pid = Number.isFinite(parsed) ? parsed : null;
      continue;
    }
    if (raw.startsWith('n') && raw.includes(SESSIONS_SEGMENT) && pid != null) {
      const match = SESSION_FILE_RE.exec(raw);
      if (match) {
        const key = `${pid}:${match[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ id: match[1], pid });
        }
      }
    }
  }
  return out;
}
