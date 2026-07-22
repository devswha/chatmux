import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { addUniqueProviderSkillSource, findTopmostGitRoot } from '@/shared/utils.js';

const PROJECT_SKILL_DIRS = [
  ['.omp', 'skills'],
  ['.agent', 'skills'],
  ['.agents', 'skills'],
  ['.codex', 'skills'],
  ['.claude', 'skills'],
] as const;

const USER_SKILL_DIRS = [
  ['.omp', 'agent', 'skills'],
  ['.agent', 'skills'],
  ['.omp', 'agent', 'managed-skills'],
  ['.agents', 'skills'],
  ['.codex', 'skills'],
  ['.claude', 'skills'],
] as const;

export class OmpSkillsProvider extends SkillsProvider {
  constructor() {
    super('omp');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);
    const projectRoots = repoRoot && path.resolve(repoRoot) !== path.resolve(workspacePath)
      ? [workspacePath, repoRoot]
      : [workspacePath];

    for (const projectRoot of projectRoots) {
      for (const segments of PROJECT_SKILL_DIRS) {
        addUniqueProviderSkillSource(sources, seenRootDirs, {
          scope: 'project',
          rootDir: path.join(projectRoot, ...segments),
          commandPrefix: '/skill:',
        });
      }
    }

    for (const segments of USER_SKILL_DIRS) {
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'user',
        rootDir: path.join(os.homedir(), ...segments),
        commandPrefix: '/skill:',
      });
    }

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.omp', 'agent', 'skills'),
      commandPrefix: '/skill:',
    };
  }
}
