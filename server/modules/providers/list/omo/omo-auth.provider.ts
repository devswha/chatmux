import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

export class OmoProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    const result = spawn.sync('omo', ['--version'], { stdio: 'ignore', timeout: 5_000 });
    const installed = !result.error && result.status === 0;
    return {
      installed,
      provider: 'omo',
      authenticated: installed,
      email: installed ? 'CLI managed' : null,
      method: installed ? 'cli' : null,
      error: installed ? undefined : 'omo CLI is not installed',
    };
  }
}
