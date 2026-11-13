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

    describe('computed values and RETURN', () => {
      it('computes property values without reading clauses', async () => {
        const { write, read } = await setup();
        await write.query("CREATE (:N {a: 1 + 2, b: toUpper('x'), c: [i IN range(1, 3) | i * i]})");
        expect(await read.query('MATCH (n:N) RETURN n.a AS a, n.b AS b, n.c AS c')).toEqual([
          { a: 3n, b: 'X', c: [1n, 4n, 9n] },
        ]);
      });

      it('reads properties of entities created earlier in the query', async () => {
        const { write, read } = await setup();
        await write.query(
          `CREATE (a:A {v: 1, l: [1, 2]})-[r:R {w: a.v + 1}]->(b:B {v: a.v * 10, x: a.missing}),
                  (:C {p: b.v, l: size(a.l), w: r.w}), (:D $props), (:E {q: 1})`,
          { props: { k: 'p' } },
        );
        expect(
          await read.query(
            'MATCH (a:A)-[r]->(b:B), (c:C) RETURN r.w AS w, b.v AS v, b.x AS x, c.p AS p, c.l AS l, c.w AS cw',
          ),
        ).toEqual([{ w: 2n, v: 10n, x: null, p: 10n, l: 2n, cw: 2n }]);
        await write.query('CREATE (d:D2 $props), (:E2 {k: d.k})', { props: { k: 'p' } });
        expect(await read.query('MATCH (e:E2) RETURN e.k AS k')).toEqual([{ k: 'p' }]);
        expect(() => write.compile('CREATE (a), (b {v: a})')).toThrow(/only as `a.key`/);
        expect(() => write.compile('CREATE (a {v: a.w})')).toThrow(SemanticError);
      });

      it('returns created entities and values', async () => {
        const { write } = await setup();
        const [row] = await write.query(
          "CREATE (a:A {v: 1})-[r:R]->(b:B {v: 2}) RETURN a, r, b.v AS v, labels(a) AS labels, 'x' AS x",
        );
        expect(row!['a']).toMatchObject({ labels: ['A'], properties: { v: 1n } });
        expect(row!['r']).toMatchObject({ type: 'R' });
        expect(row).toMatchObject({ v: 2n, labels: ['A'], x: 'x' });
      });

      it('returns one row per source row, in order, with source variables', async () => {
        const { write, read } = await setup();
        await write.query("CREATE (:P {n: 'p'})");
        expect(
          await write.query(
            `MATCH (p:P) UNWIND [3, 1, 2] AS i CREATE (p)-[:HAS]->(c:C {i: i})
             RETURN p.n AS p, i, c.i AS c`,
          ),
        ).toEqual([
          { p: 'p', i: 3n, c: 3n },
          { p: 'p', i: 1n, c: 1n },
          { p: 'p', i: 2n, c: 2n },
        ]);
        expect(
          await write.query(
            'UNWIND [1, 2, 3] AS i CREATE (n:Q {i: i}) RETURN count(n) AS n, sum(n.i) AS s',
          ),
        ).toEqual([{ n: 3n, s: 6n }]);
        expect(
          await write.query(
            'UNWIND [2, 1] AS i CREATE (n:R2 {i: i}) RETURN n.i AS i ORDER BY i LIMIT 1',
          ),
        ).toEqual([{ i: 1n }]);
        expect(await write.query('MATCH (x:Missing) CREATE (:Y) RETURN 1 AS one')).toEqual([]);
        expect(await read.query('MATCH (c:C) RETURN count(*) AS c')).toEqual([{ c: 3n }]);
      });

      it('returns created entities with an id generator', async () => {
        let next = 100;
        const { write } = await setup({
          idStrategy: { kind: 'generator', generate: () => next++ },
        });
        const rows = await write.query(
          'UNWIND [1, 2] AS i CREATE (n {i: i}) RETURN id(n) AS id, n.i AS i',
        );
        expect(rows).toEqual([
          { id: 100n, i: 1n },
          { id: 101n, i: 2n },
        ]);
      });

      it('explains the RETURN step', async () => {
        const { write } = await setup();
        expect(write.compile('CREATE (a) RETURN a').explain()).toContain(
          '(after the writes, over the written rows: a)',
        );
        expect(() => write.compile('CREATE (a) WITH a CREATE (b) RETURN b')).toThrow(
          /not writes again/,
        );
      });

      it('runs WITH, UNWIND, and MATCH after CREATE before RETURN', async () => {
        const { write, count } = await setup();
        // Filtering and aggregating after CREATE change the result, not what was created.
        expect(
          await write.query(
            'UNWIND [1, 2, 3] AS i CREATE (n:N {i: i}) WITH n WHERE n.i > 1 RETURN collect(n.i) AS l',
          ),
        ).toEqual([{ l: [2n, 3n] }]);
        expect(await count('nodes')).toBe(3n);
        // MATCH after CREATE sees the new nodes.
        expect(
          await write.query(
            'CREATE (:M {k: 1}) WITH 1 AS one MATCH (m:M) UNWIND [m.k, 2] AS x RETURN x ORDER BY x',
          ),
        ).toEqual([{ x: 1n }, { x: 2n }]);
      });
    });
  });
}
