import type pg from 'pg';
import type { Row, SqlExecutor, SqlTx } from 'cypher-to-sql';

export interface PgExecutorOptions {
  /** Statement timeout for every SQL step, in milliseconds. Default 5000. */
  statementTimeoutMs?: number;
}

/**
 * An executor over a `pg` connection pool. Each query takes one client from
 * the pool and runs all of its SQL steps in one transaction on it.
 */
export function pgExecutor(pool: pg.Pool, options: PgExecutorOptions = {}): SqlExecutor {
  const timeout = Math.trunc(options.statementTimeoutMs ?? 5000);
  return {
    async transaction<T>(mode: 'read' | 'write', fn: (tx: SqlTx) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        // Reads see one snapshot in every step, and PostgreSQL refuses writes.
        await client.query(
          mode === 'read' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
        );
        try {
          await client.query(`SET LOCAL statement_timeout = ${timeout}`);
          // JIT compilation can take far longer than these queries run.
          await client.query('SET LOCAL jit = off');
          const result = await fn({
            async query(sql, values) {
              // 64-bit integers are bound as text; PostgreSQL casts them exactly.
              const params = values.map((v) => (typeof v === 'bigint' ? v.toString() : v));
              const { rows } = await client.query(sql, params);
              return rows as Row[];
            },
          });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      } finally {
        client.release();
      }
    },
  };
}
