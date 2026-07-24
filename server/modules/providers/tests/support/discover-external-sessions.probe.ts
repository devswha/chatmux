import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { getExternalCliSessions } from '@/modules/providers/services/external-cli-sessions.service.js';

const DISCOVERY_MARKER = '__CHATMUX_TMUX_E2E_SESSIONS__=';

try {
  await initializeDatabase();
  const sessions = await getExternalCliSessions();
  closeConnection();
  process.stdout.write(`${DISCOVERY_MARKER}${JSON.stringify(sessions)}\n`, () => process.exit(0));
} catch (error) {
  closeConnection();
  console.error(error);
  process.exit(1);
}
