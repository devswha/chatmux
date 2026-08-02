import type { ChildProcess } from 'node:child_process';

import type { ProcessGeneration, RuntimeCapabilities, TerminalTargetClass } from '../../../shared/terminal-runtime.js';

export type HerdrSourceId = `hsrc_${string}`;
export type HerdrTargetId = `htgt_${string}`;
export type HerdrTransport = 'herdr terminal session control';
export type HerdrSourceSelector = string;
export type HerdrSocketStat = { uid: number; mode: number; device: number; inode: number };
export type HerdrResolvedSource = {
  sourceId: HerdrSourceId; alias: string; binary: string; selector: HerdrSourceSelector; canonicalSocketPath: string;
  socketStat: HerdrSocketStat; serverIncarnation: string; probeFingerprint: string; internalGeneration: number; transport: HerdrTransport;
};
export type HerdrHierarchy = { workspaceId: string; tabId: string; paneId: string };
export type HerdrAgentEvidence = { agentId: string; agentKind: string };
export type HerdrProcessEvidence = ProcessGeneration & { foregroundProcessGroupId: number | null; executableName: string };
export type HerdrResolvedTerminal = {
  source: HerdrResolvedSource; hierarchy: HerdrHierarchy; terminalId: string; terminalIncarnation: string; terminalRevision: number;
  agent: HerdrAgentEvidence | null; process: HerdrProcessEvidence | null; targetClass: TerminalTargetClass;
};
declare const verifiedHerdrTarget: unique symbol;
export type VerifiedHerdrTarget = HerdrResolvedTerminal & { readonly [verifiedHerdrTarget]: 'verified'; operation: 'output' | 'actions' | 'attach' };
export type HerdrTargetGeneration = { targetId: HerdrTargetId; terminalId: string; terminalIncarnation: string; hierarchy: HerdrHierarchy; sourceGeneration: number; expiresAtMs: number };
export type HerdrControllerState = {
  sourceId: HerdrSourceId; terminalId: string; child: ChildProcess; internalToken: string | null; epoch: number | null; frameCursor: number;
  bridgeGeneration: number; startedAtMs: number; capabilities: RuntimeCapabilities; state: 'establishing' | 'active' | 'blocked' | 'released' | 'closed';
};
