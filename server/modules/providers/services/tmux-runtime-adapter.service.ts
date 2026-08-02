import type { RuntimeAdapter, RuntimeOperationContext } from '@/modules/terminal-runtimes/index.js';

import type { PublicTerminalRef, PublicTerminalTarget, RuntimeCapabilities, SourceDescriptor } from '../../../../shared/terminal-runtime.js';

import { normalizeExternalPaneOutput } from './external-cli-sessions.service.js';
import type { VerifiedTmuxActionTarget } from './tmux-fresh-verifier.service.js';
import {
  captureTmuxPane,
  sendTmuxProcessAction,
  sendToTmuxPane,
  type TmuxProcessAction,
} from './tmux-pane-actions.service.js';

const TMUX_SOURCE_ID = 'tmux.local';
const CAPABILITIES: RuntimeCapabilities = {
  discovery: true, output: true, actions: true, attach: true, create: true,
};

type TmuxTargetVerifier = (tmux: unknown, process: unknown) => Promise<VerifiedTmuxActionTarget>;
export type TmuxRuntimeOperationContext = Readonly<{
  process: unknown;
  verify: TmuxTargetVerifier;
  beforeAction?: (target: VerifiedTmuxActionTarget) => Promise<void>;
  onVerified?: (target: VerifiedTmuxActionTarget) => void;
}>;

function operationContext(value: RuntimeOperationContext): TmuxRuntimeOperationContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const context = value as Partial<TmuxRuntimeOperationContext>;
  return typeof context.verify === 'function' ? context as TmuxRuntimeOperationContext : null;
}

async function verified(ref: PublicTerminalRef, context: RuntimeOperationContext): Promise<VerifiedTmuxActionTarget | null> {
  const operation = operationContext(context);
  if (ref.runtime !== 'tmux' || !operation) return null;
  const target = await operation.verify(ref.tmux, operation.process);
  operation.onVerified?.(target);
  return target;
}

/** Delegates tmux runtime operations to the established verifier and pane primitives. */
export function createTmuxRuntimeAdapter(): RuntimeAdapter {
  return {
    runtime: 'tmux',
    sourceDescriptors: async (): Promise<readonly SourceDescriptor[]> => [{ runtime: 'tmux', sourceId: TMUX_SOURCE_ID, readiness: 'ready' }],
    capabilities: (): RuntimeCapabilities => CAPABILITIES,
    discover: async (): Promise<readonly PublicTerminalTarget[]> => [],
    read: async (ref, context) => {
      const target = await verified(ref, context);
      return target ? { ansi: normalizeExternalPaneOutput(await captureTmuxPane(target)), truncated: false } : null;
    },
    send: async (ref, literal, context) => {
      const target = await verified(ref, context);
      if (!target) return false;
      await sendToTmuxPane(target, literal);
      return true;
    },
    interrupt: async (ref, context) => action(ref, 'interrupt', context),
    escape: async (ref, context) => action(ref, 'escape', context),
  };
}

async function action(ref: PublicTerminalRef, key: TmuxProcessAction, context: RuntimeOperationContext): Promise<boolean> {
  const operation = operationContext(context);
  const target = await verified(ref, context);
  if (!target || !operation) return false;
  await operation.beforeAction?.(target);
  await sendTmuxProcessAction(target, key);
  return true;
}
