import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  CypherPath,
  CypherRelationship,
  CypherSyntaxError,
  LimitExceededError,
  SemanticError,
  UnsupportedFeatureError,
  type CypherValue,
  type Graph,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

for (const backend of testBackends()) {
  describe(`shortestPath and allShortestPaths on ${backend.name}`, () => {
    let graph: Graph;
    let writer: Graph;

    // a -R-> b -R-> d, a -R-> c -R-> d, d -R-> e -R-> g, a -S-> e, and f alone.
    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      graph = createGraph({ dialect, executor });
      writer = createGraph({ dialect, executor, readOnly: false });
      await writer.query(
        `CREATE (a:N {n: 'a'})-[:R]->(b:N {n: 'b'})-[:R]->(d:N {n: 'd'}),
                (a)-[:R]->(:N {n: 'c'})-[:R]->(d),
                (d)-[:R]->(e:N {n: 'e'})-[:R]->(:N {n: 'g'}),
                (a)-[:S]->(e), (:N {n: 'f'})`,
      );
    });
    afterAll(() => backend.dispose?.());

    /** Node names along each path. */
    const names = (value: CypherValue): string[] =>
      (value as CypherPath).nodes.map((n) => n.properties['n'] as string);

    /** The paths from x to y matched by `pattern` (with `p` as its path variable), as node names. */
    const paths = async (from: string, to: string, pattern: string): Promise<string[][]> =>
      (
        await graph.query(
          `MATCH (x:N {n: '${from}'}), (y:N {n: '${to}'}) MATCH p = ${pattern} RETURN p`,
        )
      ).map((row) => names(row['p']!));

    it('finds one shortest path', async () => {
      // Of the two shortest paths, the one through the first relationship found.
      expect(await paths('a', 'd', 'shortestPath((x)-[:R*]->(y))')).toEqual([['a', 'b', 'd']]);
      expect(await paths('a', 'g', 'shortestPath((x)-[*]->(y))')).toEqual([['a', 'e', 'g']]);
      expect(await paths('a', 'g', 'SHORTESTPATH((x)-[:R*]->(y))')).toEqual([
        ['a', 'b', 'd', 'e', 'g'],
      ]);
    });

    it('finds all shortest paths', async () => {
      expect(await paths('a', 'd', 'allShortestPaths((x)-[:R*]->(y))')).toEqual([
        ['a', 'b', 'd'],
        ['a', 'c', 'd'],
      ]);
      expect(await paths('a', 'e', 'allShortestPaths((x)-[*]->(y))')).toEqual([['a', 'e']]);
    });

    it('follows the direction', async () => {
      expect(await paths('e', 'a', 'shortestPath((x)-[*]->(y))')).toEqual([]);
      expect(await paths('e', 'a', 'shortestPath((x)<-[*]-(y))')).toEqual([['e', 'a']]);
      expect(await paths('g', 'b', 'shortestPath((x)-[:R*]-(y))')).toEqual([['g', 'e', 'd', 'b']]);
      expect(await paths('b', 'c', 'allShortestPaths((x)-[*]-(y))')).toEqual([
        ['b', 'a', 'c'],
        ['b', 'd', 'c'],
      ]);
    });

    it('applies the bounds', async () => {
      expect(await paths('a', 'g', 'shortestPath((x)-[:R*..3]->(y))')).toEqual([]);
      expect(await paths('a', 'g', 'shortestPath((x)-[:R*..4]->(y))')).toHaveLength(1);
      expect(await paths('a', 'a', 'shortestPath((x)-[*0..]->(y))')).toEqual([['a']]);
      // With a lower bound of 1, a node has no shortest path to itself.
      expect(await paths('a', 'a', 'shortestPath((x)-[*]-(y))')).toEqual([]);
    });

    it('gives no row, or null with OPTIONAL MATCH, when there is no path', async () => {
      expect(await paths('a', 'f', 'shortestPath((x)-[*]-(y))')).toEqual([]);
      expect(
        await graph.query(
          `MATCH (x:N {n: 'a'}), (y:N {n: 'f'})
           OPTIONAL MATCH p = shortestPath((x)-[*]-(y)) RETURN p, length(p) AS length`,
        ),
      ).toEqual([{ p: null, length: null }]);
    });

    it('searches every pair of nodes the rows give', async () => {
      expect(
        await graph.query(
          `MATCH (x:N {n: 'a'}), (y:N) WHERE y.n <> 'a'
           MATCH p = shortestPath((x)-[:R*]->(y))
           RETURN y.n AS y, length(p) AS length ORDER BY y`,
        ),
      ).toEqual([
        { y: 'b', length: 1n },
        { y: 'c', length: 1n },
        { y: 'd', length: 2n },
        { y: 'e', length: 3n },
        { y: 'g', length: 4n },
      ]);
      // Unbound end nodes are matched first, with their labels and properties.
      expect(
        await graph.query(
          `MATCH p = shortestPath((x:N {n: 'g'})<-[:R*]-(y:N)) WITH y, length(p) AS length
           RETURN y.n AS y, length ORDER BY length, y`,
        ),
      ).toEqual([
        { y: 'e', length: 1n },
        { y: 'd', length: 2n },
        { y: 'b', length: 3n },
        { y: 'c', length: 3n },
        { y: 'a', length: 4n },
      ]);
    });

    it('binds the relationship list and works with path functions and aggregates', async () => {
      const rows = await graph.query(
        `MATCH (x:N {n: 'a'}), (y:N {n: 'g'})
         MATCH p = shortestPath((x)-[r*]->(y))
         RETURN r, size(r) AS size, last(nodes(p)).n AS last, length(p) AS length,
                head(relationships(p)) = head(r) AS same`,
      );
      expect(rows).toHaveLength(1);
      const r = rows[0]!['r'] as CypherRelationship[];
      expect(r.map((rel) => rel.type)).toEqual(['S', 'R']);
      expect(r.every((rel) => rel instanceof CypherRelationship)).toBe(true);
      expect(rows[0]).toMatchObject({ size: 2n, last: 'g', length: 2n, same: true });
      expect(
        await graph.query(
          `MATCH (x:N {n: 'a'}), (y:N) MATCH p = allShortestPaths((x)-[:R*]->(y))
           RETURN y.n AS y, count(p) AS paths ORDER BY y`,
        ),
      ).toEqual([
        { y: 'b', paths: 1n },
        { y: 'c', paths: 1n },
        { y: 'd', paths: 2n },
        { y: 'e', paths: 2n },
        { y: 'g', paths: 2n },
      ]);
    });

    it('works without a path variable, and with an earlier search', async () => {
      expect(
        await graph.query(
          `MATCH (x:N {n: 'a'}), (y:N {n: 'g'}) MATCH shortestPath((x)-[r:R*]->(y))
           RETURN size(r) AS size`,
        ),
      ).toEqual([{ size: 4n }]);
      expect(
        await graph.query(
          `MATCH (x:N {n: 'a'}), (y:N {n: 'd'}), (z:N {n: 'g'})
           MATCH p = shortestPath((x)-[:R*]->(y)), q = shortestPath((y)-[:R*]->(z))
           RETURN length(p) AS p, length(q) AS q`,
        ),
      ).toEqual([{ p: 2n, q: 2n }]);
    });

    it('runs before CREATE', async () => {
      await writer.query(
        `MATCH (x:N {n: 'a'}), (y:N {n: 'g'}) MATCH p = shortestPath((x)-[*]->(y))
         CREATE (:Length {l: length(p)})`,
      );
      expect(await graph.query('MATCH (n:Length) RETURN n.l AS l')).toEqual([{ l: 2n }]);
    });

    it('stops at the depth where it reaches the target', async () => {
      // One step for the node pairs, one per depth, and the final statement.
      const query = `MATCH (x:N {n: 'a'}), (y:N {n: 'b'}) MATCH p = shortestPath((x)-[*]->(y)) RETURN length(p) AS l`;
      expect(await graph.query(query, {}, { limits: { maxSteps: 3 } })).toEqual([{ l: 1n }]);
      await expect(
        graph.query(query.replace("'b'", "'d'"), {}, { limits: { maxSteps: 3 } }),
      ).rejects.toThrow(LimitExceededError);
    });

    it('applies maxFrontierSize and maxPathDepth', async () => {
      const query = `MATCH (x:N {n: 'a'}), (y:N {n: 'g'}) MATCH p = shortestPath((x)-[:R*]->(y)) RETURN p`;
      await expect(graph.query(query, {}, { limits: { maxFrontierSize: 1 } })).rejects.toThrow(
        /maxFrontierSize/,
      );
      await expect(graph.query(query, {}, { limits: { maxPathDepth: 3 } })).resolves.toEqual([]);
      await expect(
        graph.query(query.replace('[:R*]', '[:R*..5]'), {}, { limits: { maxPathDepth: 3 } }),
      ).rejects.toThrow(LimitExceededError);
    });

    it('explains the search steps', () => {
      const explained = graph
        .compile(`MATCH (x:N {n: 'a'}), (y:N) MATCH p = allShortestPaths((x)-[:R*]-(y)) RETURN p`)
        .explain();
      expect(explained).toContain('-- step 1 (node pairs of shortest path search 1)');
      expect(explained).toContain('all shortest paths per pair, depth 1..maxPathDepth');
      expect(explained).toContain('-- step 2');
      expect(explained).toContain('shortestPaths(search 1)');
    });

    it('rejects what it does not support', async () => {
      const fails = (query: string): Promise<unknown> => graph.query(query);
      await expect(fails('MATCH p = shortestPath((a)-[*]->(b)-[*]->(c)) RETURN p')).rejects.toThrow(
        SemanticError,
      );
      await expect(fails('MATCH p = shortestPath((a)) RETURN p')).rejects.toThrow(SemanticError);
      await expect(fails('MATCH p = shortestPath((a)-[*2..]->(b)) RETURN p')).rejects.toThrow(
        SemanticError,
      );
      await expect(fails('MATCH p = shortestPath((a)-[r]->(b)) RETURN p')).rejects.toThrow(
        UnsupportedFeatureError,
      );
      await expect(
        fails('MATCH p = shortestPath((a)-[*]->(b)) WHERE length(p) > 1 RETURN p'),
      ).rejects.toThrow(UnsupportedFeatureError);
      await expect(fails('MATCH p = longestPath((a)-[*]->(b)) RETURN p')).rejects.toThrow(
        CypherSyntaxError,
      );
      await expect(writer.query('CREATE p = shortestPath((a)-[:R]->(b))')).rejects.toThrow(
        SemanticError,
      );
    });
  });
}
