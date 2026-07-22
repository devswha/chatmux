import { OmpProviderAuth } from '@/modules/providers/list/omp/omp-auth.provider.js';
import { OmpMcpProvider } from '@/modules/providers/list/omp/omp-mcp.provider.js';
import { OmpProviderModels } from '@/modules/providers/list/omp/omp-models.provider.js';
import { OmpSkillsProvider } from '@/modules/providers/list/omp/omp-skills.provider.js';
import { GjcSessionSynchronizer } from '@/modules/providers/list/gjc/gjc-session-synchronizer.provider.js';
import { GjcSessionsProvider } from '@/modules/providers/list/gjc/gjc-sessions.provider.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

export class OmpProvider extends AbstractProvider {
  readonly models: IProviderModels = new OmpProviderModels();
  readonly mcp = new OmpMcpProvider();
  readonly auth: IProviderAuth = new OmpProviderAuth();
  readonly skills: IProviderSkills = new OmpSkillsProvider();
  readonly sessions: IProviderSessions = new GjcSessionsProvider('omp');
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new GjcSessionSynchronizer({
    provider: 'omp',
  });

  constructor() {
    super('omp');
  }
}
