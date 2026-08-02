import type { HerdrResolvedTerminal } from './herdr-internal.types.js';

export type ProtectedTerminalTargetEvidence = Readonly<{ protected: boolean; identity: string }>;
export type ProtectedTerminalTargetResolver = (target: HerdrResolvedTerminal) => ProtectedTerminalTargetEvidence;

/**
 * Protects the Herdr source hosting ChatMux itself. Herdr exports the named
 * session to every pane process; denying that whole source is conservative
 * across pane moves and launch-time pane-id aliases.
 */
export class ProtectedTerminalTargetService {
  constructor(
    private readonly resolve: ProtectedTerminalTargetResolver = (target) => {
      const runningInsideHerdr = process.env.HERDR_ENV === '1';
      const hostingSource = runningInsideHerdr
        && (!process.env.HERDR_SESSION || process.env.HERDR_SESSION === target.source.selector);
      return {
        protected: hostingSource,
        identity: `${target.terminalId}:${target.terminalIncarnation}:${target.hierarchy.workspaceId}:${target.hierarchy.tabId}:${target.hierarchy.paneId}`,
      };
    },
  ) {}

  evidence(target: HerdrResolvedTerminal): ProtectedTerminalTargetEvidence | null {
    const evidence = this.resolve(target);
    return typeof evidence.protected === 'boolean' && /^[A-Za-z0-9_.:-]{1,512}$/.test(evidence.identity) ? evidence : null;
  }

  allows(target: HerdrResolvedTerminal, expected?: ProtectedTerminalTargetEvidence): boolean {
    const current = this.evidence(target);
    return !!current && !current.protected && (!expected || (current.identity === expected.identity && current.protected === expected.protected));
  }
}
