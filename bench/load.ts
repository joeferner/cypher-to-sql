// Loads a reference graph into SQLite, PostgreSQL, or MySQL with the example
// schema (examples/schema), plus expression indexes for the declared properties.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import mysql2 from 'mysql2/promise';
import pg from 'pg';
import { betterSqliteExecutor } from '../examples/executors/better-sqlite3.js';
import { mysql2Executor } from '../examples/executors/mysql2.js';
import { pgExecutor } from '../examples/executors/pg.js';
import {
  defaultMapping,
  mysql,
  postgres,
  registerSqliteFunctions,
  sqlite,
  type Dialect,
  type GraphMapping,
  type SqlExecutor,
} from '../src/index.js';
import type { Graph } from './graphs.js';

/** The mapping that declares `name` and `age`, which the indexes below match. */
export const DECLARED: GraphMapping = {
  ...defaultMapping,
  nodes: { ...defaultMapping.nodes, propertyTypes: { name: 'string', age: 'integer' } },
};

export interface LoadedGraph {
  dialect: Dialect;
  executor: SqlExecutor;
  close: () => Promise<void>;
}

const schema = (file: string): string =>
  readFileSync(join(import.meta.dirname, '../examples/schema', file), 'utf8');

const BATCH = 5_000;

function batches<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    out.push(items.slice(i, i + BATCH));
  }
  return out;
}

export function loadSqlite(graph: Graph): Promise<LoadedGraph> {
  const db = new Database(':memory:');
  registerSqliteFunctions(db);
  db.exec(schema('sqlite.sql'));
  db.exec(`
    CREATE INDEX nodes_name ON nodes (properties ->> '$."name"');
    CREATE INDEX nodes_age ON nodes (properties ->> '$."age"');
  `);
  const node = db.prepare('INSERT INTO nodes (id, labels, properties) VALUES (?, ?, ?)');
  const edge = db.prepare(
    'INSERT INTO edges (id, start_id, end_id, type, properties) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (const n of graph.nodes) {
      node.run(n.id, JSON.stringify(n.labels), JSON.stringify(n.properties));
    }
    for (const e of graph.edges) {
      edge.run(e.id, e.start, e.end, e.type, JSON.stringify(e.properties));
    }
  })();
  db.exec('ANALYZE');
  return Promise.resolve({
    dialect: sqlite({ functions: true }),
    executor: betterSqliteExecutor(db),
    close: () => Promise.resolve(void db.close()),
  });
}

/** Loads `graph` into the schema `name`, which is dropped first. */
export async function loadPostgres(
  graph: Graph,
  url: string,
  name = `bench_${graph.spec.name}`,
): Promise<LoadedGraph> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    await admin.query(`CREATE SCHEMA ${name}`);
    await admin.query(`SET search_path TO ${name}`);
    await admin.query(schema('postgres.sql'));
    await admin.query(`
      CREATE INDEX nodes_name ON nodes ((properties ->> 'name'));
      CREATE INDEX nodes_age ON nodes (((properties ->> 'age')::bigint));
    `);
    for (const rows of batches(graph.nodes)) {
      await admin.query(
        `INSERT INTO nodes (id, labels, properties)
         SELECT (r ->> 'id')::bigint, r -> 'labels', r -> 'properties'
         FROM jsonb_array_elements($1::jsonb) AS r`,
        [JSON.stringify(rows)],
      );
    }
    for (const rows of batches(graph.edges)) {
      await admin.query(
        `INSERT INTO edges (id, start_id, end_id, type, properties)
         SELECT (r ->> 'id')::bigint, (r ->> 'start')::bigint, (r ->> 'end')::bigint,
                r ->> 'type', r -> 'properties'
         FROM jsonb_array_elements($1::jsonb) AS r`,
        [JSON.stringify(rows)],
      );
    }
    await admin.query(`SELECT setval(pg_get_serial_sequence('nodes', 'id'), max(id)) FROM nodes`);
    await admin.query(`SELECT setval(pg_get_serial_sequence('edges', 'id'), max(id)) FROM edges`);
    await admin.query('ANALYZE');
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${name}`, max: 2 });
  return {
    dialect: postgres(),
    executor: pgExecutor(pool, { statementTimeoutMs: 120_000 }),
    close: () => pool.end(),
  };
}

/**
 * Loads `graph` into the database `name` (dropped first) of the MySQL server at
 * `url`, as root (`rootPassword`), with a functional index for the declared
 * integer property (see examples/schema/mysql.sql).
 */
export async function loadMysql(
  graph: Graph,
  url: string,
  rootPassword: string,
  name = `bench_${graph.spec.name}`,
): Promise<LoadedGraph> {
  const { hostname, port } = new URL(url);
  const options = {
    host: hostname,
    port: Number(port || 3306),
    user: 'root',
    password: rootPassword,
    supportBigNumbers: true,
    bigNumberStrings: true,
    maxPreparedStatements: 64,
  };
  const admin = await mysql2.createConnection({ ...options, multipleStatements: true });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    await admin.query(`USE ${name}`);
    await admin.query(schema('mysql.sql'));
    // MySQL does not use a functional index for a declared string, so `name` has none.
    await admin.query(
      `CREATE INDEX nodes_age ON nodes ((CAST(JSON_EXTRACT(properties, '$."age"') AS SIGNED)))`,
    );
    for (const rows of batches(graph.nodes)) {
      await admin.query('INSERT INTO nodes (id, labels, properties) VALUES ?', [
        rows.map((n) => [n.id, JSON.stringify(n.labels), JSON.stringify(n.properties)]),
      ]);
    }
    for (const rows of batches(graph.edges)) {
      await admin.query('INSERT INTO edges (id, start_id, end_id, type, properties) VALUES ?', [
        rows.map((e) => [e.id, e.start, e.end, e.type, JSON.stringify(e.properties)]),
      ]);
    }
    await admin.query('ANALYZE TABLE nodes, edges');
  } finally {
    await admin.end();
  }
  const pool = mysql2.createPool({ ...options, database: name, connectionLimit: 2 });
  return {
    dialect: mysql(),
    executor: mysql2Executor(pool, { statementTimeoutMs: 120_000 }),
    close: () => pool.end(),
  };
}
