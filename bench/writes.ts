// Write benchmarks (#69): batched ingest, the pattern of loading a graph from
// files, through this library on SQLite, PostgreSQL, and MySQL, and the same
// Cypher on Neo4j and ArcadeDB (npm run db:up:reference). For each batch size
// and id strategy it reports the time, the SQL statements the batch became
// (this library only), and rows per second.
//
//   npm run bench:writes                                   # sizes 1000,2000; the SQL dialects
//   npm run bench:writes -- --dialects sqlite --sizes 500,1000,2000
//   npm run bench:writes -- --dialects neo4j,arcadedb --sizes 1000
//   npm run bench:writes -- --save bench/writes.json
//
// Every batch is one query (one transaction) on a fresh graph whose node key is
// indexed: for this library migrated with a table prefix and the key declared
// as an integer; on Neo4j and ArcadeDB an index on Item(key).

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import mysql2 from 'mysql2/promise';
import neo4j from 'neo4j-driver';
import pg from 'pg';
import { parseJson, toJson, type Json } from '../diff/values.js';
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
  type BulkNode,
  type BulkRelationship,
  type Dialect,
  type Graph,
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
const NEO4J_URL = process.env['NEO4J_URL'] ?? 'bolt://localhost:57687';
const ARCADEDB_URL = process.env['ARCADEDB_URL'] ?? 'http://localhost:52480';

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

/**
 * Node rows as a file would give them: integer keys and a few properties,
 * among them `doc`, the document the node comes from (one per batch, as when
 * each file is loaded on its own).
 */
const nodeRows = (n: number): CypherValue[] =>
  Array.from({ length: n }, (_, i) => ({
    key: BigInt(i),
    props: { name: `item ${i}`, v: BigInt(i % 100), score: i / 7, doc: 1n },
  }));

/** Relationship rows: each node to the next, by key (and by document and key). */
const linkRows = (n: number): CypherValue[] =>
  Array.from({ length: n }, (_, i) => ({
    doc: 1n,
    from: BigInt(i),
    to: BigInt((i + 1) % n),
    props: { weight: i / 3, since: BigInt(2000 + (i % 25)) },
  }));

/** The same nodes and relationships as `graph.bulkWrite` input (#89). */
const bulkNodes = (n: number): BulkNode[] =>
  nodeRows(n).map((row) => {
    const { key, props } = row as { key: bigint; props: Record<string, unknown> };
    return { labels: ['Item'], properties: { key, ...props } };
  });
const bulkLinks = (n: number): BulkRelationship[] =>
  linkRows(n).map((row) => {
    const { doc, from, to, props } = row as {
      doc: bigint;
      from: bigint;
      to: bigint;
      props: Record<string, unknown>;
    };
    return {
      type: 'LINK4',
      start: { label: 'Item', match: { doc, key: from } },
      end: { label: 'Item', match: { doc, key: to } },
      properties: props,
    };
  });
const BULK_KEY = { nodeKey: { Item: ['doc', 'key'] } };

