import type Database from 'better-sqlite3';
import type { Row, SqlExecutor, SqlTx } from 'cypher-to-sql';

/**
 * An executor over a `better-sqlite3` connection. A connection runs one
 * transaction at a time, so queries wait for each other.
 */
export function betterSqliteExecutor(db: Database.Database): SqlExecutor {
  let queue: Promise<unknown> = Promise.resolve();
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
              // Cypher integers are 64-bit: read them as bigint.
              const stmt = db.prepare(sql).safeIntegers(true);
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
