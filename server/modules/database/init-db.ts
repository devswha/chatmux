import { getConnection } from "@/modules/database/connection.js";
import { runMigrations } from "@/modules/database/migrations.js";
import { assertFleetRoleIntegrity } from "@/modules/database/repositories/fleet-installation-role.js";
import {
    COMPLETION_NOTIFICATION_GENERATION_STATE_STALE_INDEX_SQL,
    INIT_SCHEMA_SQL,
} from "@/modules/database/schema.js";

// Initialize database with schema
export const initializeDatabase = async () => {
    try {
        const db = getConnection();
        db.exec(INIT_SCHEMA_SQL);
        // Lifecycle diagnostics stay on stderr: CLI commands such as `chatmux fleet token`
        // are machine-parsed over SSH and need stdout reserved for their result.
        console.error('Database schema applied');
        runMigrations(db);
        assertFleetRoleIntegrity(db);
        db.exec(COMPLETION_NOTIFICATION_GENERATION_STATE_STALE_INDEX_SQL);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Database initialization failed', { error: message });
        throw err;
    }
};
