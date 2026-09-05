import type { HostDiscoverySnapshot } from '../host-discovery-snapshot.service.js';
import type { ProviderConnectionIssue } from '../../../../../shared/provider-connection.js';
import type { TmuxPaneIdentity, TmuxProcessGeneration } from '../../../../../shared/tmux.js';
import { processStartMs } from '../process-start-time.service.js';
import { tmuxPaneIdentityKey } from '../../../../../shared/tmux.js';
import { validateLocalAgentContext } from '../local-agent-context.service.js';
import type { ExternalSessionBinding } from '../external-cli-sessions.service.js';

import type { LiveGjcSessionCommandRunner } from './session-correlation.js';
import type { LiveGjcSessionsDetailedResult } from './transcript-enrichment.js';
import type { RuntimeReceiptAttempt } from './runtime-receipts.js';
import { IDLE_GJC_ID_PREFIX, TMUX_FIELD_SEP, findIdleGjcTmuxSessions, isGjcProcessArgs, parsePsArgsTree, parseTmuxPanes, tmuxHasPanes } from './process-parsing.js';
import { dedupeLiveSessionsByLineage, pickPaneReceipt, runCommand, safeRealpath } from './session-correlation.js';
import { mapTranscriptEnrichments, readOpenGjcTranscript } from './transcript-parsing.js';
import { readExactResumeReceipt, readPaneRuntimeReceipts, readPaneTerminalReceipt, runtimeReceiptFallbackBudget } from './runtime-receipts.js';
import { readLiveTranscriptEnrichment } from './transcript-enrichment.js';
import { runDiscoveryCommand } from './discovery-cache.js';


