/**
 * Slash commands and skills the relay composer can offer for one session.
 *
 * Provider inventory is host-local state: the commands a session can run are the
 * ones installed on the machine running it. The local host keeps its existing
 * endpoints; a session owned by a peer is asked through the host-qualified
 * inventory route so the peer answers with its own catalog instead of the hub's.
 *
 * Failure is non-fatal by design — free-text relay still works without a catalog.
 */

import { useEffect, useMemo, useState } from 'react';

import { parseProviderInventory, requestHostJson } from '../../../fleet/hostApi/requests';
import { hostInventoryUrl, isLocalHostScope, type HostScope } from '../../../fleet/hostApi/urls';
import { api } from '../../../utils/api';
import type { LiveGjcCommand } from '../utils/liveRelayComposer';

export type RelayCommandInventoryInput = {
  readonly relayKind: string;
  readonly workspacePath: string | null;
  readonly commandTrigger: string;
  /** Session on screen and the host that owns it. */
  readonly session: HostScope & { readonly localId: string | null };
};

type SkillEntry = { command?: string; name?: string; description?: string };
const EMPTY_COMMANDS: readonly LiveGjcCommand[] = [];

function localCommands(input: RelayCommandInventoryInput, body: unknown): readonly LiveGjcCommand[] {
  const payload = body as { data?: { skills?: SkillEntry[]; commands?: LiveGjcCommand[] }; skills?: SkillEntry[]; commands?: LiveGjcCommand[] } | null;
  if (input.relayKind === 'gjc') {
    const list = payload?.data?.commands ?? payload?.commands ?? [];
    return Array.isArray(list) ? list : [];
  }
  const skills = payload?.data?.skills ?? payload?.skills ?? [];
  return skills
    .filter((skill) => Boolean(skill?.command) || Boolean(skill?.name))
    .map((skill) => ({
      name: skill.command ?? `${input.commandTrigger}${skill.name ?? ''}`,
      description: skill.description,
      namespace: 'skill',
    }));
}

/** A peer answers one typed inventory shape for every provider it runs. */
function remoteCommands(input: RelayCommandInventoryInput, value: unknown): readonly LiveGjcCommand[] {
  const inventory = parseProviderInventory(value);
  if (inventory === null) return [];
  return inventory.commands.map((command) => ({
    name: inventory.provider === 'gjc' || command.name.startsWith(input.commandTrigger)
      ? command.name
      : `${input.commandTrigger}${command.name}`,
    description: command.description,
    namespace: inventory.provider === 'gjc' ? command.scope : 'skill',
  }));
}

export function useRelayCommandInventory(input: RelayCommandInventoryInput): readonly LiveGjcCommand[] {
  const { commandTrigger, relayKind, workspacePath } = input;
  const { hostId, localHostId, localId } = input.session;
  const request = useMemo<RelayCommandInventoryInput>(() => ({
    relayKind, workspacePath, commandTrigger, session: { hostId, localHostId, localId },
  }), [commandTrigger, hostId, localHostId, localId, relayKind, workspacePath]);
  const [resolved, setResolved] = useState<{
    request: RelayCommandInventoryInput;
    commands: readonly LiveGjcCommand[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const scope: HostScope = { hostId, localHostId };
    void (async () => {
      if (!isLocalHostScope(scope)) {
        if (localId === null) return;
        const result = await requestHostJson(hostInventoryUrl(scope, localId));
        if (!cancelled && result.ok) setResolved({ request, commands: remoteCommands(request, result.value) });
        return;
      }
      try {
        const response = relayKind === 'gjc'
          ? await api.liveSessionCommands(workspacePath ?? undefined)
          : await api.providerSkills(relayKind, workspacePath ?? undefined);
        if (!response.ok) return;
        const body: unknown = await response.json().catch(() => null);
        if (!cancelled) setResolved({ request, commands: localCommands(request, body) });
      } catch {
        // Non-fatal — the composer still relays free text.
      }
    })();
    return () => { cancelled = true; };
  }, [hostId, localHostId, localId, relayKind, request, workspacePath]);

  return resolved?.request === request ? resolved.commands : EMPTY_COMMANDS;
}
