import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { ProviderMcpServer } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

export class OmpMcpProvider extends McpProvider {
  constructor() {
    super('omp', ['user', 'project'], ['stdio', 'http']);
  }

  protected async readScopedServers(): Promise<Record<string, unknown>> {
    return {};
  }

  protected async writeScopedServers(): Promise<void> {
    throw new AppError('Oh My Pi MCP configuration is not supported by ChatMux.', {
      code: 'MCP_WRITE_UNSUPPORTED',
      statusCode: 400,
    });
  }

  protected buildServerConfig(): Record<string, unknown> {
    throw new AppError('Oh My Pi MCP configuration is not supported by ChatMux.', {
      code: 'MCP_WRITE_UNSUPPORTED',
      statusCode: 400,
    });
  }

  protected normalizeServerConfig(): ProviderMcpServer | null {
    return null;
  }
}
