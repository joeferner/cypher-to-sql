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
  });
}