const QUERIES = {
  createInline:
    'UNWIND $rows AS row CREATE (:Item {key: row.key, name: row.props.name, v: row.props.v, score: row.props.score})',
  createSet: 'UNWIND $rows AS row CREATE (n:Item {key: row.key}) SET n += row.props',
  merge: 'UNWIND $rows AS row MERGE (n:Item {key: row.key}) SET n += row.props',
  createLinks:
    'UNWIND $rows AS row MATCH (a:Item {key: row.from}) MATCH (b:Item {key: row.to}) CREATE (a)-[:LINK]->(b)',
  mergeLinks:
    'UNWIND $rows AS row MATCH (a:Item {key: row.from}) MATCH (b:Item {key: row.to}) MERGE (a)-[:LINK]->(b)',
  // A node identified by its document and its key within it (#84).
  createLinksTwoKeys:
    'UNWIND $rows AS row MATCH (a:Item {doc: row.doc, key: row.from}) MATCH (b:Item {doc: row.doc, key: row.to}) CREATE (a)-[:LINK2]->(b)',
  // The relationship's properties from a map, as a loader whose keys vary gets them (#85).
  createLinksSet:
    'UNWIND $rows AS row MATCH (a:Item {key: row.from}) MATCH (b:Item {key: row.to}) CREATE (a)-[r:LINK3]->(b) SET r += row.props',
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

/** Rows of the untimed first round. */
const WARMUP = 100;

/**
 * Runs one query on a graph; returns the column `c` of its first row, if any
 * (for checks). `graph` is the graph itself, for the bulk API (this library only).
 */
type Runner = ((
  cypher: string,
  params: Record<string, CypherValue>,
) => Promise<number | undefined>) & { graph?: Graph };

const firstC = (row: Record<string, unknown> | undefined): number | undefined =>
  row?.['c'] === undefined ? undefined : Number(row['c']);

/** Where the batches run: this library on a dialect, or a reference engine. */
interface Engine {
  /** The id strategies to compare (`native` for a reference engine). */
  ids: string[];
  /** A fresh, empty graph with `Item(key)` indexed. */
  fresh(ids: string): Promise<Runner>;
  /** SQL statements run so far (this library only). */
  statements?: () => number;
  close(): Promise<void>;
}

async function engine(name: string): Promise<Engine> {
  if (name === 'neo4j') {
    return neo4jEngine(NEO4J_URL);
  }
  if (name === 'arcadedb') {
    return arcadeEngine(ARCADEDB_URL);
  }
  const target = await open(name);
  let graphs = 0;
  return {
    ids: args.ids.split(','),
    statements: target.statements,
    close: target.close,
    /** A fresh, migrated graph: its own table prefix in the same database. */
    async fresh(ids): Promise<Runner> {
      const mapping: GraphMapping = {
        ...defaultMapping,
        prefix: `w${graphs++}_`,
        nodes: {
          ...defaultMapping.nodes,
          propertyTypes: { key: 'integer', doc: 'integer' },
          indexes: [{ keys: ['doc', 'key'] }],
        },
      };
      await migrate({ dialect: target.dialect, executor: target.executor, mapping });
      let next = 1;
      const idStrategy: IdStrategy =
        ids === 'generator' ? { kind: 'generator', generate: () => next++ } : { kind: 'database' };
      const graph = createGraph({
        dialect: target.dialect,
        executor: target.executor,
        mapping,
        readOnly: false,
        idStrategy,
        // Batches above these defaults (30 s, 100,000 entities) need them raised.
        limits: { timeoutMs: 600_000, maxCreatedEntities: 1_000_000 },
      });
      const runner: Runner = async (cypher, params) =>
        firstC((await graph.query(cypher, params))[0]);
      runner.graph = graph;
      return runner;
    },
  };
}

/**
 * Neo4j (Community has one database, so a fresh graph is the emptied one: run
 * `npm run bench` with Neo4j afterwards, which loads its graph again).
 */
function neo4jEngine(url: string): Engine {
  const driver = neo4j.driver(url, neo4j.auth.basic('neo4j', 'cypherpass'), { useBigInt: true });
  return {
    ids: ['native'],
    async fresh(): Promise<Runner> {
      for (;;) {
        const { records } = await driver.executeQuery(
          'MATCH (n) WITH n LIMIT 10000 DETACH DELETE n RETURN count(*) AS c',
        );
        if (Number(records[0]?.get('c') ?? 0) === 0) {
          break;
        }
      }
      await driver.executeQuery(
        'CREATE INDEX bench_item_key IF NOT EXISTS FOR (n:Item) ON (n.key)',
      );
      await driver.executeQuery(
        'CREATE INDEX bench_item_doc_key IF NOT EXISTS FOR (n:Item) ON (n.doc, n.key)',
      );
      await driver.executeQuery('CALL db.awaitIndexes()');
      return async (cypher, params) => {
        const { records } = await driver.executeQuery(cypher, params);
        return records[0]?.has('c') ? Number(records[0].get('c')) : undefined;
      };
    },
    close: () => driver.close(),
  };
}

/** ArcadeDB, in a database of its own (`writes`), created again for each fresh graph. */
function arcadeEngine(url: string): Engine {
  const DATABASE = 'writes';
  const auth = `Basic ${Buffer.from('root:cypherpass').toString('base64')}`;
  const post = async (path: string, body: string): Promise<{ [key: string]: Json }> => {
    const response = await fetch(`${url}/api/v1/${path}`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body,
    });
    const json = parseJson(await response.text()) as { [key: string]: Json };
    if (json['error'] !== undefined) {
      const detail = json['detail'] ?? json['error'];
      throw new Error(typeof detail === 'string' ? detail : 'ArcadeDB error');
    }
    return json;
  };
  const sql = async (command: string): Promise<void> =>
    void (await post(`command/${DATABASE}`, JSON.stringify({ language: 'sql', command })));
  return {
    ids: ['native'],
    async fresh(): Promise<Runner> {
      await post('server', JSON.stringify({ command: `drop database ${DATABASE}` })).catch(
        () => undefined,
      );
      await post('server', JSON.stringify({ command: `create database ${DATABASE}` }));
      await sql('CREATE VERTEX TYPE Item');
      await sql('CREATE PROPERTY Item.key LONG');
      await sql('CREATE INDEX ON Item (key) NOTUNIQUE');
      await sql('CREATE PROPERTY Item.doc LONG');
      await sql('CREATE INDEX ON Item (doc, key) NOTUNIQUE');
      await sql('CREATE EDGE TYPE LINK');
      await sql('CREATE EDGE TYPE LINK2');
      await sql('CREATE EDGE TYPE LINK3');
      return async (cypher, params) => {
        const json = await post(
          `command/${DATABASE}`,
          `{"language":"opencypher","command":${JSON.stringify(cypher)},"params":${toJson(params)}}`,
        );
        const rows = json['result'];
        return Array.isArray(rows)
          ? firstC(rows[0] as Record<string, unknown> | undefined)
          : undefined;
      };
    },
    close: async () =>
      void (await post('server', JSON.stringify({ command: `drop database ${DATABASE}` }))),
  };
}

