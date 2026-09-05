import type { Database } from 'better-sqlite3';

import {
  MIGRATIONS,
  SCHEMA_MIGRATIONS_TABLE_SQL,
} from '@/modules/database/migration-parts/migration-registry.js';

export const runMigrations = (db: Database) => {
  try {
    db.exec(SCHEMA_MIGRATIONS_TABLE_SQL);
    const appliedVersions = db
      .prepare<[], { readonly version: number }>('SELECT version FROM schema_migrations')
      .all();
    const appliedVersionSet = new Set(appliedVersions.map(({ version }) => version));

    for (const migration of MIGRATIONS) {
      if (appliedVersionSet.has(migration.version)) {
        continue;
      }

      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec('BEGIN TRANSACTION');
        migration.migrate(db);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
        db.exec('COMMIT');
      } catch (migrationError) {
        db.exec('ROLLBACK');
        throw migrationError;
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }

    console.error('Database migrations completed successfully');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error running migrations:', message);
    throw error;
  }
};
