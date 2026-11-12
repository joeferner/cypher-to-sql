import { afterAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  LimitExceededError,
  ReadOnlyViolationError,
  SemanticError,
  type CypherValue,
  type Graph,
  type IdStrategy,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

interface Fixture {
  write: Graph;
  read: Graph;
  /** Runs SQL directly, for checking table contents. */
  sql: (query: string) => Promise<Record<string, unknown>[]>;
  count: (table: 'nodes' | 'edges') => Promise<bigint>;
}

const column = (records: Record<string, CypherValue>[], name: string): CypherValue[] =>
  records.map((r) => r[name] ?? null);

for (const backend of testBackends()) {
  const setup = async (options: { idStrategy?: IdStrategy } = {}): Promise<Fixture> => {
    const { dialect, executor } = await backend.open();
    const sql = (query: string): Promise<Record<string, unknown>[]> =>
      executor.transaction('read', (tx) => tx.query(query, []));
    return {
      write: createGraph({ dialect, executor, readOnly: false, ...options }),
      read: createGraph({ dialect, executor }),
      sql,
      count: async (table) =>
        BigInt(String((await sql(`SELECT count(*) AS c FROM ${table}`))[0]!['c'])),
    };
  };
  afterAll(() => backend.dispose?.());

  describe(backend.name, () => {
    describe('UNWIND', () => {
      it('keeps element types and list order', async () => {
        const { read } = await setup();
        const records = await read.query(
          "UNWIND [3, 1.0, 'a', true, null, [1, 2.5], {k: 1}] AS x RETURN x",
        );
        expect(column(records, 'x')).toEqual([3n, 1.0, 'a', true, null, [1n, 2.5], { k: 1n }]);
        expect(typeof records[1]!['x']).toBe('number');
      });

      it('gives no rows for null and the empty list, and one row for a scalar', async () => {
        const { read } = await setup();
        expect(await read.query('UNWIND null AS x RETURN x')).toEqual([]);
        expect(await read.query('UNWIND [] AS x RETURN x')).toEqual([]);
        expect(await read.query('UNWIND 5 AS x RETURN x')).toEqual([{ x: 5n }]);
      });

      it('unwinds parameters and nested lists, in nested-loop order', async () => {
        const { read } = await setup();
        const records = await read.query('UNWIND $lists AS l UNWIND l AS x RETURN x', {
          lists: [[3n, 2n], [], [1n]],
        });
        expect(column(records, 'x')).toEqual([3n, 2n, 1n]);
      });

      it('reads properties of unwound maps', async () => {
        const { read } = await setup();
        const records = await read.query('UNWIND [{a: {b: 1}}, {a: null}] AS m RETURN m.a.b AS b');
        expect(column(records, 'b')).toEqual([1n, null]);
      });

      it('rejects a variable that is already bound', async () => {
        const { read } = await setup();
        expect(() => read.compile('UNWIND [1] AS x UNWIND [2] AS x RETURN x')).toThrow(
          SemanticError,
        );
      });
    });

    describe('MATCH / UNWIND with CREATE', () => {
      it('creates once per incoming row, with values from the row', async () => {
        const { write, read } = await setup();
        await write.query('UNWIND [1, 2, 3] AS i CREATE (:N {num: i})');
        await write.query('MATCH (a:N), (b:N) CREATE (a)-[:T {from: a.num}]->(b)');
        const nums = await read.query('MATCH (n:N) RETURN n.num AS num');
        expect(column(nums, 'num').sort()).toEqual([1n, 2n, 3n]);
        const plan = write.compile('MATCH (a:N), (b:N) CREATE (a)-[:T]->(b)');
        expect(plan.steps.map((s) => s.perRow ?? false)).toEqual([false, true]);
      });

      it('runs the source step before any insert, so new nodes are not matched', async () => {
        const { write, count } = await setup();
        await write.query('CREATE (:N), (:N)');
        await write.query('MATCH (n:N) CREATE (:N)');
        expect(await count('nodes')).toBe(4n);
      });

      it('creates nothing when there are no rows', async () => {
        const { write, count } = await setup();
        await write.query('MATCH (n:Missing) CREATE (n)-[:R]->(:New)');
        await write.query('UNWIND [] AS x CREATE ()');
        expect(await count('nodes')).toBe(0n);
      });

      it('uses fresh entity ids for every row with an id generator', async () => {
        let next = 100;
        const { write, sql } = await setup({
          idStrategy: { kind: 'generator', generate: () => next++ },
        });
        await write.query("UNWIND ['a', 'b'] AS c CREATE (:A {c: c})-[:R]->(:B)");
        const edges = await sql('SELECT start_id, end_id FROM edges ORDER BY id');
        expect(edges.map((e) => [String(e['start_id']), String(e['end_id'])])).toEqual([
          ['100', '101'],
          ['103', '104'],
        ]);
      });

      it('applies maxCreatedEntities to all rows before inserting', async () => {
        const { write, count } = await setup();
        await expect(
          write.query(
            'UNWIND [1, 2, 3] AS i CREATE ()-[:R]->()',
            {},
            { limits: { maxCreatedEntities: 8 } },
          ),
        ).rejects.toThrow(LimitExceededError);
        expect(await count('nodes')).toBe(0n);
      });

      it('rejects map property values from rows at run time', async () => {
        const { write, count } = await setup();
        await expect(write.query('UNWIND [{a: 1}] AS m CREATE ({p: m})')).rejects.toThrow(
          SemanticError,
        );
        expect(await count('nodes')).toBe(0n);
      });

      it('rejects invalid uses of bound variables', async () => {
        const { write } = await setup();
        expect(() => write.compile('MATCH (a) CREATE (a)')).toThrow(SemanticError);
        expect(() => write.compile('UNWIND [1] AS x CREATE (x)-[:R]->()')).toThrow(SemanticError);
        expect(() => write.compile('MATCH (a) CREATE (a:Label)-[:R]->()')).toThrow(SemanticError);
        expect(() => write.compile('MATCH (a) CREATE ({v: b.v})')).toThrow(SemanticError);
      });

      it('is rejected on a read-only graph', async () => {
        const { read } = await setup();
        expect(() => read.compile('UNWIND [1] AS i CREATE ()')).toThrow(ReadOnlyViolationError);
      });
    });
  });
}
