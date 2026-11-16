// Write benchmarks (#69): batched ingest through this library, the pattern of
// loading a graph from files, on SQLite, PostgreSQL, and MySQL. For each batch
// size and id strategy it reports the time, the SQL statements the batch became,
// and rows per second.
//
//   npm run bench:writes                                   # sizes 1000,2000; all dialects
//   npm run bench:writes -- --dialects sqlite --sizes 500,1000,2000
//   npm run bench:writes -- --save bench/writes.json
//
// Every batch is one query (one transaction) on a fresh graph, migrated with a
// table prefix, whose node key is declared as an integer and indexed.

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import mysql2 from 'mysql2/promise';
import pg from 'pg';
import { betterSqliteExecutor } from '../examples/executors/better-sqlite3.js';
import { mysql2Executor } from '../examples/executors/mysql2.js';
import { pgExecutor } from '../examples/executors/pg.js';
import {
  createGraph,
  defaultMapping,
  migrate,
  mysql,
  postgres,
  registerSqliteFunctions,
  sqlite,
  type CypherValue,
  type Dialect,
  type GraphMapping,
  type IdStrategy,
  type SqlExecutor,
} from '../src/index.js';

const { values: args } = parseArgs({
  options: {
    dialects: { type: 'string', default: 'sqlite,postgres,mysql' },
    sizes: { type: 'string', default: '1000,2000' },
    ids: { type: 'string', default: 'database,generator' },
    save: { type: 'string' },
  },
});

const POSTGRES_URL =
  process.env['BENCH_POSTGRES_URL'] ??
  process.env['TEST_POSTGRES_URL'] ??
  'postgres://cypher:cypher@localhost:55432/cypher';
const MYSQL_URL =
  process.env['BENCH_MYSQL_URL'] ??
  process.env['TEST_MYSQL_URL'] ??
  'mysql://cypher:cypher@localhost:53306/cypher';
const MYSQL_ROOT_PASSWORD = process.env['TEST_MYSQL_ROOT_PASSWORD'] ?? 'cypher';

/** A database the batches run in; `executor` counts the statements it runs. */
interface Target {
  dialect: Dialect;
  executor: SqlExecutor;
  statements: () => number;
  close: () => Promise<void>;
}

function counting(base: SqlExecutor): { executor: SqlExecutor; statements: () => number } {
  let count = 0;
  return {
    statements: () => count,
    executor: {
      transaction: (mode, fn) =>
        base.transaction(mode, (tx) =>
          fn({
            query: (sql, values) => {
              count++;
              return tx.query(sql, values);
            },
          }),
        ),
    },
  };
}

