import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGraph, SemanticError, UnsupportedFeatureError, type Graph } from '../src/index.js';
import { testBackends } from './support/backends.js';

for (const backend of testBackends()) {
  describe(`pattern predicates, EXISTS, and pattern comprehensions on ${backend.name}`, () => {
    let graph: Graph;
    let writer: Graph;

    // a -R-> b -R-> c, a -S-> c, a -R-> d (d has k: 1), and e alone.
    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      graph = createGraph({ dialect, executor });
      writer = createGraph({ dialect, executor, readOnly: false });
      await writer.query(
        `CREATE (a:N {n: 'a', k: 1})-[:R {w: 1}]->(b:N {n: 'b'})-[:R {w: 2}]->(c:N {n: 'c'}),
                (a)-[:S]->(c), (a)-[:R {w: 3}]->(:N {n: 'd', k: 1}), (:N {n: 'e'})`,
      );
    });
    afterAll(() => backend.dispose?.());

    /** Names of the nodes matching `WHERE <cond>`, sorted. */
    const names = async (cond: string): Promise<unknown[]> =>
      (await graph.query(`MATCH (n:N) WHERE ${cond} RETURN n.n AS n ORDER BY n`)).map(
        (r) => r['n'],
      );

    it('uses patterns as conditions in WHERE', async () => {
      expect(await names('(n)-->()')).toEqual(['a', 'b']);
      expect(await names('(n)<-[:R]-()')).toEqual(['b', 'c', 'd']);
      expect(await names('(n)-[:S]-()')).toEqual(['a', 'c']);
      expect(await names('NOT (n)--()')).toEqual(['e']);
      expect(await names('(n)-[:R]->() AND (n)-[:S]->()')).toEqual(['a']);
      expect(await names('(n)-[:S]->() OR (n)<-[:R {w: 2}]-()')).toEqual(['a', 'c']);
      expect(await names('(n)-[:R*2]->()')).toEqual(['a']);
      expect(await names('(n)-->(:N {k: 1})')).toEqual(['a']);
      expect(
        await graph.query(
          `MATCH (x:N), (y:N) WHERE (x)-[:R]->(y) AND (y)-[:R]->() RETURN x.n AS x, y.n AS y`,
        ),
      ).toEqual([{ x: 'a', y: 'b' }]);
    });

    it('evaluates EXISTS with a pattern, its WHERE, and new variables', async () => {
      expect(await names('EXISTS { (n)-->(m) WHERE m.k = n.k }')).toEqual(['a']);
      expect(await names('EXISTS { (n)-[r]->() WHERE r.w > 1 }')).toEqual(['a', 'b']);
      expect(await names('NOT EXISTS { (n)-->() }')).toEqual(['c', 'd', 'e']);
      expect(
        await graph.query(
          `MATCH (n:N {n: 'a'}) RETURN EXISTS { (n)-[:S]->() } AS s, EXISTS { (n)<--() } AS incoming`,
        ),
      ).toEqual([{ s: true, incoming: false }]);
    });

    it('evaluates EXISTS with a query, also with WITH and aggregation', async () => {
      expect(await names('EXISTS { MATCH (n)-->(m) WHERE m.n = "c" RETURN m }')).toEqual([
        'a',
        'b',
      ]);
      expect(
        await names('EXISTS { MATCH (n)-->(m) WITH n, count(*) AS c WHERE c = 3 RETURN true }'),
      ).toEqual(['a']);
      expect(await names('EXISTS { MATCH (n)-->(m) WHERE EXISTS { (m)-->() } RETURN m }')).toEqual([
        'a',
      ]);
    });

    it('builds lists with pattern comprehensions', async () => {
      expect(
        await graph.query(
          `MATCH (n:N) RETURN n.n AS n, [(n)-[r:R]->(m) WHERE r.w > 1 | m.n] AS targets,
                  size([(n)--() | 1]) AS degree ORDER BY n`,
        ),
      ).toEqual([
        { n: 'a', targets: ['d'], degree: 3n },
        { n: 'b', targets: ['c'], degree: 2n },
        { n: 'c', targets: [], degree: 2n },
        { n: 'd', targets: [], degree: 1n },
        { n: 'e', targets: [], degree: 0n },
      ]);
      const [row] = await graph.query(
        `MATCH (n:N {n: 'a'}) RETURN [p = (n)-[:R*2]->() | length(p)] AS lengths`,
      );
      expect(row).toEqual({ lengths: [2n] });
      expect(
        await graph.query(
          `MATCH (n:N) WITH n, [(n)-->(m) | m.n] AS out WHERE size(out) > 1
           RETURN n.n AS n, count(*) AS c`,
        ),
      ).toEqual([{ n: 'a', c: 1n }]);
    });

    it('works inside list comprehensions and quantifiers', async () => {
      expect(
        await graph.query(
          `MATCH p = (:N {n: 'a'})-[:R*2]->() RETURN [x IN nodes(p) WHERE (x)-[:S]->() | x.n] AS s,
                  all(x IN nodes(p) WHERE EXISTS { (x)--(:N {n: 'b'}) } OR x.n = 'b') AS every`,
        ),
      ).toEqual([{ s: ['a'], every: true }]);
    });

    it('rejects misuse', async () => {
      await expect(graph.query('MATCH (n) WHERE (n)-->(m) RETURN n')).rejects.toThrow(
        SemanticError,
      );
      await expect(graph.query('MATCH (n) RETURN (n)-->()')).rejects.toThrow(SemanticError);
      await expect(graph.query('MATCH (n) WITH (n)-->() AS x RETURN x')).rejects.toThrow(
        SemanticError,
      );
      await expect(
        graph.query('MATCH (n) WHERE EXISTS { (n)-->(m) WHERE count(m) > 1 } RETURN n'),
      ).rejects.toThrow(SemanticError);
      await expect(
        writer.query('MATCH (n) WHERE EXISTS { MATCH (n) CREATE (:X) RETURN n } RETURN n'),
      ).rejects.toThrow(SemanticError);
      await expect(
        graph.query('MATCH (n), (m) WHERE EXISTS { (n)-[*]->(m) } RETURN n'),
      ).resolves.toBeDefined();
      await expect(
        graph.query('MATCH (n), (m) WHERE EXISTS { shortestPath((n)-[*]->(m)) } RETURN n'),
      ).rejects.toThrow(UnsupportedFeatureError);
    });
  });
}
