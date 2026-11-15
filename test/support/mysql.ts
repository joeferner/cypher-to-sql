import mysql from 'mysql2/promise';
import type { Row, SqlExecutor, SqlTx } from '../../src/index.js';
import { MYSQL_SESSION, runMysqlStep } from '../../examples/executors/mysql2.js';

/**
 * Connection URL of the test database. `npm run db:up` starts one (compose.yaml)
 * on localhost:53306. Inside the dev container, TEST_MYSQL_URL points at the
 * host instead.
 */
export const TEST_MYSQL_URL =
  process.env['TEST_MYSQL_URL'] ?? 'mysql://cypher:cypher@localhost:53306/cypher';

/** DDL for the generic layout with the default mapping (as examples/schema/mysql.sql). */
export const MYSQL_SCHEMA = [
  `CREATE TABLE nodes (
    id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
    labels json NOT NULL,
    properties json NOT NULL
  ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin`,
  `CREATE TABLE edges (
    id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
    start_id bigint NOT NULL,
    end_id bigint NOT NULL,
    type varchar(255) NOT NULL,
    properties json NOT NULL,
    FOREIGN KEY (start_id) REFERENCES nodes (id),
    FOREIGN KEY (end_id) REFERENCES nodes (id),
    INDEX edges_start_id_type (start_id, type),
    INDEX edges_end_id_type (end_id, type),
    INDEX edges_type (type)
  ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin`,
];

export interface MysqlConnection {
  connection: mysql.Connection;
  database: string;
  /** Empties the graph and restarts ids. */
  reset: () => Promise<void>;
  /** Drops the database and disconnects. */
  dispose: () => Promise<void>;
}

/**
 * Connects to the test server and creates a database of its own (so test
 * files running in parallel do not share tables), with the generic layout.
 */
export async function connectMysql(): Promise<MysqlConnection> {
  const url = new URL(TEST_MYSQL_URL);
  let connection: mysql.Connection;
  try {
    // As root, which may create databases; the compose server's root password is `cypher`.
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: 'root',
      password: process.env['TEST_MYSQL_ROOT_PASSWORD'] ?? 'cypher',
      supportBigNumbers: true,
      bigNumberStrings: true,
      // Every distinct SQL text is a prepared statement on the server; the
      // default cache (16,000) holds gigabytes over the TCK's queries.
      maxPreparedStatements: 64,
    });
  } catch (error) {
    throw new Error(
      `Cannot connect to MySQL at ${TEST_MYSQL_URL}. Start it with \`npm run db:up\`, ` +
        'or set TEST_MYSQL_URL.',
      { cause: error },
    );
  }
  const database = `test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  await connection.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  await connection.query(`USE ${database}`);
  await connection.query(MYSQL_SESSION);
  for (const ddl of MYSQL_SCHEMA) {
    await connection.query(ddl);
  }
  return {
    connection,
    database,
    reset: async (): Promise<void> => {
      await connection.query('SET FOREIGN_KEY_CHECKS = 0');
      await connection.query('TRUNCATE edges');
      await connection.query('TRUNCATE nodes');
      await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    },
    dispose: async (): Promise<void> => {
      try {
        await connection.query(`DROP DATABASE ${database}`);
      } finally {
        await connection.end();
      }
    },
  };
}

/**
 * Executor over one connection. Reads run in a read-only transaction with a
 * consistent snapshot, so all steps see the same data and MySQL refuses writes.
 */
export function mysqlExecutor(connection: mysql.Connection): SqlExecutor & { log: string[] } {
  const log: string[] = [];
  const tx: SqlTx = {
    query(sql: string, values: unknown[]): Promise<Row[]> {
      log.push(sql);
      return runMysqlStep(connection, sql, values);
    },
  };
  return {
    log,
    async transaction<T>(mode: 'read' | 'write', fn: (tx: SqlTx) => Promise<T>): Promise<T> {
      await connection.query(
        mode === 'read'
          ? 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'
          : 'START TRANSACTION',
      );
      try {
        const result = await fn(tx);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    },
  };
}