async function open(name: string): Promise<Target> {
  if (name === 'sqlite') {
    const db = new Database(':memory:');
    db.defaultSafeIntegers(true);
    registerSqliteFunctions(db);
    const { executor, statements } = counting(betterSqliteExecutor(db));
    return {
      dialect: sqlite({ functions: true }),
      executor,
      statements,
      close: () => Promise.resolve(void db.close()),
    };
  }
  if (name === 'postgres') {
    const admin = new pg.Client({ connectionString: POSTGRES_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS bench_writes CASCADE');
    await admin.query('CREATE SCHEMA bench_writes');
    await admin.end();
    const pool = new pg.Pool({
      connectionString: POSTGRES_URL,
      options: '-c search_path=bench_writes',
      max: 2,
    });
    const { executor, statements } = counting(pgExecutor(pool, { statementTimeoutMs: 600_000 }));
    return { dialect: postgres(), executor, statements, close: () => pool.end() };
  }
  if (name === 'mysql') {
    const { hostname, port } = new URL(MYSQL_URL);
    const options = {
      host: hostname,
      port: Number(port || 3306),
      user: 'root',
      password: MYSQL_ROOT_PASSWORD,
      supportBigNumbers: true,
      bigNumberStrings: true,
      maxPreparedStatements: 64,
    };
    const admin = await mysql2.createConnection(options);
    await admin.query('DROP DATABASE IF EXISTS bench_writes');
    await admin.query('CREATE DATABASE bench_writes CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    await admin.end();
    const pool = mysql2.createPool({ ...options, database: 'bench_writes', connectionLimit: 2 });
    const { executor, statements } = counting(
      mysql2Executor(pool, { statementTimeoutMs: 600_000 }),
    );
    return { dialect: mysql(), executor, statements, close: () => pool.end() };
  }
  throw new Error(`Unknown dialect ${name}; known: sqlite, postgres, mysql`);
}

/** Node rows as a file would give them: integer keys and a few properties. */
const nodeRows = (n: number): CypherValue[] =>
  Array.from({ length: n }, (_, i) => ({
    key: BigInt(i),
    props: { name: `item ${i}`, v: BigInt(i % 100), score: i / 7 },
  }));

/** Relationship rows: each node to the next, by key. */
const linkRows = (n: number): CypherValue[] =>
  Array.from({ length: n }, (_, i) => ({ from: BigInt(i), to: BigInt((i + 1) % n) }));

const QUERIES = {
  createInline:
    'UNWIND $rows AS row CREATE (:Item {key: row.key, name: row.props.name, v: row.props.v, score: row.props.score})',
  createSet: 'UNWIND $rows AS row CREATE (n:Item {key: row.key}) SET n += row.props',
  merge: 'UNWIND $rows AS row MERGE (n:Item {key: row.key}) SET n += row.props',
  createLinks:
    'UNWIND $rows AS row MATCH (a:Item {key: row.from}) MATCH (b:Item {key: row.to}) CREATE (a)-[:LINK]->(b)',
  mergeLinks:
    'UNWIND $rows AS row MATCH (a:Item {key: row.from}) MATCH (b:Item {key: row.to}) MERGE (a)-[:LINK]->(b)',
};

interface Result {
  dialect: string;
  ids: string;
  workload: string;
  rows: number;
  ms: number | null;
  statements: number | null;
  error?: string;
}

const write = (text: string): void => void process.stdout.write(`${text}\n`);

async function main(): Promise<void> {
  const results: Result[] = [];
  const sizes = args.sizes.split(',').map(Number);
  for (const dialectName of args.dialects.split(',')) {
    const target = await open(dialectName);
    let graphs = 0;
    try {
      write(`\n### ${dialectName}\n`);
      write('| ids | workload | rows | ms | statements | statements/row | rows/s |');
      write('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
      for (const ids of args.ids.split(',')) {
        for (const size of sizes) {
          /** A fresh, migrated graph: its own table prefix in the same database. */
          const fresh = async (): Promise<ReturnType<typeof createGraph>> => {
            const mapping: GraphMapping = {
              ...defaultMapping,
              prefix: `w${graphs++}_`,
              nodes: { ...defaultMapping.nodes, propertyTypes: { key: 'integer' } },
            };
            await migrate({ dialect: target.dialect, executor: target.executor, mapping });
            let next = 1;
            const idStrategy: IdStrategy =
              ids === 'generator'
                ? { kind: 'generator', generate: () => next++ }
                : { kind: 'database' };
            return createGraph({
              dialect: target.dialect,
              executor: target.executor,
              mapping,
              readOnly: false,
              idStrategy,
              // Batches above these defaults (30 s, 100,000 entities) need them raised.
              limits: { timeoutMs: 600_000, maxCreatedEntities: 1_000_000 },
            });
          };
          const run = async (
            graph: ReturnType<typeof createGraph>,
            workload: string,
            cypher: string,
            rows: CypherValue[],
          ): Promise<void> => {
            const before = target.statements();
            const start = performance.now();
            const result: Result = {
              dialect: dialectName,
              ids,
              workload,
              rows: rows.length,
              ms: null,
              statements: null,
            };
            try {
              await graph.query(cypher, { rows });
              result.ms = performance.now() - start;
              result.statements = target.statements() - before;
            } catch (error) {
              result.error = error instanceof Error ? error.message.split('\n')[0]! : String(error);
            }
            results.push(result);
            write(
              result.ms === null
                ? `| ${ids} | ${workload} | ${size} | error: ${result.error} | | | |`
                : `| ${ids} | ${workload} | ${size} | ${result.ms.toFixed(0)} | ${result.statements} | ` +
                    `${(result.statements! / size).toFixed(1)} | ${Math.round((size / result.ms) * 1000)} |`,
            );
          };

          const inline = await fresh();
          await run(inline, 'CREATE, properties inline', QUERIES.createInline, nodeRows(size));
          const graph = await fresh();
          await run(graph, 'CREATE, then SET +=', QUERIES.createSet, nodeRows(size));
          await run(graph, 'MERGE, nodes exist', QUERIES.merge, nodeRows(size));
          await run(graph, 'CREATE relationships', QUERIES.createLinks, linkRows(size));
          await run(graph, 'MERGE, relationships exist', QUERIES.mergeLinks, linkRows(size));
          await run(await fresh(), 'MERGE, nodes new', QUERIES.merge, nodeRows(size));
        }
      }
    } finally {
      await target.close();
    }
  }
  if (args.save) {
    writeFileSync(
      args.save,
      `${JSON.stringify({ date: new Date().toISOString(), results }, null, 2)}\n`,
    );
  }
}

await main();
