import type {
  ExternalCliSession,
  ExternalLocalCliKind,
} from '@/modules/providers/services/external-cli-sessions.service.js';
export type FakeAgentEvent =
  | { readonly type: 'ready'; readonly pid: number } | { readonly type: 'input'; readonly value: string }
  | { readonly type: 'interrupt' } | { readonly type: 'turn_started' } | { readonly type: 'turn_interrupted' }
  | { readonly type: 'turn_completed' } | { readonly type: 'transcript'; readonly path: string; readonly sessionId: string }
  | { readonly type: 'approval_requested' } | { readonly type: 'approval'; readonly decision: string };
export type FakeTmuxAgent = Readonly<{
  sessionName: string; logPath: string; events: () => Promise<FakeAgentEvent[]>; waitUntilReady: () => Promise<void>;
  waitForInput: (value: string) => Promise<void>; waitForInterrupt: (count?: number) => Promise<void>;
  waitForTurnStarted: () => Promise<void>; waitForTurnInterrupted: () => Promise<void>;
  waitForApproval: (decision: string) => Promise<void>;
}>;
export type FakeTranscriptTmuxAgent = FakeTmuxAgent & Readonly<{ sessionId: string; transcriptPath: string; waitForTranscript: (count?: number) => Promise<void> }>;
export type TmuxE2EHarness = Readonly<{
  root: string; workspace: string; discoverFromFreshProcess: () => Promise<ExternalCliSession[]>; dispose: () => Promise<void>;
  getSessionId: (sessionName: string) => Promise<string>; hasSession: (sessionName: string) => Promise<boolean>;
  capturePane: (paneId: string) => Promise<string>; killSession: (sessionName: string) => Promise<void>;
  startFakeExternal: (kind: ExternalLocalCliKind, sessionName: string, cwd?: string) => Promise<FakeTmuxAgent>;
  respawnFakeCodexPane: (sessionName: string, paneId: string, cwd?: string) => Promise<FakeTmuxAgent>;
  startFakeCodex: (sessionName: string, cwd?: string) => Promise<FakeTmuxAgent>;
  startFakeCodexWithTranscript: (sessionName: string, sessionId: string, cwd?: string) => Promise<FakeTranscriptTmuxAgent>;
  startFakeCodexPane: (sessionName: string, cwd?: string) => Promise<FakeTmuxAgent>;
  startFakeGjc: (sessionName: string, cwd?: string) => Promise<FakeTmuxAgent>;
  startFakeGjcWithTranscript: (sessionName: string, sessionId: string, cwd?: string) => Promise<FakeTranscriptTmuxAgent>;
  startFakeGjcWithBun: (sessionName: string, cwd?: string) => Promise<FakeTmuxAgent>;
  startFakeGjcWithNpmShim: (sessionName: string, cwd?: string) => Promise<FakeTmuxAgent>;
}>;
export type FleetTmuxIdentity = Readonly<{ sessionId: '$1'; windowId: '@1'; paneId: '%1' }>;
export type FleetCollisionFixture = Readonly<{
  projectPath: string; providerSessionId: string; nativeSessionId: string; appSessionId: string;
  tmuxSessionName: string; displayLabel: string; tmux: FleetTmuxIdentity;
}>;
export type FleetTmuxNodeName = 'hub' | 'peer-a' | 'peer-b';
export type TmuxFleetPorts = Readonly<{ hub: number; peerA: number; peerB: number }>;
export type TmuxFleetHarnessOptions = Partial<TmuxFleetPorts> & Readonly<{
  createNode?: (options: Readonly<{
    fleetRoot: string; name: FleetTmuxNodeName; port: number; workspace: string;
  }>) => Promise<TmuxFleetNode>;
}>;
export type TmuxFleetNode = Readonly<{
  name: FleetTmuxNodeName; hostId: string; tmuxServerPid: number; root: string; home: string; databasePath: string; tmuxTmpDir: string;
  socketPath: string; workspace: string; port: number; fakeAgentPath: string; logRoot: string;
  environment: Readonly<NodeJS.ProcessEnv>; dispose: () => Promise<void>;
  sendInput: (sessionName: string, value: string) => Promise<void>;
  sendInterrupt: (sessionName: string) => Promise<void>;
  discoverFromFreshProcess: () => Promise<ExternalCliSession[]>;
  startFakeExternal: (kind: ExternalLocalCliKind, sessionName: string) => Promise<FakeTmuxAgent>;
  startFakeCodexWithTranscript: (sessionName: string, sessionId: string) => Promise<FakeTranscriptTmuxAgent>;
  startFakeGjcWithTranscript: (sessionName: string, sessionId: string) => Promise<FakeTranscriptTmuxAgent>;
  tmuxIdentity: (sessionName: string) => Promise<FleetTmuxIdentity>;
}>;
export type TmuxFleetE2EHarness = Readonly<{
  root: string; workspace: string; hub: TmuxFleetNode; peers: Readonly<{ a: TmuxFleetNode; b: TmuxFleetNode }>;
  collision: FleetCollisionFixture; dispose: () => Promise<void>;
  startCollisionPeers: () => Promise<readonly [FakeTranscriptTmuxAgent, FakeTranscriptTmuxAgent]>;
}>;
