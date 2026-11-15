import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGraph, CypherRelationship, LimitExceededError, type Graph } from '../src/index.js';
import { testBackends } from './support/backends.js';

for (const backend of testBackends()) {
  describe(`variable-length patterns on ${backend.name}`, () => {
    let graph: Graph;

    // a -R-> b -R-> c -R-> d, and c -S-> a closes a cycle.
    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      graph = createGraph({ dialect, executor });
      await createGraph({ dialect, executor, readOnly: false }).query(
        `CREATE (a:N {n: 'a'})-[:R {w: 1}]->(b:N {n: 'b'})-[:R {w: 2}]->(c:N {n: 'c'})
                -[:R {w: 1}]->(:N {n: 'd'}), (c)-[:S]->(a)`,
      );
    });
    afterAll(() => backend.dispose?.());

    /** The `x` names reached from a by `pattern`, sorted. */
    const reached = async (pattern: string, from = 'a'): Promise<unknown[]> =>
      (await graph.query(`MATCH ({n: '${from}'})${pattern}(x) RETURN x.n AS x ORDER BY x`)).map(
        (row) => row['x'],
      );

    it('follows one or more relationships', async () => {
      expect(await reached('-[:R*]->')).toEqual(['b', 'c', 'd']);
      expect(await reached('-[:R*..]->')).toEqual(['b', 'c', 'd']);
      expect(await reached('-[:R*1..]->')).toEqual(['b', 'c', 'd']);
    });

    it('applies the bounds', async () => {
      expect(await reached('-[:R*0]->')).toEqual(['a']);
      expect(await reached('-[:R*0..1]->')).toEqual(['a', 'b']);
      expect(await reached('-[:R*2]->')).toEqual(['c']);
      expect(await reached('-[:R*2..]->')).toEqual(['c', 'd']);
      expect(await reached('-[:R*..2]->')).toEqual(['b', 'c']);
      expect(await reached('-[:R*2..1]->')).toEqual([]);
      expect(await reached('-[:R*..0]->')).toEqual([]);
    });

    it('follows the direction', async () => {
      expect(await reached('<-[:R*2]-', 'd')).toEqual(['b']);
      expect(await reached('-[:R*1]-', 'b')).toEqual(['a', 'c']);
      expect(await reached('-[:R*2]-', 'b')).toEqual(['d']);
    });

    it('never uses a relationship twice, so cycles end', async () => {
      // a -> b -> c -> a closes the cycle; it does not continue past a again.
      expect(await reached('-[*]->')).toEqual(['a', 'b', 'c', 'd']);
      expect(await reached('-[:R|S*]->')).toEqual(['a', 'b', 'c', 'd']);
    });

    it('requires every relationship to have the inline properties', async () => {
      expect(await reached('-[:R* {w: 1}]->')).toEqual(['b']);
      expect(await reached('-[:R* {w: 1}]->', 'c')).toEqual(['d']);
    });

    it('chains with fixed-length relationships, each relationship used once', async () => {
      expect(await reached('-[:R]->()-[:R*1..2]->')).toEqual(['c', 'd']);
      expect(await reached('-[:R*0]->()-[:R]->')).toEqual(['b']);
      expect(
        await graph.query(
          `MATCH (x)-[:R]->(y), (p)-[:R*1]->(q) WHERE x.n = 'a' RETURN q.n AS q ORDER BY q`,
        ),
      ).toEqual([{ q: 'c' }, { q: 'd' }]);
    });

    it('returns the relationships in path order', async () => {
      const rows = await graph.query(
        `MATCH ({n: 'a'})-[r:R*2]->(x) RETURN r, size(r) AS size, r IS NULL AS isNull`,
      );
      expect(rows).toHaveLength(1);
      const r = rows[0]!['r'] as CypherRelationship[];
      expect(r.every((rel) => rel instanceof CypherRelationship && rel.type === 'R')).toBe(true);
      expect(r.map((rel) => rel.properties['w'])).toEqual([1n, 2n]);
      expect(r[0]!.endNodeId).toBe(r[1]!.startNodeId);
      expect(rows[0]).toMatchObject({ size: 2n, isNull: false });
      expect(await graph.query(`MATCH ({n: 'a'})-[r:R*0]->(x) RETURN r, size(r) AS size`)).toEqual([
        { r: [], size: 0n },
      ]);
    });

    it('counts, carries through WITH, and is null after OPTIONAL MATCH without a match', async () => {
      expect(await graph.query(`MATCH ({n: 'a'})-[r:R*]->() RETURN count(r) AS c`)).toEqual([
        { c: 3n },
      ]);
      const carried = await graph.query(
        `MATCH ({n: 'a'})-[r:R*]->(x) WITH r, x WHERE size(r) > 2 RETURN r, x.n AS x`,
      );
      expect(carried).toHaveLength(1);
      expect(carried[0]!['x']).toBe('d');
      expect(carried[0]!['r']).toHaveLength(3);
      expect(
        await graph.query(
          `MATCH (d {n: 'd'}) OPTIONAL MATCH (d)-[r:R*]->(x) RETURN r, x, r IS NULL AS isNull`,
        ),
      ).toEqual([{ r: null, x: null, isNull: true }]);
    });

    it('applies maxPathDepth', async () => {
      const limits = { maxPathDepth: 2 };
      expect(
        (
          await graph.query(
            `MATCH ({n: 'a'})-[:R*]->(x) RETURN x.n AS x ORDER BY x`,
            {},
            { limits },
          )
        ).map((row) => row['x']),
      ).toEqual(['b', 'c']);
      await expect(
        graph.query(`MATCH ({n: 'a'})-[:R*..3]->(x) RETURN x`, {}, { limits }),
      ).rejects.toThrow(/exceeds maxPathDepth/);
      await expect(
        graph.query(`MATCH ({n: 'a'})-[:R*3..]->(x) RETURN x`, {}, { limits }),
      ).rejects.toThrow(/exceeds maxPathDepth/);
    });

    it('raises instead of cutting paths short when there are more than maxRowsPerStep', async () => {
      // No start filter: the search finds every R path of length 1..2 (5 of
      // them), although only 2 end at d.
      const query = `MATCH (x)-[:R*1..2]->({n: 'd'}) RETURN count(*) AS n`;
      expect(await graph.query(query, {}, { limits: { maxRowsPerStep: 5 } })).toEqual([{ n: 2n }]);
      await expect(graph.query(query, {}, { limits: { maxRowsPerStep: 4 } })).rejects.toThrow(
        LimitExceededError,
      );
      // A start filter keeps the search small.
      expect(
        await graph.query(
          `MATCH ({n: 'b'})-[:R*1..2]->(x) RETURN count(*) AS n`,
          {},
          { limits: { maxRowsPerStep: 4 } },
        ),
      ).toEqual([{ n: 2n }]);
    });

    it('matches the chain of a bound list of relationships', async () => {
      const ends = async (list: string, pattern: string, where = ''): Promise<unknown[]> =>
        (
          await graph.query(
            `MATCH (a {n: 'a'})-[r1:R]->(b)-[r2:R]->(c) WITH ${list} AS rs ` +
              `MATCH (x)${pattern}(y) ${where} RETURN x.n + y.n AS e`,
          )
        ).map((r) => r['e']);
      // a -r1-> b -r2-> c: in the arrow's direction only, and with fitting types and lengths.
      expect(await ends('[r1, r2]', '-[rs*]->')).toEqual(['ac']);
      expect(await ends('[r2, r1]', '<-[rs*]-')).toEqual(['ca']);
      expect(await ends('[r1, r2]', '<-[rs*]-')).toEqual([]);
      expect(await ends('[r1]', '-[rs*1..1]->')).toEqual(['ab']);
      expect(await ends('[r1, r2]', '-[rs:R*]->')).toEqual(['ac']);
      expect(await ends('[r1, r2]', '-[rs:S*]->')).toEqual([]);
      expect(await ends('[r1, r2]', '-[rs*..1]->')).toEqual([]);
      expect(await ends('[r1, r2]', '-[rs*3..]->')).toEqual([]);
      // Not a chain, not relationships, or empty.
      expect(await ends('[r2, r1]', '-[rs*]->')).toEqual([]);
      expect(await ends('[r1, 1]', '-[rs*]->')).toEqual([]);
      expect(await ends('[]', '-[rs*0..]->', "WHERE x.n = 'b'")).toEqual(['bb']);
      // Bound nodes that do not fit.
      expect(
        (
          await graph.query(
            "MATCH (a {n: 'a'})-[r1:R]->(b)-[r2:R]->(c) WITH [r1, r2] AS rs, c AS x, a AS y MATCH (x)-[rs*]->(y) RETURN x",
          )
        ).length,
      ).toBe(0);
    });

    it('rejects what it does not support yet', async () => {
      await expect(
        graph.query(`MATCH ()-[r*]->() WITH r MATCH ()-[r*]->() RETURN r`),
      ).rejects.toThrow(/not supported yet/);
      const bound = 'MATCH ()-[r1]->() WITH [r1] AS rs';
      for (const pattern of [
        'MATCH p = ()-[rs*]->() RETURN p',
        'MATCH ()-[rs*]-() RETURN 1',
        'MATCH ()-[rs* {w: 1}]->() RETURN 1',
      ]) {
        await expect(graph.query(`${bound} ${pattern}`), pattern).rejects.toThrow(
          /over a bound list of relationships is not supported yet/,
        );
      }
    });

    it('rejects variables of another type', async () => {
      await expect(graph.query(`MATCH (r)-[r*]->() RETURN r`)).rejects.toThrow(
        /not a list of relationships/,
      );
      await expect(graph.query(`MATCH ()-[r*]->()-[r]->() RETURN r`)).rejects.toThrow(
        /not a relationship/,
      );
      await expect(graph.query(`MATCH ()-[r*]->()-[r*]->() RETURN r`)).rejects.toThrow(
        /more than one relationship/,
      );
    });
  });
}
