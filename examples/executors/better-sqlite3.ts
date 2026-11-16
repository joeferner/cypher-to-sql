import type Database from 'better-sqlite3';
import type { Row, SqlExecutor, SqlTx } from 'cypher-to-sql';

/** Prepared statements kept per connection, most recently used last. */
const CACHED_STATEMENTS = 100;

/**
 * An executor over a `better-sqlite3` connection. A connection runs one
 * transaction at a time, so queries wait for each other. It keeps the last
 * statements it prepared: a write runs the same SQL for every row of a batch,
 * and preparing it each time costs more than running it.
 */
export function betterSqliteExecutor(db: Database.Database): SqlExecutor {
  let queue: Promise<unknown> = Promise.resolve();
  const statements = new Map<string, Database.Statement>();
  const prepare = (sql: string): Database.Statement => {
    let stmt = statements.get(sql);
    if (stmt) {
      statements.delete(sql);
    } else {
      // Cypher integers are 64-bit: read them as bigint.
      stmt = db.prepare(sql).safeIntegers(true);
      if (statements.size >= CACHED_STATEMENTS) {
        statements.delete(statements.keys().next().value!);
      }
    }
    statements.set(sql, stmt);
    return stmt;
  };
  return {
    transaction<T>(mode: 'read' | 'write', fn: (tx: SqlTx) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        db.exec(mode === 'read' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE');
        if (mode === 'read') {
          // SQLite itself refuses any write in a read transaction.
          db.pragma('query_only = ON');
        }
        try {
          const result = await fn({
            query(sql, values) {
              const stmt = prepare(sql);
              if (stmt.reader) {
                return Promise.resolve(stmt.all(...values) as Row[]);
              }
              stmt.run(...values);
              return Promise.resolve([]);
            },
          });
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
      };
      const result = queue.then(run, run);
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
