// The example executors and schema files in examples/, which the docs point
// to, run against real databases.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  CypherArgumentError,
  CypherTypeError,
  postgres,
  registerSqliteFunctions,
  sqlite,
  type Dialect,
  type SqlExecutor,
} from '../src/index.js';
import { betterSqliteExecutor } from '../examples/executors/better-sqlite3.js';
import { nodeSqliteExecutor } from '../examples/executors/node-sqlite.js';
import { pgExecutor } from '../examples/executors/pg.js';
import { TEST_POSTGRES_URL } from './support/postgres.js';

const schema = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../examples/schema', name), 'utf8');

/** node:sqlite prints an experimental warning on load; load it only when used. */
async function openNodeSqlite(): Promise<import('node:sqlite').DatabaseSync> {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(':memory:');
}

interface Opened {
  executor: SqlExecutor;
  close: () => Promise<void>;
}

interface Example {
  name: string;
  dialect: Dialect;
  open: () => Promise<Opened>;
}

const examples: Example[] = [
  {
    name: 'better-sqlite3',
    dialect: sqlite({ functions: true }),
    open: (): Promise<Opened> => {
      const db = new Database(':memory:');
      registerSqliteFunctions(db);
      db.exec(schema('sqlite.sql'));
      return Promise.resolve({
        executor: betterSqliteExecutor(db),
        close: () => Promise.resolve(void db.close()),
      });
    },
  },
  {
    name: 'node:sqlite',
    dialect: sqlite({ functions: true }),
    open: async (): Promise<Opened> => {
      const db = await openNodeSqlite();
      registerSqliteFunctions(db);
      db.exec(schema('sqlite.sql'));
      return { executor: nodeSqliteExecutor(db), close: () => Promise.resolve(db.close()) };
    },
  },
  {
    name: 'pg',
    dialect: postgres(),
    open: async (): Promise<Opened> => {
      const name = `example_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
      const admin = new pg.Client({ connectionString: TEST_POSTGRES_URL });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${name}`);
      await admin.query(`SET search_path TO ${name}`);
      await admin.query(schema('postgres.sql'));
      const pool = new pg.Pool({
        connectionString: TEST_POSTGRES_URL,
        options: `-c search_path=${name}`,
        max: 3,
      });
      return {
        executor: pgExecutor(pool, { statementTimeoutMs: 10_000 }),
        close: async (): Promise<void> => {
          await pool.end();
          await admin.query(`DROP SCHEMA ${name} CASCADE`);
          await admin.end();
        },
      };
    },
  },
];

for (const example of examples) {
  describe(`example executor: ${example.name}`, () => {
    const opened = example.open();
    afterAll(async () => (await opened).close());

    it('writes and reads a graph through the example schema', async () => {
      const { executor } = await opened;
      const write = createGraph({ dialect: example.dialect, executor, readOnly: false });
      const read = createGraph({ dialect: example.dialect, executor });
      await write.query(
        `CREATE (a:Person {name: 'Ada', born: 1815})-[:KNOWS {since: 1833}]->(c:Person {name: 'Charles'}),
                (c)-[:KNOWS]->(:Person {name: 'Mary', big: 9223372036854775807})`,
      );
      expect(
        await read.query(
          `MATCH p = shortestPath((a:Person {name: 'Ada'})-[:KNOWS*]->(m:Person {name: 'Mary'}))
           RETURN [n IN nodes(p) | n.name] AS names, m.big AS big, a.born + 1 AS next`,
        ),
      ).toEqual([{ names: ['Ada', 'Charles', 'Mary'], big: 9223372036854775807n, next: 1816n }]);
    });

    it('changes the case of letters beyond ASCII (SQLite: with registerSqliteFunctions)', async () => {
      const { executor } = await opened;
      const read = createGraph({ dialect: example.dialect, executor });
      expect(
        await read.query(
          "RETURN toUpper('ÄÖü é ω') AS u, toLower('ÄÖÜ É Ω') AS l, upper($s) AS p, toUpper(null) AS n",
          { s: 'ça' },
        ),
      ).toEqual([{ u: 'ÄÖÜ É Ω', l: 'äöü é ω', p: 'ÇA', n: null }]);
    });

    it('matches regular expressions (SQLite: with registerSqliteFunctions)', async () => {
      const { executor } = await opened;
      const read = createGraph({ dialect: example.dialect, executor });
      const [row] = await read.query(
        `RETURN 'abc' =~ 'a.*' AS whole, 'abc' =~ 'b' AS part, 'ab' =~ 'a|ab' AS alt,
                'ABC' =~ '(?i)abc' AS i, 'a\\nb' =~ 'a.b' AS dot, 'a\\nb' =~ '(?s)a.b' AS s,
                'a\\nb' =~ '(?m)a$.b' AS m, 'a1' =~ '\\\\w\\\\d' AS classes, 'ü😀' =~ '..' AS unicode,
                $x =~ 'a' AS notString, 'a' =~ $p AS param, null =~ 'a' AS nil`,
        { x: 1n, p: '[a-c]' },
      );
      expect(row).toEqual({
        whole: true,
        part: false,
        alt: true,
        i: true,
        dot: false,
        s: true,
        m: false,
        classes: true,
        unicode: true,
        notString: null,
        param: true,
        nil: null,
      });
      await expect(read.query("RETURN 'a' =~ '(' AS r")).rejects.toMatchObject({
        constructor: CypherArgumentError,
        code: 'InvalidRegex',
      });
    });

    it('runs concurrent queries one transaction at a time', async () => {
      const { executor } = await opened;
      const read = createGraph({ dialect: example.dialect, executor });
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          read.query('MATCH (p:Person) RETURN count(p) + $i AS c', { i: BigInt(i) }),
        ),
      );
      expect(results.map((r) => r[0]!['c'])).toEqual([3n, 4n, 5n, 6n, 7n]);
    });

    it('refuses writes in read transactions, and keeps working after an error', async () => {
      const { executor } = await opened;
      await expect(
        executor.transaction('read', (tx) =>
          tx.query("INSERT INTO nodes (labels, properties) VALUES ('[]', '{}')", []),
        ),
      ).rejects.toThrow();
      const read = createGraph({ dialect: example.dialect, executor });
      await expect(read.query('MATCH (p:Person) WHERE p.name RETURN p')).rejects.toThrow(
        CypherTypeError,
      );
      expect(await read.query('MATCH (p:Person) RETURN count(*) AS c')).toEqual([{ c: 3n }]);
    });
  });
}
