import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import {
  resolveCursorCliCommand,
  type CursorCliCommand,
} from '@/modules/providers/list/cursor/cursor-cli-command.js';

type CursorLoginStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

type CursorVersionProbe = typeof spawn.sync;

export const isCursorAgentInstalled = (
  runVersionProbe: CursorVersionProbe = spawn.sync,
): boolean => resolveCursorCliCommand(runVersionProbe) !== null;

export class CursorProviderAuth implements IProviderAuth {
  constructor(private readonly runVersionProbe: CursorVersionProbe = spawn.sync) {}

  /**
   * Returns Cursor CLI installation and login status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const command = resolveCursorCliCommand(this.runVersionProbe);

    if (!command) {
      return {
        installed: false,
        provider: 'cursor',
        authenticated: false,
        email: null,
        method: null,
        error: 'Cursor CLI is not installed',
      };
    }

    const login = await this.checkCursorLogin(command);

    return {
      installed: true,
      provider: 'cursor',
      authenticated: login.authenticated,
      email: login.email,
      method: login.method,
      error: login.authenticated ? undefined : login.error || 'Not logged in',
    };
  }

  /**
   * Runs the resolved Cursor CLI status command and parses the login marker.
   */
  private checkCursorLogin(command: CursorCliCommand): Promise<CursorLoginStatus> {
    return new Promise((resolve) => {
      let processCompleted = false;
      let childProcess: ReturnType<typeof spawn> | undefined;

      const timeout = setTimeout(() => {
        if (!processCompleted) {
          processCompleted = true;
          childProcess?.kill();
          resolve({
            authenticated: false,
            email: null,
            method: null,
            error: 'Command timeout',
          });
        }
      }, 5000);

      try {
        childProcess = spawn(command, ['status']);
      } catch {
        clearTimeout(timeout);
        processCompleted = true;
        resolve({
          authenticated: false,
          email: null,
          method: null,
          error: 'Cursor CLI not found or not installed',
        });
        return;
      }

      let stdout = '';
      let stderr = '';

      childProcess.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      childProcess.on('close', (code) => {
        if (processCompleted) {
          return;
        }
        processCompleted = true;
        clearTimeout(timeout);

        if (code === 0) {
          const emailMatch = stdout.match(/Logged in as ([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
          if (emailMatch?.[1]) {
            resolve({ authenticated: true, email: emailMatch[1], method: 'cli' });
            return;
          }

          if (stdout.includes('Logged in')) {
            resolve({ authenticated: true, email: 'Logged in', method: 'cli' });
            return;
          }

          resolve({ authenticated: false, email: null, method: null, error: 'Not logged in' });
          return;
        }

        resolve({ authenticated: false, email: null, method: null, error: stderr || 'Not logged in' });
      });

      childProcess.on('error', () => {
        if (processCompleted) {
          return;
        }
        processCompleted = true;
        clearTimeout(timeout);

        resolve({
          authenticated: false,
          email: null,
          method: null,
          error: 'Cursor CLI not found or not installed',
        });
      });
    });
  }
}