export async function scanLiveGjcSessions(
  commandRunner: LiveGjcSessionCommandRunner = runCommand,
  hostSnapshot?: HostDiscoverySnapshot,
): Promise<LiveGjcSessionsDetailedResult> {
  const panes: Array<{ name: string; tmux: TmuxPaneIdentity; pid: number; cwd: string; cmd: string }> = [];
  let processes: Array<{ pid: number; ppid: number; args: string }>;
  if (hostSnapshot) {
    if (!hostSnapshot.ok || hostSnapshot.panes.length === 0) {
      return { ok: false, sessions: [], transcriptPaths: new Map() };
    }
    for (const pane of hostSnapshot.panes) {
      if (!pane.cwd) continue;
      panes.push({
        name: pane.name,
        tmux: pane.tmux,
        pid: pane.pid,
        cmd: pane.command,
        cwd: (await safeRealpath(pane.cwd)) ?? pane.cwd,
      });
    }
    processes = hostSnapshot.processes.map((process) => ({
      pid: process.pid,
      ppid: process.ppid,
      args: isGjcProcessArgs(process.args ?? '')
        ? process.args!
        : `${process.comm} ${process.args ?? ''}`.trim(),
    }));
  } else {
    let tmuxOutput: string;
    try {
      tmuxOutput = await runDiscoveryCommand(commandRunner, 'tmux', ['list-panes', '-a', '-F', `#{socket_path}${TMUX_FIELD_SEP}#{session_id}${TMUX_FIELD_SEP}#{window_id}${TMUX_FIELD_SEP}#{pane_id}${TMUX_FIELD_SEP}#{session_name}${TMUX_FIELD_SEP}#{pane_pid}${TMUX_FIELD_SEP}#{pane_current_command}${TMUX_FIELD_SEP}#{pane_current_path}`]);
    } catch {
      return { ok: false, sessions: [], transcriptPaths: new Map() };
    }
    if (!tmuxHasPanes(tmuxOutput)) {
      return { ok: false, sessions: [], transcriptPaths: new Map() };
    }
    for (const pane of parseTmuxPanes(tmuxOutput)) {
      panes.push({ name: pane.name, tmux: pane.tmux, pid: pane.pid, cmd: pane.cmd, cwd: (await safeRealpath(pane.cwd)) ?? pane.cwd });
    }
    // Process lineage proves which GJC generation belongs to each pane. The
    // pane-specific receipt is then the primary transcript binding.
    let psOutput: string;
    try {
      psOutput = await runDiscoveryCommand(commandRunner, 'ps', ['-eo', 'pid,ppid,args']);
    } catch {
      return { ok: false, sessions: [], transcriptPaths: new Map() };
    }
    processes = parsePsArgsTree(psOutput);
  }

  const discovered = findIdleGjcTmuxSessions({
    panes,
    procs: processes,
    excludedPaneIds: new Set(),
  });
  const gjcPanes: Array<{
    name: string;
    tmux: TmuxPaneIdentity;
    agentPid: number;
    process: TmuxProcessGeneration | null;
    kind: 'interactive' | 'batch' | null;
  }> = await Promise.all(discovered.map(async (pane) => {
    const startedAtMs = await processStartMs(pane.agentPid);
    return {
      ...pane,
      process: startedAtMs === null ? null : { pid: pane.agentPid, startedAtMs },
    };
  }));

  // A cwd-only receipt is not pane-specific. It is therefore usable only when
  // exactly one current subtree-proven pane can claim that cwd; a pane with an
  // unavailable process generation still makes the mapping ambiguous.
  const paneCwdCounts = new Map<string, number>();
  const paneIdCounts = new Map<string, number>();
  for (const gjcPane of gjcPanes) {
    for (const pane of panes) {
      if (tmuxPaneIdentityKey(pane.tmux) !== tmuxPaneIdentityKey(gjcPane.tmux)) continue;
      paneCwdCounts.set(pane.cwd, (paneCwdCounts.get(pane.cwd) ?? 0) + 1);
      paneIdCounts.set(
        pane.tmux.paneId,
        (paneIdCounts.get(pane.tmux.paneId) ?? 0) + 1,
      );
    }
  }

  const sessionPaths = new Map<string, string>();
  const claimedIds = new Set<string>();
  const boundRows: Array<{
    id: string;
    tmuxName: string;
    tmux: TmuxPaneIdentity;
    process: TmuxProcessGeneration;
    claim: 'lineage';
    binding: ExternalSessionBinding;
    kind: 'interactive' | 'batch' | null;
  }> = [];
  const unboundRows: Array<{
    pane: typeof gjcPanes[number];
    issue?: ProviderConnectionIssue;
  }> = [];

  for (const gjcPane of gjcPanes) {
    if (gjcPane.process === null) {
      // Without the active gjc generation, a receipt from an earlier run in the
      // same long-lived pane is indistinguishable. Keep the safe synthetic row.
      unboundRows.push({ pane: gjcPane });
      continue;
    }

    const contextIssue = await validateLocalAgentContext({
      pid: gjcPane.agentPid,
      startedAtMs: gjcPane.process.startedAtMs,
      socketPath: gjcPane.tmux.socketPath,
    });
    if (contextIssue) {
      unboundRows.push({ pane: gjcPane, issue: contextIssue });
      continue;
    }

    let bound = false;
    for (const pane of panes.filter(
      (candidate) => tmuxPaneIdentityKey(candidate.tmux) === tmuxPaneIdentityKey(gjcPane.tmux),
    )) {
      const duplicatePaneId = (paneIdCounts.get(pane.tmux.paneId) ?? 0) > 1;
      const terminalAttempt: RuntimeReceiptAttempt = duplicatePaneId
        ? {
            receipt: null,
            attempts: 0,
            attemptedEntry: null,
            issue: 'tmux_pane_ambiguous',
          }
        : await readPaneTerminalReceipt(pane.tmux.paneId);
      const terminal = terminalAttempt.receipt ? pickPaneReceipt({
        paneCwd: pane.cwd,
        agentStartMs: gjcPane.process.startedAtMs,
        receipts: [terminalAttempt.receipt],
      }) : null;
      const exactAttempt: RuntimeReceiptAttempt = terminal ? {
        receipt: null,
        attempts: 0,
        attemptedEntry: null,
      } : await readExactResumeReceipt(
        pane.cwd,
        gjcPane.agentPid,
        gjcPane.process.startedAtMs,
      );
      const openAttempt: RuntimeReceiptAttempt = terminal || exactAttempt.receipt
        ? { receipt: null, attempts: 0, attemptedEntry: null }
        : await readOpenGjcTranscript(gjcPane.agentPid);
      const fallbackLimit = runtimeReceiptFallbackBudget(
        terminalAttempt.attempts + exactAttempt.attempts,
      );
      const excludedEntries = new Set(
        exactAttempt.attemptedEntry ? [exactAttempt.attemptedEntry] : [],
      );
      const heuristic = terminal || exactAttempt.receipt || openAttempt.receipt
        || fallbackLimit === 0
        || paneCwdCounts.get(pane.cwd) !== 1
        ? null
        : pickPaneReceipt({
            paneCwd: pane.cwd,
            agentStartMs: gjcPane.process.startedAtMs,
            receipts: await readPaneRuntimeReceipts(pane.cwd, fallbackLimit, excludedEntries),
          });
      const receipt = terminal ?? exactAttempt.receipt ?? openAttempt.receipt ?? heuristic;
      if (!receipt) {
        unboundRows.push({
          pane: gjcPane,
          issue: exactAttempt.issue ?? terminalAttempt.issue ?? openAttempt.issue,
        });
        continue;
      }
      if (await processStartMs(gjcPane.agentPid) !== gjcPane.process.startedAtMs) {
        unboundRows.push({ pane: gjcPane });
        continue;
      }
      if (claimedIds.has(receipt.sessionId)) {
        unboundRows.push({ pane: gjcPane, issue: 'transcript_ambiguous' });
        continue;
      }
      claimedIds.add(receipt.sessionId);
      // Pane lineage does not prove a transcript mapping. Only a pane-specific
      // receipt, exact process resume id, or process-held transcript is observed;
      // the cwd/time fallback remains inferred even when only one pane matches.
      boundRows.push({
        id: receipt.sessionId,
        tmuxName: gjcPane.name,
        tmux: gjcPane.tmux,
        process: gjcPane.process,
        claim: 'lineage',
        binding: terminal || exactAttempt.receipt || openAttempt.receipt ? 'observed' : 'inferred',
        kind: gjcPane.kind,
      });
      if (receipt.sessionFile !== null) {
        sessionPaths.set(receipt.sessionId, receipt.sessionFile);
      }
      bound = true;
      break;
    }
    if (!bound) {
      const alreadyUnbound = unboundRows.some(
        ({ pane }) => tmuxPaneIdentityKey(pane.tmux) === tmuxPaneIdentityKey(gjcPane.tmux),
      );
      if (!alreadyUnbound) unboundRows.push({ pane: gjcPane });
    }
  }

  // Enrich with the current model, reasoning effort, and turn activity from
  // each transcript.
  const enriched = await mapTranscriptEnrichments(
    boundRows,
    async (session) => {
      const path = sessionPaths.get(session.id);
      const enrichment = path
        ? await readLiveTranscriptEnrichment(session.id, path)
        : { model: null, effort: null, running: null, error: null };
      return {
        ...session,
        ...enrichment,
      };
    },
  );
  const allSessions = [
    ...enriched,
    ...unboundRows.map(({ pane, issue }) => ({
      id: `${IDLE_GJC_ID_PREFIX}${pane.name}:${pane.tmux.paneId}`,
      tmuxName: pane.name,
      tmux: pane.tmux,
      process: pane.process,
      // Subtree-proven: a gjc process runs INSIDE the pane — same evidence
      // as a lineage claim on transcript-backed rows.
      claim: 'lineage' as const,
      kind: pane.kind,
      model: null,
      effort: null,
      running: null,
      error: null,
      ...(issue ? { connectionIssue: issue } : {}),
    })),
  ];
  return {
    ok: true,
    sessions: dedupeLiveSessionsByLineage(allSessions),
    transcriptPaths: sessionPaths,
  };
}
