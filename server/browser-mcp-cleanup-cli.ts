import {
  applyBrowserMcpCleanup,
  rollbackBrowserMcpCleanup,
  type CleanupResult,
} from './modules/providers/services/chatmux-browser-mcp-cleanup.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CleanupService = {
  applyBrowserMcpCleanup: () => CleanupResult;
  rollbackBrowserMcpCleanup: (runId: string) => CleanupResult;
};

type Output = (line: string) => void;

export type BrowserMcpCleanupCommand =
  | { action: 'apply' }
  | { action: 'rollback'; runId: string };

export class BrowserMcpCleanupCliError extends Error {}

const service: CleanupService = { applyBrowserMcpCleanup, rollbackBrowserMcpCleanup };

export function parseBrowserMcpCleanupArgs(argv: readonly string[]): BrowserMcpCleanupCommand {
  if (argv.length === 1 && argv[0] === 'apply') {
    return { action: 'apply' };
  }

  if (argv.length === 3 && argv[0] === 'rollback' && argv[1] === '--run-id') {
    if (!UUID.test(argv[2])) {
      throw new BrowserMcpCleanupCliError('rollback --run-id must be a UUID');
    }
    return { action: 'rollback', runId: argv[2] };
  }

  throw new BrowserMcpCleanupCliError(
    'usage: chatmux browser-mcp-cleanup apply | chatmux browser-mcp-cleanup rollback --run-id <UUID>',
  );
}

export function cleanupExitCode(status: CleanupResult['status']): number {
  return status === 'completed' || status === 'completed_noop' || status === 'rolled_back' ? 0 : 1;
}

export function redactedCleanupSummary(result: CleanupResult): string {
  return JSON.stringify({
    status: result.status,
    runId: result.runId,
    receiptPath: result.receiptPath,
    providers: result.providers.map(({ provider, classification, status }) => ({ provider, classification, status })),
  });
}

export function runBrowserMcpCleanupCli(
  argv: readonly string[],
  dependencies: CleanupService = service,
  output: Output = console.log,
): number {
  const command = parseBrowserMcpCleanupArgs(argv);
  const result = command.action === 'apply'
    ? dependencies.applyBrowserMcpCleanup()
    : dependencies.rollbackBrowserMcpCleanup(command.runId);
  output(redactedCleanupSummary(result));
  return cleanupExitCode(result.status);
}
