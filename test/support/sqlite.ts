import Database from 'better-sqlite3';
import {
  registerSqliteFunctions,
  type Row,
  type SqlExecutor,
  type SqlTx,
} from '../../src/index.js';

/** DDL for the generic layout with the default mapping. */
export const SQLITE_SCHEMA = `
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  labels TEXT NOT NULL CHECK (json_type(labels) = 'array'),
  properties TEXT NOT NULL CHECK (json_type(properties) = 'object')
);
CREATE TABLE edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_id INTEGER NOT NULL REFERENCES nodes (id),
  end_id INTEGER NOT NULL REFERENCES nodes (id),
  type TEXT NOT NULL,
  properties TEXT NOT NULL CHECK (json_type(properties) = 'object')
);
CREATE INDEX edges_start_id ON edges (start_id);
CREATE INDEX edges_end_id ON edges (end_id);
CREATE INDEX edges_type ON edges (type);
`;

/** An in-memory SQLite database with the generic layout. */
export function createSqliteDatabase(): Database.Database {
  const db = new Database(':memory:');
  // Integers come back as bigint, so 64-bit ids and values are exact.
  db.defaultSafeIntegers(true);
  db.pragma('foreign_keys = ON');
  db.exec(SQLITE_SCHEMA);
  registerSqliteFunctions(db);
  return db;
}

/**
 * Example executor over better-sqlite3. Read transactions turn on
 * `PRAGMA query_only`, so SQLite itself refuses any write inside them.
 */
export function sqliteExecutor(db: Database.Database): SqlExecutor & { log: string[] } {
  const log: string[] = [];
  const tx: SqlTx = {
    query(sql: string, values: unknown[]): Promise<Row[]> {
      log.push(sql);
      const stmt = db.prepare(sql);
      if (stmt.reader) {
        return Promise.resolve(stmt.all(...values) as Row[]);
      }
      stmt.run(...values);
      return Promise.resolve([]);
    },
  };
  return {
    log,
    async transaction<T>(mode: 'read' | 'write', fn: (tx: SqlTx) => Promise<T>): Promise<T> {
      db.exec(mode === 'read' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE');
      if (mode === 'read') {
        db.pragma('query_only = ON');
      }
      try {
        const result = await fn(tx);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        if (mode === 'read') {
          db.pragma('query_only = OFF');
        }
      }
    },
  };
}
