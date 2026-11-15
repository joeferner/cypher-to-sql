import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';
import type { Row, SqlExecutor, SqlTx } from 'cypher-to-sql';

export interface Mysql2ExecutorOptions {
  /** Time limit for every SQL step, in milliseconds. Default 5000. */
  statementTimeoutMs?: number;
}

/**
 * The session settings the MySQL dialect needs (see src/dialect/mysql.ts):
 * `||` concatenates, strings compare by code point, ordered JSON lists are not
 * cut short, and range() and split() can go past 1000 elements.
 */
export const MYSQL_SESSION =
  "SET SESSION sql_mode = CONCAT(REPLACE(@@sql_mode, 'ONLY_FULL_GROUP_BY', ''), ',PIPES_AS_CONCAT'), " +
  'NAMES utf8mb4 COLLATE utf8mb4_bin, ' +
  'SESSION group_concat_max_len = 1073741824, ' +
  'SESSION cte_max_recursion_depth = 4294967295';

/**
 * Runs one SQL step: rows for a SELECT, and for an INSERT (MySQL has no
 * RETURNING) one row with the new id.
 */
export async function runMysqlStep(
  connection: PoolConnection | { execute: PoolConnection['execute'] },
  sql: string,
  values: unknown[],
): Promise<Row[]> {
  const [result] = await connection.execute(sql, values as never);
  if (Array.isArray(result)) {
    return result as Row[];
  }
  const header = result as ResultSetHeader;
  return /^\s*INSERT\b/i.test(sql) ? [{ id: header.insertId }] : [];
}

/**
 * An executor over a `mysql2/promise` pool. Create the pool with
 * `maxPreparedStatements` set low (64, say): each distinct SQL text is a
 * prepared statement on the server, and the default cache of 16,000 per
 * connection holds a lot of server memory (and MySQL allows 16,382 in all).
 * Also `supportBigNumbers: true, bigNumberStrings: true`, so that 64-bit integers
 * come back exactly. Each query takes one connection and runs all of its SQL
 * steps in one transaction on it.
 */
export function mysql2Executor(pool: Pool, options: Mysql2ExecutorOptions = {}): SqlExecutor {
  const timeout = Math.trunc(options.statementTimeoutMs ?? 5000);
  return {
    async transaction<T>(mode: 'read' | 'write', fn: (tx: SqlTx) => Promise<T>): Promise<T> {
      const connection = await pool.getConnection();
      try {
        await connection.query(MYSQL_SESSION);
        await connection.query(`SET SESSION max_execution_time = ${timeout}`);
        // Reads see one snapshot in every step, and MySQL refuses writes.
        await connection.query(
          mode === 'read'
            ? 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'
            : 'START TRANSACTION',
        );
        try {
          const result = await fn({
            query: (sql, values) => runMysqlStep(connection, sql, values),
          });
          await connection.query('COMMIT');
          return result;
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        }
      } finally {
        connection.release();
      }
    },
  };
}
