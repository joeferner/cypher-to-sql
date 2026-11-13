import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGraph, SemanticError, type CypherValue, type Graph } from '../src/index.js';
import { testBackends } from './support/backends.js';

for (const backend of testBackends()) {
  describe(`WITH on ${backend.name}`, () => {
    let graph: Graph;
    let writer: Graph;

    // a -> b -> c, and d on its own.
    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      graph = createGraph({ dialect, executor });
      writer = createGraph({ dialect, executor, readOnly: false });
      await writer.query(
        `CREATE (:P {n: 'a', v: 1})-[:R]->(:P {n: 'b', v: 2})-[:R]->(:P {n: 'c', v: 3}), (:P {n: 'd', v: 4})`,
      );
    });
    afterAll(() => backend.dispose?.());

    const rows = (cypher: string, params: Record<string, CypherValue> = {}): Promise<unknown[]> =>
      graph.query(cypher, params);

    it('projects values and filters them with WHERE', async () => {
      expect(
        await rows(
          'MATCH (p) WITH p.n AS name, p.v * 10 AS v WHERE v > 15 RETURN name, v ORDER BY name',
        ),
      ).toEqual([
        { name: 'b', v: 20n },
        { name: 'c', v: 30n },
        { name: 'd', v: 40n },
      ]);
    });

    it('carries nodes into later MATCH clauses', async () => {
      expect(
        await rows(
          "MATCH (p {n: 'a'}) WITH p MATCH (p)-[:R]->(q)-[:R]->(r) RETURN q.n AS q, r.n AS r",
        ),
      ).toEqual([{ q: 'b', r: 'c' }]);
      expect(
        await rows(
          'MATCH (p)-[r:R]->() WITH r, p MATCH (p)-[r]->(q) RETURN type(r) AS t, q.n AS q ORDER BY q',
        ),
      ).toEqual([
        { t: 'R', q: 'b' },
        { t: 'R', q: 'c' },
      ]);
    });

    it('aggregates, then filters on the aggregate', async () => {
      expect(
        await rows(
          'MATCH (p)-[:R]->(q) WITH p, count(q) AS out WHERE out >= 1 RETURN p.n AS n, out ORDER BY n',
        ),
      ).toEqual([
        { n: 'a', out: 1n },
        { n: 'b', out: 1n },
      ]);
      expect(await rows('MATCH (p) WITH count(*) AS c, sum(p.v) AS s RETURN c, s')).toEqual([
        { c: 4n, s: 10n },
      ]);
    });

    it('applies ORDER BY, SKIP, and LIMIT inside the stage, and keeps that order', async () => {
      expect(
        await rows('MATCH (p) WITH p ORDER BY p.v DESC SKIP 1 LIMIT 2 RETURN p.n AS n'),
      ).toEqual([{ n: 'c' }, { n: 'b' }]);
      expect(await rows('MATCH (p) WITH p.n AS n ORDER BY n DESC RETURN collect(n) AS ns')).toEqual(
        [{ ns: ['d', 'c', 'b', 'a'] }],
      );
      expect(await rows('UNWIND [3, 1, 2] AS x WITH x RETURN x')).toEqual([
        { x: 3n },
        { x: 1n },
        { x: 2n },
      ]);
      expect(await rows('MATCH (p) WITH p LIMIT $l RETURN count(*) AS c', { l: 3n })).toEqual([
        { c: 3n },
      ]);
    });

    it('is not cut short by the row limit before the last step', async () => {
      const result = await graph.query(
        'UNWIND range(1, 50) AS x WITH x WHERE x > 45 RETURN count(*) AS c',
        {},
        { limits: { maxRowsPerStep: 10 } },
      );
      expect(result).toEqual([{ c: 5n }]);
    });

    it('supports DISTINCT, WITH *, and chained stages', async () => {
      expect(
        await rows(
          'MATCH (p)-[:R]->() WITH DISTINCT p.v % 2 AS parity RETURN parity ORDER BY parity',
        ),
      ).toEqual([{ parity: 0n }, { parity: 1n }]);
      expect(await rows("MATCH (p {n: 'd'}) WITH * RETURN p.v AS v")).toEqual([{ v: 4n }]);
      expect(await rows('WITH 1 AS a WITH a, a + 1 AS b WITH a + b AS c RETURN c')).toEqual([
        { c: 3n },
      ]);
    });

    it("lets WITH's WHERE use variables from before it", async () => {
      expect(await rows('MATCH (p) WITH p.n AS n WHERE p.v > 2 RETURN n ORDER BY n')).toEqual([
        { n: 'c' },
        { n: 'd' },
      ]);
    });

    it('hides variables that WITH does not project', () => {
      expect(() => graph.compile('MATCH (p), (q) WITH p RETURN q')).toThrow(SemanticError);
      expect(() => graph.compile('MATCH (p) WITH p.n RETURN 1')).toThrow(/AS/);
      expect(() =>
        graph.compile('MATCH (p) WITH p.v AS v, count(*) AS c ORDER BY sum(p.v) RETURN v'),
      ).toThrow(SemanticError);
    });

    it('feeds CREATE', async () => {
      await writer.query(
        "MATCH (p {n: 'd'}) WITH p, p.v + 1 AS next CREATE (p)-[:N]->(:Q {v: next})",
      );
      expect(await rows('MATCH (:P)-[:N]->(q:Q) RETURN q.v AS v')).toEqual([{ v: 5n }]);
    });
  });
}
