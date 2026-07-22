import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

export class OmpProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    const result = spawn.sync('omp', ['--version'], { stdio: 'ignore', timeout: 5_000 });
    const installed = !result.error && result.status === 0;
    return {
      installed,
      provider: 'omp',
      authenticated: installed,
      email: installed ? 'CLI managed' : null,
      method: installed ? 'cli' : null,
      error: installed ? undefined : 'Oh My Pi CLI is not installed',
    };
  }
}
