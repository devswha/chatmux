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

export function tmuxPaneIdentityKey(identity: TmuxPaneIdentity): string {
  return `${identity.socketPath}\u0000${identity.sessionId}\u0000${identity.windowId}\u0000${identity.paneId}`;
}