async function main(): Promise<void> {
  const results: Result[] = [];
  const sizes = args.sizes.split(',').map(Number);
  for (const name of args.dialects.split(',')) {
    const target = await engine(name);
    try {
      write(`\n### ${name}\n`);
      write('| ids | workload | rows | ms | statements | statements/row | rows/s |');
      write('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
      for (const ids of target.ids) {
        // A first, untimed round of 100 rows, so that every engine is timed
        // warm (query plans cached, JIT compiled, connections open).
        for (const size of [WARMUP, ...sizes]) {
          const timed = size !== WARMUP;
          /** Times `work`, which writes `size` rows. */
          const time = async (workload: string, work: () => Promise<unknown>): Promise<void> => {
            if (!timed) {
              await work();
              return;
            }
            const before = target.statements?.();
            const start = performance.now();
            const result: Result = {
              dialect: name,
              ids,
              workload,
              rows: size,
              ms: null,
              statements: null,
            };
            try {
              await work();
              result.ms = performance.now() - start;
              result.statements = before === undefined ? null : target.statements!() - before;
            } catch (error) {
              result.error = error instanceof Error ? error.message.split('\n')[0]! : String(error);
            }
            results.push(result);
            const statements =
              result.statements === null
                ? '- | -'
                : `${result.statements} | ${(result.statements / size).toFixed(1)}`;
            write(
              result.ms === null
                ? `| ${ids} | ${workload} | ${size} | error: ${result.error} | | | |`
                : `| ${ids} | ${workload} | ${size} | ${result.ms.toFixed(0)} | ${statements} | ` +
                    `${Math.round((size / result.ms) * 1000)} |`,
            );
          };
          const run = (
            graph: Runner,
            workload: string,
            cypher: string,
            rows: CypherValue[],
          ): Promise<void> => time(workload, () => graph(cypher, { rows }));

          await run(
            await target.fresh(ids),
            'CREATE, properties inline',
            QUERIES.createInline,
            nodeRows(size),
          );
          const graph = await target.fresh(ids);
          await run(graph, 'CREATE, then SET +=', QUERIES.createSet, nodeRows(size));
          await run(graph, 'MERGE, nodes exist', QUERIES.merge, nodeRows(size));
          await run(graph, 'CREATE relationships', QUERIES.createLinks, linkRows(size));
          await run(graph, 'MERGE, relationships exist', QUERIES.mergeLinks, linkRows(size));
          await run(
            graph,
            'CREATE relationships, then SET +=',
            QUERIES.createLinksSet,
            linkRows(size),
          );
          await run(
            graph,
            'CREATE relationships, two keys',
            QUERIES.createLinksTwoKeys,
            linkRows(size),
          );
          // The writes did what they say: MERGE matched instead of creating, and SET wrote.
          for (const check of [
            'MATCH (n:Item) RETURN count(n) AS c',
            'MATCH (n:Item) WHERE n.name IS NOT NULL RETURN count(n) AS c',
            'MATCH (:Item)-[r:LINK]->(:Item) RETURN count(r) AS c',
            'MATCH (:Item)-[r:LINK2]->(:Item) RETURN count(r) AS c',
            'MATCH (:Item)-[r:LINK3]->(:Item) WHERE r.since IS NOT NULL RETURN count(r) AS c',
          ]) {
            const count = await graph(check, {});
            if (count !== size) {
              write(
                `| ${ids} | check failed: ${check} gave ${String(count)}, not ${size} | | | | | |`,
              );
            }
          }
          await run(await target.fresh(ids), 'MERGE, nodes new', QUERIES.merge, nodeRows(size));

          // The bulk API (#89), this library only: nodes without a key (an
          // insert, as CREATE); nodes by (doc, key), new and then again
          // (merged); and relationships between them.
          const plain = (await target.fresh(ids)).graph;
          if (plain) {
            await time('bulkWrite, nodes, no key', () =>
              plain.bulkWrite({ nodes: bulkNodes(size) }),
            );
          }
          const bulk = await target.fresh(ids);
          if (bulk.graph) {
            const g = bulk.graph;
            await time('bulkWrite, nodes new', () =>
              g.bulkWrite({ nodes: bulkNodes(size) }, BULK_KEY),
            );
            await time('bulkWrite, nodes exist', () =>
              g.bulkWrite({ nodes: bulkNodes(size) }, BULK_KEY),
            );
            await time('bulkWrite, relationships', () =>
              g.bulkWrite({ relationships: bulkLinks(size) }),
            );
            for (const check of [
              'MATCH (n:Item) WHERE n.name IS NOT NULL RETURN count(n) AS c',
              'MATCH (:Item)-[r:LINK4]->(:Item) WHERE r.since IS NOT NULL RETURN count(r) AS c',
            ]) {
              const count = await bulk(check, {});
              if (count !== size) {
                write(
                  `| ${ids} | check failed: ${check} gave ${String(count)}, not ${size} | | | | | |`,
                );
              }
            }
          }
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
