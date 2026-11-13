// The engines a differential test runs on: this library on SQLite and
// PostgreSQL, and the reference engines Neo4j (Bolt) and ArcadeDB (HTTP, its
// own openCypher engine). Each loads a graph, then runs read queries.

import neo4j, { type Driver } from 'neo4j-driver';
import {
  createGraph,
  defaultMapping,
  parse,
  UnsupportedFeatureError,
  type CypherMap,
  type CypherValue,
  type GraphMapping,
} from '../src/index.js';
import { generateGraph, type Graph, type GraphSpec } from '../bench/graphs.js';
import { loadPostgres, loadSqlite, type LoadedGraph } from '../bench/load.js';
import {
  canonicalRow,
  fromArcade,
  fromCypher,
  fromNeo4j,
  parseJson,
  toJson,
  type Json,
} from './values.js';

/** A graph to test on: a generated reference graph, or one built by a CREATE query. */
export type GraphSource = { generate: GraphSpec } | { create: string };

/** Rows in canonical form, or the error the query raised. */
export type Outcome = { rows: string[] } | { error: string; unsupported?: boolean };

export interface Engine {
  name: string;
  load(name: string, source: GraphSource): Promise<void>;
  run(cypher: string, params: Record<string, CypherValue>): Promise<Outcome>;
  close(): Promise<void>;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message.split('\n')[0]! : String(error);

/**
 * A generated graph, with each node's id as its `gid` property so the
 * reference engines can connect relationships (and every engine has the same
 * properties).
 */
function generated(spec: GraphSpec): Graph {
  const graph = generateGraph(spec);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({ ...n, properties: { ...n.properties, gid: n.id } })),
  };
}

const EMPTY: Graph = {
  spec: { name: 'empty', nodes: 0, degree: 0, seed: 0 },
  nodes: [],
  edges: [],
  persons: 0,
};

/** A JSON number as the databases read it: integral numbers are integers. */
const value = (n: string | number): CypherValue =>
  typeof n === 'number' && Number.isInteger(n) ? BigInt(n) : n;

const props = (p: Record<string, string | number>): Record<string, CypherValue> =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, value(v)]));

/**
 * The Cypher statements (with parameters) that create a generated graph in a
 * reference engine: nodes per label, then relationships per (start label,
 * type, end label), matched by `gid`.
 */
function createStatements(graph: Graph): { cypher: string; params: Record<string, CypherValue> }[] {
  const BATCH = 500;
  const out: { cypher: string; params: Record<string, CypherValue> }[] = [];
  const label = new Map(graph.nodes.map((n) => [n.id, n.labels[0]!]));
  const groups = new Map<string, Record<string, CypherValue>[]>();
  const add = (key: string, row: Record<string, CypherValue>): void => {
    groups.set(key, [...(groups.get(key) ?? []), row]);
  };
  for (const n of graph.nodes) {
    add(`node|${n.labels[0]!}`, props(n.properties));
  }
  for (const e of graph.edges) {
    add(`edge|${label.get(e.start)!}|${e.type}|${label.get(e.end)!}`, {
      s: BigInt(e.start),
      e: BigInt(e.end),
      p: props(e.properties),
    });
  }
  for (const [key, rows] of groups) {
    const [kind, a, type, b] = key.split('|');
    const cypher =
      kind === 'node'
        ? `UNWIND $rows AS row CREATE (n:${a}) SET n = row`
        : `UNWIND $rows AS row MATCH (a:${a} {gid: row.s}), (b:${b} {gid: row.e})
           CREATE (a)-[r:${type}]->(b) SET r = row.p`;
    for (let i = 0; i < rows.length; i += BATCH) {
      out.push({ cypher, params: { rows: rows.slice(i, i + BATCH) } });
    }
  }
  return out;
}

// ---- this library ---------------------------------------------------------------

/**
 * This library on one dialect, with the default mapping. `as` gives the same
 * database queried with another mapping.
 */
