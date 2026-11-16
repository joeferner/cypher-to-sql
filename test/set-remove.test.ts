import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  CypherNode,
  CypherTypeError,
  defaultMapping,
  ReadOnlyViolationError,
  SemanticError,
  type CypherValue,
  type Graph,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

for (const backend of testBackends()) {
  describe(`SET and REMOVE on ${backend.name}`, () => {
    let write: Graph;
    let read: Graph;
    let typed: Graph;

    beforeEach(async () => {
      const { dialect, executor } = await backend.open();
      write = createGraph({ dialect, executor, readOnly: false });
      read = createGraph({ dialect, executor });
      typed = createGraph({
        dialect,
        executor,
        readOnly: false,
        mapping: {
          ...defaultMapping,
          nodes: { ...defaultMapping.nodes, propertyTypes: { age: 'integer' } },
        },
      });
      await write.query("CREATE (:A {name: 'a', n: 1})-[:R {w: 1}]->(:B {name: 'b'})");
    });
    afterAll(() => backend.dispose?.());

    /** Properties of the nodes with label `label`, by name. */
    const nodes = async (label: string): Promise<CypherValue[]> =>
      (await read.query(`MATCH (n:${label}) RETURN n ORDER BY n.name`)).map(
        (r) => (r['n'] as CypherNode).properties,
      );

    it('sets and removes properties, with values computed from the stored entity', async () => {
      expect(
        await write.query(
          "MATCH (n:A) SET n.name = n.name + '!', n.m = n.n + 1 RETURN n.name AS name",
        ),
      ).toEqual([{ name: 'a!' }]);
      expect(await nodes('A')).toEqual([{ name: 'a!', n: 1n, m: 2n }]);
      await write.query('MATCH (n:A) SET n.n = null REMOVE n.m');
      expect(await nodes('A')).toEqual([{ name: 'a!' }]);
      // Items apply in order: the second sees the first.
      expect(await write.query('MATCH (n:A) SET n.x = 1, n.y = n.x RETURN n.y AS y')).toEqual([
        { y: 1n },
      ]);
    });

    it('sets relationship properties, and properties through an expression', async () => {
      expect(
        await write.query("MATCH ()-[r:R]->() SET (r).name = 'x' RETURN r.name AS n, r.w AS w"),
      ).toEqual([{ n: 'x', w: 1n }]);
    });

    it('replaces (=) and merges (+=) all properties, from maps and entities', async () => {
      await write.query('MATCH (n:B) SET n += {x: 1, name: null}');
      expect(await nodes('B')).toEqual([{ x: 1n }]);
      await write.query('MATCH (n:B) SET n = {y: 2, z: null}');
      expect(await nodes('B')).toEqual([{ y: 2n }]);
      await write.query('MATCH (n:B) SET n += $p', { p: { k: 'v' } });
      expect(await nodes('B')).toEqual([{ y: 2n, k: 'v' }]);
      await write.query('MATCH (a:A), (b:B) SET b = a');
      expect(await nodes('B')).toEqual([{ name: 'a', n: 1n }]);
      await write.query('MATCH ()-[r:R]->(b:B) SET b += r');
      expect(await nodes('B')).toEqual([{ name: 'a', n: 1n, w: 1n }]);
    });

    it('adds and removes labels', async () => {
      expect(
        await write.query('MATCH (n:B) SET n:C:D, n:C REMOVE n:B RETURN labels(n) AS l'),
      ).toEqual([{ l: ['C', 'D'] }]);
      await write.query('MATCH (n:D) REMOVE n:Missing, n:D');
      expect(await read.query('MATCH (n:C) RETURN labels(n) AS l')).toEqual([{ l: ['C'] }]);
    });

    it('works on created entities and on each row, seeing earlier rows', async () => {
      expect(
        await write.query('CREATE (a:L {l: [1, 2]}) SET a.l = a.l + [3] RETURN a.l AS l'),
      ).toEqual([{ l: [1n, 2n, 3n] }]);
      await write.query('UNWIND [1, 2, 3] AS i MATCH (n:A) SET n.c = coalesce(n.c, 0) + i');
      expect(await read.query('MATCH (n:A) RETURN n.c AS c')).toEqual([{ c: 6n }]);
      // A node from UNWIND shows the new values after SET.
      expect(
        await write.query(
          "MATCH (n:A) WITH collect(n) AS ns UNWIND ns AS n SET n.name = 'z' RETURN n.name AS name",
        ),
      ).toEqual([{ name: 'z' }]);
    });

    it('does nothing for a null target', async () => {
      expect(await write.query('OPTIONAL MATCH (n:Nope) SET n.x = 1, n:L RETURN n')).toEqual([
        { n: null },
      ]);
    });

    it('checks values as CREATE does', async () => {
      await expect(write.query('MATCH (n:A) SET n.m = {k: 1}')).rejects.toThrow(SemanticError);
      await expect(write.query('MATCH (n:A) SET n.m = [[1]]')).rejects.toThrow(SemanticError);
      await expect(typed.query("MATCH (n:A) SET n.age = 'old'")).rejects.toThrow(SemanticError);
      await typed.query('MATCH (n:A) SET n.age = 3');
      await expect(write.query('MATCH (n:A) SET n += 1')).rejects.toThrow(CypherTypeError);
      await expect(write.query('UNWIND [1] AS x SET x.a = 1')).rejects.toThrow(CypherTypeError);
      await expect(write.query('MATCH (n:A) SET n.name.x = 1')).rejects.toThrow(CypherTypeError);
      expect(() => write.compile('MATCH (n) SET n.x = missing')).toThrow(/not defined/);
    });

    it('is rejected on a read-only graph and makes a write plan', () => {
      expect(() => read.compile('MATCH (n) SET n.x = 1')).toThrow(ReadOnlyViolationError);
      expect(() => read.compile('MATCH (n) REMOVE n:A')).toThrow(/REMOVE is not allowed/);
      expect(write.compile('MATCH (n) SET n.x = 1').readOnly).toBe(false);
    });

    describe('SET folded into the CREATE or MERGE before it (#85)', () => {
      const dated = async (): Promise<Graph> => {
        const { dialect, executor } = await backend.open();
        return createGraph({
          dialect,
          executor,
          readOnly: false,
          mapping: {
            ...defaultMapping,
            nodes: {
              ...defaultMapping.nodes,
              propertyTypes: { age: 'integer', born: 'date' },
            },
          },
        });
      };
      const props = async (graph: Graph, label: string): Promise<CypherValue[]> =>
        (await graph.query(`MATCH (n:${label}) RETURN n ORDER BY n.k`)).map(
          (r) => (r['n'] as CypherNode).properties,
        );
      const rows = [
        { k: 1n, props: { a: 'x', gone: null, age: 30, born: '2024-03-01', list: [1n, 2n] } },
        { k: 2n, props: { a: 'y', age: 41n } },
        { k: 3n, props: {} },
      ];

      it('stores what the SET after it would, with one statement per row', async () => {
        const graph = await dated();
        // Folded: the SET items follow the CREATE that made their target.
        const folded =
          'UNWIND $rows AS row CREATE (n:F {k: row.k, keep: 1}) ' +
          'SET n += row.props, n.extra = row.k * 10, n.keep = null REMOVE n.a';
        const plan = graph.compile(folded).explain();
        expect(plan).toContain('then merge(');
        expect(plan).not.toMatch(/UPDATE/);
        await graph.query(folded, { rows });
        // Not folded: the same SET items in a later query.
        await graph.query('UNWIND $rows AS row CREATE (:U {k: row.k, keep: 1})', { rows });
        await graph.query(
          'UNWIND $rows AS row MATCH (n:U {k: row.k}) ' +
            'SET n += row.props, n.extra = row.k * 10, n.keep = null REMOVE n.a',
          { rows },
        );
        const expected = await props(graph, 'U');
        expect(await props(graph, 'F')).toEqual(expected);
        // Declared types: 30 became an integer, the date text a date.
        expect(expected[0]).toMatchObject({ age: 30n, extra: 10n });
        expect(expected[0]).not.toHaveProperty('gone');
        expect(expected[0]).not.toHaveProperty('keep');
      });

      it('applies SET n = map and later items in order, and checks values as SET does', async () => {
        const graph = await dated();
        await graph.query(
          "CREATE (n:F {k: 1, a: 'old'}) SET n.b = 'b', n = {k: 1, c: 'c'}, n.d = 'd'",
        );
        expect(await props(graph, 'F')).toEqual([{ k: 1n, c: 'c', d: 'd' }]);
        await expect(
          graph.query('UNWIND $rows AS row CREATE (n:F) SET n += row.p', { rows: [{ p: 1n }] }),
        ).rejects.toThrow(CypherTypeError);
        await expect(graph.query("CREATE (n:F) SET n.age = 'old'")).rejects.toThrow(
          /declared as integer/,
        );
        await expect(graph.query('CREATE (n:F) SET n += {`~id`: 1}')).rejects.toThrow(/reserved/);
        expect(await props(graph, 'F')).toHaveLength(1);
      });

      it('does not fold a SET whose value reads the graph as stored now', async () => {
        const graph = await dated();
        // The value uses the created node itself, or a node an earlier SET changed.
        const self = "CREATE (n:F {k: 1, a: 'x'}) SET n.b = n.a + '!'";
        expect(graph.compile(self).explain()).not.toContain('then ');
        await graph.query(self);
        await graph.query("CREATE (:S {k: 9, v: 'before'})");
        const changed = "MATCH (s:S) SET s.v = 'after' CREATE (n:F {k: 2}) SET n.v = s.v";
        expect(graph.compile(changed).explain()).not.toContain('then ');
        await graph.query(changed);
        expect(await props(graph, 'F')).toEqual([
          { k: 1n, a: 'x', b: 'x!' },
          { k: 2n, v: 'after' },
        ]);
      });

      it('runs a SET after MERGE as one UPDATE, without a SELECT first', async () => {
        const graph = await dated();
        const merge = 'UNWIND $rows AS row MERGE (n:M {k: row.k}) SET n += row.props';
        const plan = graph.compile(merge).explain();
        expect(plan).toContain('merge(row');
        await graph.query(merge, { rows });
        await graph.query(merge, { rows: rows.map((r) => ({ ...r, props: { a: 'z' } })) });
        const stored = await props(graph, 'M');
        expect(stored).toHaveLength(3);
        expect(stored[0]).toMatchObject({ k: 1n, a: 'z', age: 30n, list: [1n, 2n] });
        expect(stored[1]).toMatchObject({ k: 2n, a: 'z', age: 41n });
      });
    });
  });
}
