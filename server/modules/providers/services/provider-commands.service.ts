import os from 'node:os';
import path from 'node:path';

import {
  scanGjcCommandDirectory,
} from '@/modules/providers/services/live-commands.service.js';
import type {
  LLMProvider,
  ProviderSkill,
  ProviderSkillListOptions,
} from '@/shared/types.js';

type CommandSource = {
  scope: 'user' | 'project';
  rootDir: string;
  containmentRoot: string;
  commandForName?: (name: string) => string;
};

const workspacePathFor = (options?: ProviderSkillListOptions): string =>
  path.resolve(options?.workspacePath ?? process.cwd());

const commandSourcesFor = (
  provider: LLMProvider,
  workspacePath: string,
): CommandSource[] => {
  const homeDir = os.homedir();

  switch (provider) {
    case 'claude':
      return [
        // https://docs.anthropic.com/en/docs/claude-code/slash-commands
        { scope: 'user', rootDir: path.join(homeDir, '.claude', 'commands'), containmentRoot: homeDir },
        // https://docs.anthropic.com/en/docs/claude-code/slash-commands
        { scope: 'project', rootDir: path.join(workspacePath, '.claude', 'commands'), containmentRoot: workspacePath },
      ];
    case 'codex':
      return [
        // https://developers.openai.com/codex/skills/
        {
          scope: 'user',
          rootDir: path.join(homeDir, '.codex', 'prompts'),
          containmentRoot: homeDir,
          commandForName: (name) => `/prompts:${name.slice(1)}`,
        },
      ];
    case 'cursor':
      return [
        // https://docs.cursor.com/en/context/commands
        { scope: 'project', rootDir: path.join(workspacePath, '.cursor', 'commands'), containmentRoot: workspacePath },
      ];
    case 'opencode':
      return [
        // https://opencode.ai/docs/commands/
        { scope: 'user', rootDir: path.join(homeDir, '.config', 'opencode', 'commands'), containmentRoot: homeDir },
        // https://opencode.ai/docs/commands/
        { scope: 'project', rootDir: path.join(workspacePath, '.opencode', 'commands'), containmentRoot: workspacePath },
      ];
    case 'omp':
      return [
        // server/routes/commands.js:532-552 establishes project/home command containment.
        { scope: 'user', rootDir: path.join(homeDir, '.omp', 'agent', 'commands'), containmentRoot: homeDir },
        // server/routes/commands.js:532-552 establishes project/home command containment.
        { scope: 'project', rootDir: path.join(workspacePath, '.omp', 'commands'), containmentRoot: workspacePath },
      ];
    default:
      return [];
  }
};

/** Lists provider-native markdown commands in the existing ProviderSkill response shape. */
export const listProviderCommands = async (
  provider: LLMProvider,
  options?: ProviderSkillListOptions,
): Promise<ProviderSkill[]> => {
  const workspacePath = workspacePathFor(options);
  const commands: ProviderSkill[] = [];

  for (const source of commandSourcesFor(provider, workspacePath)) {
    const files = await scanGjcCommandDirectory(
      source.rootDir,
      source.scope,
      source.containmentRoot,
    );
    for (const file of files) {
      commands.push({
        provider,
        name: file.name,
        description: file.description,
        command: source.commandForName?.(file.name) ?? file.name,
        scope: source.scope,
        sourcePath: file.sourcePath ?? source.rootDir,
      });
    }
  }

  return commands;
};

/** Keeps the first command for a trigger, matching the live command palette's precedence. */
export const dedupeProviderSkillsByCommand = (
  skills: ProviderSkill[],
): ProviderSkill[] => {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.command)) {
      return false;
    }
    seen.add(skill.command);
    return true;
  });
};
