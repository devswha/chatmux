/**
 * Slash command catalog for the interactive composer.
 *
 * The commands and skills a session can run are the ones installed on the
 * machine that runs it. This installation keeps its existing endpoints; a session
 * owned by a peer is asked through the host-qualified inventory route so the peer
 * answers from its own provider state instead of the hub's.
 *
 * Loading, mapping and ranking live here as plain functions; the React state that
 * drives the menu stays in `useSlashCommands`.
 */

import { parseProviderInventory, requestHostJson, type ProviderInventory } from '../../../fleet/hostApi/requests';
import { hostInventoryUrl, isLocalHostScope, type HostScope } from '../../../fleet/hostApi/urls';
import type { LLMProvider, Project } from '../../../types/app';
import { authenticatedFetch } from '../../../utils/api';
import { safeLocalStorage } from '../utils/chatStorage';

export interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: 'built-in' | 'custom' | 'skill' | string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

type ProviderSkill = {
  name: string;
  description?: string;
  command: string;
  scope: string;
  sourcePath?: string;
  pluginName?: string;
  pluginId?: string;
};

type ProviderSkillsResponse = {
  success?: boolean;
  data?: { skills?: ProviderSkill[] };
};

const getCommandHistoryKey = (projectName: string) => `command_history_${projectName}`;

export const readCommandHistory = (projectName: string): Record<string, number> => {
  const history = safeLocalStorage.getItem(getCommandHistoryKey(projectName));
  if (!history) {
    return {};
  }

  try {
    return JSON.parse(history);
  } catch (error) {
    console.error('Error parsing command history:', error);
    return {};
  }
};

export const saveCommandHistory = (projectName: string, history: Record<string, number>) => {
  safeLocalStorage.setItem(getCommandHistoryKey(projectName), JSON.stringify(history));
};

export const isSkillCommand = (command: SlashCommand) =>
  command.type === 'skill' || command.metadata?.type === 'skill';

const dedupeProviderSkills = (skills: ProviderSkill[]): ProviderSkill[] => {
  const seenCommands = new Set<string>();

  return skills.filter((skill) => {
    // Multiple physical Claude plugin folders can expose the same invocation.
    // The slash menu should show each executable command only once.
    const key = skill.command;
    if (seenCommands.has(key)) {
      return false;
    }

    seenCommands.add(key);
    return true;
  });
};

const mapSkillToSlashCommand = (skill: ProviderSkill): SlashCommand => ({
  name: skill.command,
  description: skill.description,
  namespace: 'skill',
  path: skill.sourcePath,
  type: 'skill',
  metadata: {
    type: skill.scope,
    scope: skill.scope,
    sourcePath: skill.sourcePath,
    pluginName: skill.pluginName,
    pluginId: skill.pluginId,
    skillName: skill.name,
  },
});

export const filterSlashCommands = (
  commands: SlashCommand[],
  query: string,
): SlashCommand[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return commands;
  }

  const commandPrefix = normalizedQuery.startsWith('/')
    ? normalizedQuery
    : `/${normalizedQuery}`;
  const namePrefixMatches = commands.filter((command) =>
    command.name.toLowerCase().startsWith(commandPrefix),
  );

  // Namespaced commands should behave like path completion. Once a provider
  // namespace is typed, only exact command-prefix matches should stay visible.
  if (normalizedQuery.includes(':') || namePrefixMatches.length > 0) {
    return namePrefixMatches;
  }

  const nameSubstringMatches = commands.filter((command) =>
    command.name.toLowerCase().includes(normalizedQuery),
  );
  if (nameSubstringMatches.length > 0) {
    return nameSubstringMatches;
  }

  return commands.filter((command) =>
    command.description?.toLowerCase().includes(normalizedQuery),
  );
};

export function sortByCommandHistory(commands: SlashCommand[], projectId: string): SlashCommand[] {
  const parsedHistory = readCommandHistory(projectId);
  return [...commands].sort((commandA, commandB) =>
    (parsedHistory[commandB.name] || 0) - (parsedHistory[commandA.name] || 0));
}

/**
 * A peer answers one typed inventory for every provider it runs, so its entries
 * are mapped straight into menu commands. `scope` carries the peer's own notion
 * of where a command came from and is preserved rather than reinterpreted here.
 */
function peerSlashCommands(inventory: ProviderInventory): SlashCommand[] {
  return inventory.commands.map((command) => ({
    name: command.name.startsWith('/') ? command.name : `/${command.name}`,
    description: command.description,
    namespace: command.scope,
    type: inventory.provider === 'gjc' ? 'custom' : 'skill',
    metadata: { type: command.scope, scope: command.scope, hostProvider: inventory.provider },
  }));
}

/** Built-ins, skills and custom commands installed on this installation. */
async function localSlashCommands(project: Project, provider: LLMProvider): Promise<SlashCommand[]> {
  const workspacePath = project.fullPath || project.path || '';
  const response = await authenticatedFetch('/api/commands/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.projectId }),
  });
  if (!response.ok) {
    throw new Error('Failed to fetch commands');
  }
  const data = await response.json();
  const skillsParams = new URLSearchParams();
  if (workspacePath) {
    skillsParams.set('workspacePath', workspacePath);
  }
  let skillsData: ProviderSkillsResponse | null = null;
  try {
    const skillsResponse = await authenticatedFetch(
      `/api/providers/${encodeURIComponent(provider)}/skills${skillsParams.toString() ? `?${skillsParams.toString()}` : ''}`,
    );
    if (skillsResponse.ok) skillsData = await skillsResponse.json() as ProviderSkillsResponse;
  } catch {
    // A failed optional provider catalog must not discard known local commands.
  }
  const skills = Array.isArray(skillsData?.data?.skills) ? skillsData.data.skills.filter((skill) => skill
    && typeof skill.name === 'string' && typeof skill.command === 'string' && typeof skill.scope === 'string') : [];
  return [
    ...((data.builtIn || []) as SlashCommand[]).map((command) => ({ ...command, type: 'built-in' })),
    ...dedupeProviderSkills(skills).map(mapSkillToSlashCommand),
    ...((data.custom || []) as SlashCommand[]).map((command) => ({ ...command, type: 'custom' })),
  ];
}

/**
 * Commands for the session on screen, from the host that owns it. A peer session
 * whose local id is not yet known has no catalog: the hub's own commands would be
 * the wrong machine's, so nothing is offered instead.
 */
export async function loadSlashCommands(
  project: Project,
  provider: LLMProvider,
  session: HostScope & { readonly localId: string | null },
): Promise<SlashCommand[]> {
  const scope: HostScope = { hostId: session.hostId, localHostId: session.localHostId };
  if (!isLocalHostScope(scope)) {
    if (session.localId === null) {
      return [];
    }
    const result = await requestHostJson(hostInventoryUrl(scope, session.localId));
    const inventory = result.ok ? parseProviderInventory(result.value) : null;
    return inventory === null ? [] : sortByCommandHistory(peerSlashCommands(inventory), project.projectId);
  }
  return sortByCommandHistory(await localSlashCommands(project, provider), project.projectId);
}
