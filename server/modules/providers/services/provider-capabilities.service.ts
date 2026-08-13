import type { LLMProvider } from '@/shared/types.js';

/**
 * Static, backend-owned description of what one provider integration supports.
 *
 * The frontend renders its composer UI (permission mode picker, image upload,
 * abort button, ...) purely from this shape, which is what keeps the frontend
 * free of per-provider conditionals. New provider features should be exposed
 * here instead of branching on the provider id in React components.
 */
type ProviderCapabilities = {
  provider: LLMProvider;
  /** Permission modes the provider runtime understands, in cycle order. */
  permissionModes: string[];
  defaultPermissionMode: string;
  /** Whether image attachments can be included in a chat.send. */
  supportsImages: boolean;
  /** Whether an in-flight run can be cancelled via chat.abort. */
  supportsAbort: boolean;
  /** Whether interactive tool permission prompts can reach the UI. */
  supportsPermissionRequests: boolean;
  /** Whether the token-usage endpoint has data for this provider. */
  supportsTokenUsage: boolean;
  /** Whether the provider runtime can accept model-level reasoning effort. */
  supportsEffort: boolean;
};

/**
 * The capability matrix mirrors what each runtime actually implements today:
 * - permission modes match the option sets accepted by each CLI/SDK.
 * - Claude SDK and GJC SDK v3 surface interactive permission requests.
 * - Cursor has no token usage endpoint support (its store.db has no usage rows).
 */
const PROVIDER_CAPABILITIES: Record<LLMProvider, ProviderCapabilities> = {
  claude: {
    provider: 'claude',
    permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: true,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  cursor: {
    provider: 'cursor',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: false,
    supportsEffort: false,
  },
  codex: {
    provider: 'codex',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  opencode: {
    provider: 'opencode',
    // Mapped by the runtime onto OpenCode's controls: `--agent plan` (plan),
    // `--auto` (bypassPermissions) and the OPENCODE_PERMISSION env var
    // (acceptEdits). See resolveOpenCodePermissionOptions in opencode-cli.js.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  gjc: {
    provider: 'gjc',
    permissionModes: ['default'],
    defaultPermissionMode: 'default',
    // Runtime unsupported: spawnGjcWithRuntime only reads session/project/cwd/model
    // options (`server/gjc-cli.js:255`), so image attachments are never forwarded.
    supportsImages: false,
    supportsAbort: true,
    supportsPermissionRequests: true,
    supportsTokenUsage: true,
    // Runtime unsupported: spawnGjcWithRuntime does not read an effort option
    // (`server/gjc-cli.js:255`), so no reasoning-effort control reaches GJC.
    supportsEffort: false,
  },
  omp: {
    provider: 'omp',
    permissionModes: ['default'],
    defaultPermissionMode: 'default',
    // B11x-omp-images: buildOmpArgs forwards image paths as @<path>
    // (`server/omp-cli.ts:51-55`), but this matrix still hides the UI control.
    supportsImages: false,
    // B11x-omp-abort: abortOmpSession terminates the tracked child with SIGTERM
    // (`server/omp-cli.ts:248-253`), but this matrix still hides the abort control.
    supportsAbort: false,
    // Deferred to M4b exit: normalizeOmpEvent only maps session, message, tool, and error
    // events (`server/omp-cli.ts:60-139`); the Oh My Pi runtime's approval event contract is unverified.
    supportsPermissionRequests: false,
    // Deferred to M4b exit: normalizeOmpEvent has no token-usage mapping (`server/omp-cli.ts:60-139`);
    // the Oh My Pi JSON runtime's usage contract is unverified.
    supportsTokenUsage: false,
    // B11x-omp-effort: buildOmpArgs passes effort through --thinking
    // (`server/omp-cli.ts:48-49`), but this matrix still hides the effort control.
    supportsEffort: false,
  },
  omo: {
    provider: 'omo',
    permissionModes: ['default'],
    defaultPermissionMode: 'default',
    // omo is wired for discovery and transcript reading only. There is no omo
    // send runtime (no `server/omo-cli.ts`), so nothing forwards attachments or
    // can cancel an in-flight run yet.
    supportsImages: false,
    supportsAbort: false,
    // omo's TUI renders "↑↓ navigate • enter select • esc close" and has no
    // "Other (type your own)" row, so every parser in
    // tmux-interactive-prompt.service.ts rejects it. Interactive prompts stay
    // off until omo gets its own parser.
    supportsPermissionRequests: false,
    supportsTokenUsage: false,
    // `omo --list-models` reports thinking as a yes/no column and never
    // enumerates the levels, so no effort values can be offered.
    supportsEffort: false,
  },
};

/**
 * Application service exposing the provider capability matrix.
 */
export const providerCapabilitiesService = {
  getProviderCapabilities(provider: LLMProvider): ProviderCapabilities {
    return PROVIDER_CAPABILITIES[provider];
  },

  listAllProviderCapabilities(): ProviderCapabilities[] {
    return Object.values(PROVIDER_CAPABILITIES);
  },
};
