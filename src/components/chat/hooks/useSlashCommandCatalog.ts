/**
 * Loads the slash command catalog for the session on screen.
 *
 * The host that owns the session is authoritative: this installation answers for
 * its own sessions, a peer answers for its own. The catalog is therefore reloaded
 * whenever the owning host or the addressed session changes, and never merged
 * across hosts — two machines can hold the same session id with entirely
 * different provider inventories.
 */

import { useEffect, useState } from 'react';

import { useFleetHost } from '../../../fleet/FleetSessionRoute';
import type { LLMProvider, Project } from '../../../types/app';

import { loadSlashCommands, type SlashCommand } from './slashCommandCatalog';
const EMPTY_COMMANDS: SlashCommand[] = [];

export function useSlashCommandCatalog(
  selectedProject: Project | null,
  provider: LLMProvider,
): SlashCommand[] {
  const { storeScope, activeSession } = useFleetHost();
  const { hostId, localHostId } = storeScope;
  const localId = activeSession?.localId ?? null;
  const request = JSON.stringify([hostId, localHostId, localId, provider,
    selectedProject?.projectId, selectedProject?.fullPath, selectedProject?.path]);
  const [resolved, setResolved] = useState<{ request: typeof request; commands: SlashCommand[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!selectedProject) {
      return undefined;
    }
    void loadSlashCommands(selectedProject, provider, { hostId, localHostId, localId })
      .then((loaded) => { if (!cancelled) setResolved({ request, commands: loaded }); })
      .catch((error: unknown) => {
        console.error('Error fetching slash commands:', error);
        if (!cancelled) setResolved({ request, commands: [] });
      });
    return () => { cancelled = true; };
  }, [hostId, localHostId, localId, provider, request, selectedProject]);

  return resolved?.request === request ? resolved.commands : EMPTY_COMMANDS;
}
