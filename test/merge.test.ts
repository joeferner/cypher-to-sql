import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createGraph, ReadOnlyViolationError, SemanticError, type Graph } from '../src/index.js';
import { testBackends } from './support/backends.js';

for (const backend of testBackends()) {
  describe(`MERGE on ${backend.name}`, () => {
    let write: Graph;
    let read: Graph;

    beforeEach(async () => {
      const { dialect, executor } = await backend.open();
      write = createGraph({ dialect, executor, readOnly: false });
      read = createGraph({ dialect, executor });
    });
    afterAll(() => backend.dispose?.());

    const count = async (pattern: string): Promise<unknown> =>
      (await read.query(`MATCH ${pattern} RETURN count(*) AS c`))[0]!['c'];

    it('creates a node when none matches, and matches it otherwise', async () => {
      expect(await write.query('MERGE (n:N {k: 1}) RETURN n.k AS k')).toEqual([{ k: 1n }]);
      expect(await write.query('MERGE (n:N {k: 1}) RETURN n.k AS k')).toEqual([{ k: 1n }]);
      expect(await count('(n:N)')).toBe(1n);
    });

    it('sees what earlier rows created, and fans out over several matches', async () => {
      await write.query('UNWIND [1, 1, 2] AS x MERGE (:N {k: x})');
      expect(await count('(n:N)')).toBe(2n);
      await write.query('CREATE (:N {k: 1})');
      expect((await write.query('MERGE (n:N {k: 1}) RETURN n.k AS k')).map((r) => r['k'])).toEqual([
        1n,
        1n,
      ]);
    });

    it('runs ON CREATE and ON MATCH', async () => {
      const merge =
        'MERGE (n:N {k: 1}) ON CREATE SET n.created = true ON MATCH SET n.seen = coalesce(n.seen, 0) + 1 RETURN n';
      await write.query(merge);
      await write.query(merge);
      await write.query(merge);
      expect(await read.query('MATCH (n:N) RETURN n.created AS c, n.seen AS s')).toEqual([
        { c: true, s: 2n },
      ]);
    });

    it('merges relationships between bound nodes, in either direction when unspecified', async () => {
      await write.query("CREATE (:A {n: 'a'}), (:B {n: 'b'})");
      const merge = 'MATCH (a:A), (b:B) MERGE (a)-[r:R {w: 1}]->(b) RETURN r.w AS w';
      expect(await write.query(merge)).toEqual([{ w: 1n }]);
      expect(await write.query(merge)).toEqual([{ w: 1n }]);
      expect(await count('()-[:R]->()')).toBe(1n);
      // Undirected: matches the existing relationship from b's side, creates left to right.
      await write.query('MATCH (a:A), (b:B) MERGE (b)-[:R {w: 1}]-(a)');
      expect(await count('()-[:R]->()')).toBe(1n);
      await write.query('MATCH (a:A), (b:B) MERGE (b)-[:S]-(a)');
      expect(await count('(:B)-[:S]->(:A)')).toBe(1n);
    });

    it('runs clause by clause, so it does not match what an earlier DELETE removed', async () => {
      await write.query('CREATE (:A {num: 1}), (:A {num: 2})');
      expect(await write.query('MATCH (a:A) DELETE a MERGE (a2:A) RETURN a2.num AS num')).toEqual([
        { num: null },
        { num: null },
      ]);
      expect(await count('(a:A)')).toBe(1n);
    });

    it('binds a named path to what it matched or created', async () => {
      const merge =
        'MERGE (a:A {k: 1}) MERGE (b:B {k: 2}) MERGE p = (a)-[:R]->(b) RETURN length(p) AS n, ' +
        '[x IN nodes(p) | x.k] AS ks, type(relationships(p)[0]) AS t';
      const created = await write.query(merge);
      expect(created).toEqual([{ n: 1n, ks: [1n, 2n], t: 'R' }]);
      // Again: it matches the same path, and creates nothing.
      expect(await write.query(merge)).toEqual(created);
      expect(await count('()-[:R]->()')).toBe(1n);
      // A single node, an unnamed element, and an undirected pattern (created left to right).
      expect(await write.query('MERGE p = (:C {k: 3}) RETURN length(p) AS n')).toEqual([{ n: 0n }]);
      expect(
        await write.query(
          'MATCH (a:A), (b:B) MERGE p = (b)-[:S]-(a) RETURN [x IN nodes(p) | x.k] AS ks',
        ),
      ).toEqual([{ ks: [2n, 1n] }]);
      expect(await count('(:B)-[:S]->(:A)')).toBe(1n);
    });

    it('leaves the planner variables of a merged path out of RETURN *', async () => {
      const rows = await write.query('MERGE p = (:A)-[:R]->(b:B) RETURN *');
      expect(Object.keys(rows[0]!).sort()).toEqual(['b', 'p']);
    });

    it('binds one path per match', async () => {
      await write.query('CREATE (:N {k: 1}), (:N {k: 1})');
      expect(
        (await write.query('MERGE p = (n:N {k: 1}) RETURN length(p) AS n')).map((r) => r['n']),
      ).toEqual([0n, 0n]);
    });

    it('rejects what Cypher rejects', async () => {
      expect(() => write.compile('MATCH (a) MERGE (a)')).toThrow(SemanticError);
      expect(() => write.compile('MERGE (a)-->(b)')).toThrow(/exactly one type/);
      expect(() => write.compile('MERGE (a)-[:R*2]->(b)')).toThrow(SemanticError);
      expect(() => write.compile('MERGE (n $p)')).toThrow(SemanticError);
      await expect(write.query('MERGE ({num: null})')).rejects.toThrow(SemanticError);
      expect(() => read.compile('MERGE (n)')).toThrow(ReadOnlyViolationError);
      expect(write.compile('MERGE (n)').readOnly).toBe(false);
    });
  });
}
