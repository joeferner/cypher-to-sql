// The reference engines for the benchmarks: Neo4j (Bolt) and ArcadeDB (HTTP,
// its own openCypher engine). They load the same generated graph as SQLite and
// PostgreSQL (with the statements of the differential tests, diff/engines.ts),
// with indexes comparable to load.ts: Person(name), Person(age), and the `gid`
// key the loader matches relationships by. A query is timed up to its rows,
// counted, without converting them further.

import neo4j, { type Driver } from 'neo4j-driver';
import type { CypherValue } from '../src/index.js';
import { createStatements, generated } from '../diff/engines.js';
import { parseJson, toJson, type Json } from '../diff/values.js';
import type { GraphSpec } from './graphs.js';

export interface ReferenceEngine {
  name: string;
  load(spec: GraphSpec): Promise<void>;
  /** Runs a read query; returns the number of rows. */
  query(cypher: string, params: Record<string, CypherValue>): Promise<number>;
  close(): Promise<void>;
}

/** Rows per statement when loading. */
const BATCH = 5_000;

export function neo4jBench(url: string): ReferenceEngine {
  const driver: Driver = neo4j.driver(url, neo4j.auth.basic('neo4j', 'cypherpass'), {
    useBigInt: true,
  });
  const write = async (cypher: string, params: Record<string, CypherValue> = {}): Promise<void> => {
    await driver.executeQuery(cypher, params);
  };
  return {
    name: 'neo4j',
    async load(spec): Promise<void> {
      // In batches: one transaction for a large graph needs more heap than it has.
      for (;;) {
        const { records } = await driver.executeQuery(
          'MATCH (n) WITH n LIMIT 10000 DETACH DELETE n RETURN count(*) AS c',
        );
        if (Number(records[0]?.get('c') ?? 0) === 0) {
          break;
        }
      }
      for (const [label, property] of [
        ['Person', 'gid'],
        ['Company', 'gid'],
        ['Person', 'name'],
        ['Person', 'age'],
      ]) {
        await write(
          `CREATE INDEX bench_${label}_${property} IF NOT EXISTS FOR (n:${label}) ON (n.${property})`,
        );
      }
      await write('CALL db.awaitIndexes()');
      for (const { cypher, params } of createStatements(generated(spec), BATCH)) {
        await write(cypher, params);
      }
    },
    async query(cypher, params): Promise<number> {
      const { records } = await driver.executeQuery(cypher, params, {
        routing: neo4j.routing.READ,
      });
      return records.length;
    },
    close: () => driver.close(),
  };
}

export function arcadeBench(url: string): ReferenceEngine {
  const DATABASE = 'graph';
  const auth = `Basic ${Buffer.from('root:cypherpass').toString('base64')}`;
  const send = (path: string, body: string): Promise<Response> =>
    fetch(`${url}/api/v1/${path}`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body,
    });
  const post = async (path: string, body: string): Promise<{ [key: string]: Json }> => {
    let response: Response;
    try {
      response = await send(path, body);
    } catch (error) {
      // A kept-alive connection the server closed while it was idle (during
      // another engine's run) fails on write, before the request arrives: retry.
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code !== 'EPIPE' && code !== 'ECONNRESET' && code !== 'UND_ERR_SOCKET') {
        throw error;
      }
      response = await send(path, body);
    }
    const json = parseJson(await response.text()) as { [key: string]: Json };
    if (json['error'] !== undefined) {
      const detail = json['detail'] ?? json['error'];
      throw new Error(typeof detail === 'string' ? detail : 'ArcadeDB error');
    }
    return json;
  };
  const sql = (command: string): Promise<{ [key: string]: Json }> =>
    post(`command/${DATABASE}`, JSON.stringify({ language: 'sql', command }));
  const cypherBody = (cypher: string, params: Record<string, CypherValue>): string =>
    `{"language":"opencypher","command":${JSON.stringify(cypher)},"params":${toJson(params)}}`;
  const server = (command: string): Promise<{ [key: string]: Json }> =>
    post('server', JSON.stringify({ command }));
  return {
    name: 'arcadedb',
    async load(spec): Promise<void> {
      await server(`drop database ${DATABASE}`).catch(() => undefined);
      await server(`create database ${DATABASE}`);
      // Types and indexes first: the loader matches relationships' ends by gid.
      for (const type of ['Person', 'Company']) {
        await sql(`CREATE VERTEX TYPE ${type}`);
        await sql(`CREATE PROPERTY ${type}.gid LONG`);
        await sql(`CREATE INDEX ON ${type} (gid) NOTUNIQUE`);
      }
      await sql('CREATE PROPERTY Person.name STRING');
      await sql('CREATE INDEX ON Person (name) NOTUNIQUE');
      await sql('CREATE PROPERTY Person.age LONG');
      await sql('CREATE INDEX ON Person (age) NOTUNIQUE');
      for (const type of ['KNOWS', 'WORKS_AT']) {
        await sql(`CREATE EDGE TYPE ${type}`);
      }
      for (const { cypher, params } of createStatements(generated(spec), BATCH)) {
        await post(`command/${DATABASE}`, cypherBody(cypher, params));
      }
    },
    async query(cypher, params): Promise<number> {
      const json = await post(`query/${DATABASE}`, cypherBody(cypher, params));
      if (json['truncated'] === true) {
        throw new Error('ArcadeDB truncated the result');
      }
      return (json['result'] as Json[]).length;
    },
    close: () => Promise.resolve(),
  };
}
