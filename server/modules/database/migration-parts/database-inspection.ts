import type { Database } from 'better-sqlite3';

export type TableInfoRow = {
  name: string;
  pk: number;
};
type IndexListRow = {
  name: string;
};

type IndexInfoRow = {
  name: string;
};

type TableNameRow = {
  name: string;
};

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const dropIndexesForColumn = (db: Database, tableName: string, columnName: string): void => {
  const indexes = db.prepare<[], IndexListRow>(`PRAGMA index_list(${tableName})`).all();

  for (const { name } of indexes) {
    const columns = db
      .prepare<[], IndexInfoRow>(`PRAGMA index_info(${quoteIdentifier(name)})`)
      .all();
    if (columns.some((column) => column.name === columnName)) {
      db.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(name)}`);
    }
  }
};

export const activateArchivedRows = (db: Database, tableName: string): void => {
  if (!tableExists(db, tableName)) {
    return;
  }

  const columnNames = getTableInfo(db, tableName).map((column) => column.name);
  if (columnNames.includes('isArchived')) {
    db.exec(`UPDATE ${tableName} SET isArchived = 0`);
  }
};

export const removeArchiveColumn = (db: Database, tableName: string): void => {
  if (!tableExists(db, tableName)) {
    return;
  }

  const columnNames = getTableInfo(db, tableName).map((column) => column.name);
  if (!columnNames.includes('isArchived')) {
    return;
  }

  dropIndexesForColumn(db, tableName, 'isArchived');
  db.exec(`ALTER TABLE ${tableName} DROP COLUMN isArchived`);
};

export const addColumnToTableIfNotExists = (
  db: Database,
  tableName: string,
  columnNames: string[],
  columnName: string,
  columnType: string
) => {
  if (!columnNames.includes(columnName)) {
    console.error(`Running migration: Adding ${columnName} column to ${tableName} table`);
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
};

export const tableExists = (db: Database, tableName: string): boolean =>
  Boolean(
    db
      .prepare<[string], TableNameRow>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(tableName),
  );

export const getTableInfo = (db: Database, tableName: string): TableInfoRow[] =>
  db.prepare<[], TableInfoRow>(`PRAGMA table_info(${tableName})`).all();

