import { mysql, postgres, sqlite, type Dialect, type SqlExecutor } from '../../src/index.js';
import { connectMysql, mysqlExecutor, type MysqlConnection } from './mysql.js';
import { connectPostgres, postgresExecutor, type PostgresConnection } from './postgres.js';
import { createSqliteDatabase, sqliteExecutor } from './sqlite.js';

/** A database the tests can run on. Each `open()` gives an empty graph. */
export interface TestBackend {
  /** Dialect name, also the key in the TCK allow-list. */
  name: string;
  open(): Promise<TestDatabase>;
  /** Releases resources shared across `open()` calls, after the last one. */
  dispose?(): Promise<void>;
}

export interface TestDatabase {
  dialect: Dialect;
  executor: SqlExecutor;
  close(): Promise<void>;
}

export const sqliteBackend: TestBackend = {
  name: 'sqlite',
  open() {
    const db = createSqliteDatabase();
    return Promise.resolve({
      // With the functions registerSqliteFunctions adds (see createSqliteDatabase).
      dialect: sqlite({ functions: true }),
      executor: sqliteExecutor(db),
      close: () => {
        db.close();
        return Promise.resolve();
      },
    });
  },
};

/**
 * One connection and schema for the whole test file (its tests run one at a
 * time); each `open()` starts from empty tables.
 */
export function postgresBackend(): TestBackend {
  let connection: Promise<PostgresConnection> | undefined;
  return {
    name: 'postgres',
    async open(): Promise<TestDatabase> {
      connection ??= connectPostgres();
      const { client, reset } = await connection;
      await reset();
      return {
        dialect: postgres(),
        executor: postgresExecutor(client),
        close: () => Promise.resolve(),
      };
    },
    async dispose(): Promise<void> {
      if (connection) {
        await (await connection).dispose();
      }
    },
  };
}

/** Like postgresBackend: one connection and database for the whole test file. */
export function mysqlBackend(): TestBackend {
  let connection: Promise<MysqlConnection> | undefined;
  return {
    name: 'mysql',
    async open(): Promise<TestDatabase> {
      connection ??= connectMysql();
      const { connection: conn, reset } = await connection;
      await reset();
      return {
        dialect: mysql(),
        executor: mysqlExecutor(conn),
        close: () => Promise.resolve(),
      };
    },
    async dispose(): Promise<void> {
      if (connection) {
        await (await connection).dispose();
      }
    },
  };
}

/**
 * Fresh backends for one test file: every test runs on each dialect, or on the
 * ones named in TEST_BACKENDS (comma-separated: sqlite, postgres, mysql).
 */
export function testBackends(): TestBackend[] {
  const all = [sqliteBackend, postgresBackend(), mysqlBackend()];
  const only = process.env['TEST_BACKENDS']?.split(',').map((s) => s.trim());
  return only ? all.filter((b) => only.includes(b.name)) : all;
}
