import { OmoProviderAuth } from '@/modules/providers/list/omo/omo-auth.provider.js';
import { OmoMcpProvider } from '@/modules/providers/list/omo/omo-mcp.provider.js';
import { OmoProviderModels } from '@/modules/providers/list/omo/omo-models.provider.js';
import { OmoSkillsProvider } from '@/modules/providers/list/omo/omo-skills.provider.js';
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

export class OmoProvider extends AbstractProvider {
  readonly models: IProviderModels = new OmoProviderModels();
  readonly mcp = new OmoMcpProvider();
  readonly auth: IProviderAuth = new OmoProviderAuth();
  readonly skills: IProviderSkills = new OmoSkillsProvider();
  readonly sessions: IProviderSessions = new GjcSessionsProvider('omo');
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new GjcSessionSynchronizer({
    provider: 'omo',
  });

  constructor() {
    super('omo');
  }
}
