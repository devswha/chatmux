export type TmuxPaneIdentity = {
  socketPath: string;
  sessionId: string;
  windowId: string;
  paneId: string;
};

export type TmuxProcessGeneration = {
  pid: number;
  startedAtMs: number;
};

export type TmuxPaneTarget = {
  tmux: TmuxPaneIdentity;
  process: TmuxProcessGeneration;
};

/** A pane identity qualified by the installation that owns its local tmux server. */
export type HostTmuxPaneIdentity = Readonly<{
  hostId: string;
  lane: string;
  tmux: TmuxPaneIdentity;
}>;

/** A host-qualified exact process generation; authority remains with the owning host. */
export type HostTmuxPaneTarget = HostTmuxPaneIdentity & Readonly<{
  process: TmuxProcessGeneration;
}>;

export function tmuxPaneIdentityKey(identity: TmuxPaneIdentity): string {
  return `${identity.socketPath}\u0000${identity.sessionId}\u0000${identity.windowId}\u0000${identity.paneId}`;
}

/** Stable pane-stream subscription identity shared by server and client. */
export function paneSubscriptionKey(lane: string, tmux: TmuxPaneIdentity, process: TmuxProcessGeneration): string {
  return `${lane}\u0000${tmuxPaneIdentityKey(tmux)}\u0000${process.pid}\u0000${process.startedAtMs}`;
}