export function ours(
  dialect: 'sqlite' | 'postgres',
  postgresUrl: string,
): Engine & { as(name: string, mapping: GraphMapping): Engine } {
  let db: LoadedGraph | undefined;
  const run =
    (mapping: GraphMapping) =>
    async (cypher: string, params: Record<string, CypherValue>): Promise<Outcome> => {
      const graph = createGraph({ dialect: db!.dialect, executor: db!.executor, mapping });
      try {
        const rows = await graph.query(cypher, params);
        return { rows: rows.map(canonical(fromCypher)) };
      } catch (error) {
        return { error: message(error), unsupported: error instanceof UnsupportedFeatureError };
      }
    };
  const unsupported = (): Promise<void> => Promise.reject(new Error('load the base engine'));
  return {
    name: dialect,
    as: (name, mapping) => ({ name, load: unsupported, run: run(mapping), close: unsupported }),
    run: run(defaultMapping),
    async load(graphName, source): Promise<void> {
      await db?.close();
      const graph = 'generate' in source ? generated(source.generate) : EMPTY;
      db =
        dialect === 'sqlite'
          ? await loadSqlite(graph)
          : await loadPostgres(graph, postgresUrl, `diff_${graphName}`);
      if ('create' in source) {
        await createGraph({ dialect: db.dialect, executor: db.executor, readOnly: false }).query(
          source.create,
        );
      }
    },
    async close(): Promise<void> {
      await db?.close();
    },
  };
}

const canonical =
  <T>(f: (v: T) => string) =>
  (row: Record<string, T> | CypherMap): string =>
    canonicalRow(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, f(v as T)])));

// ---- Neo4j ----------------------------------------------------------------------

export function neo4jEngine(url: string): Engine {
  const driver: Driver = neo4j.driver(url, neo4j.auth.basic('neo4j', 'cypherpass'), {
    useBigInt: true,
  });
  const write = async (cypher: string, params: Record<string, CypherValue> = {}): Promise<void> => {
    await driver.executeQuery(cypher, params);
  };
  return {
    name: 'neo4j',
    async load(_name, source): Promise<void> {
      await write('MATCH (n) DETACH DELETE n');
      if ('create' in source) {
        await write(source.create);
        return;
      }
      const graph = generated(source.generate);
      for (const label of new Set(graph.nodes.map((n) => n.labels[0]!))) {
        await write(`CREATE INDEX diff_${label}_gid IF NOT EXISTS FOR (n:${label}) ON (n.gid)`);
      }
      await write('CALL db.awaitIndexes()');
      for (const { cypher, params } of createStatements(graph)) {
        await write(cypher, params);
      }
    },
    async run(cypher, params): Promise<Outcome> {
      try {
        const { records } = await driver.executeQuery(cypher, params, {
          routing: neo4j.routing.READ,
        });
        return { rows: records.map((r) => canonical(fromNeo4j)(r.toObject())) };
      } catch (error) {
        return { error: message(error) };
      }
    },
    close: () => driver.close(),
  };
}

// ---- ArcadeDB -------------------------------------------------------------------

/** The column name when the query's final RETURN has a single item. */
function singleColumn(cypher: string): string | undefined {
  try {
    const ret = parse(cypher).clauses.at(-1);
    return ret?.type === 'Return' && !ret.star && ret.items.length === 1
      ? ret.items[0]!.name
      : undefined;
  } catch {
    return undefined;
  }
}

export function arcadeEngine(url: string): Engine {
  const DATABASE = 'graph';
  const auth = `Basic ${Buffer.from('root:cypherpass').toString('base64')}`;
  const post = async (path: string, body: string): Promise<Json> => {
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
  const cypherBody = (cypher: string, params: Record<string, CypherValue>): string =>
    `{"language":"opencypher","command":${JSON.stringify(cypher)},"params":${toJson(params)}}`;
  const server = (command: string): Promise<Json> => post('server', JSON.stringify({ command }));
  return {
    name: 'arcadedb',
    async load(_name, source): Promise<void> {
      await server(`drop database ${DATABASE}`).catch(() => undefined);
      await server(`create database ${DATABASE}`);
      const statements =
        'create' in source
          ? [{ cypher: source.create, params: {} }]
          : createStatements(generated(source.generate));
      for (const { cypher, params } of statements) {
        await post(`command/${DATABASE}`, cypherBody(cypher, params));
      }
    },
    async run(cypher, params): Promise<Outcome> {
      try {
        const json = (await post(`query/${DATABASE}`, cypherBody(cypher, params))) as {
          [key: string]: Json;
        };
        if (json['truncated'] === true) {
          return { error: 'ArcadeDB truncated the result' };
        }
        // ArcadeDB returns a single node or relationship column as the row itself.
        const single = singleColumn(cypher);
        const rows = (json['result'] as { [key: string]: Json }[]).map((row) =>
          row['@cat'] !== undefined && single !== undefined ? { [single]: row } : row,
        );
        return { rows: rows.map(canonical(fromArcade)) };
      } catch (error) {
        return { error: message(error) };
      }
    },
    close: () => Promise.resolve(),
  };
}
