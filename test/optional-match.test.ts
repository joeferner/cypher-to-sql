import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGraph, type Graph } from '../src/index.js';
import { testBackends } from './support/backends.js';

for (const backend of testBackends()) {
  describe(`OPTIONAL MATCH on ${backend.name}`, () => {
    let graph: Graph;

    // a -> b -> c, and d on its own.
    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      graph = createGraph({ dialect, executor });
      await createGraph({ dialect, executor, readOnly: false }).query(
        `CREATE (:P {n: 'a'})-[:R {w: 1}]->(:P {n: 'b'})-[:R {w: 2}]->(:P {n: 'c'}), (:P {n: 'd'})`,
      );
    });
    afterAll(() => backend.dispose?.());

    const rows = (cypher: string): Promise<unknown[]> => graph.query(cypher);

    it('keeps rows without a match, with the new variables null', async () => {
      expect(
        await rows('MATCH (p) OPTIONAL MATCH (p)-[:R]->(q) RETURN p.n AS p, q.n AS q ORDER BY p'),
      ).toEqual([
        { p: 'a', q: 'b' },
        { p: 'b', q: 'c' },
        { p: 'c', q: null },
        { p: 'd', q: null },
      ]);
    });

    it('applies its WHERE to the match, not to the row', async () => {
      expect(
        await rows(
          'MATCH (p) OPTIONAL MATCH (p)-[r:R]->(q) WHERE r.w > 1 RETURN p.n AS p, q.n AS q ORDER BY p',
        ),
      ).toEqual([
        { p: 'a', q: null },
        { p: 'b', q: 'c' },
        { p: 'c', q: null },
        { p: 'd', q: null },
      ]);
    });

    it('matches whole patterns or nothing', async () => {
      // Two hops exist only from a: other rows get nulls for both q and s.
      expect(
        await rows(
          'MATCH (p) OPTIONAL MATCH (p)-->(q)-->(s) RETURN p.n AS p, q.n AS q, s.n AS s ORDER BY p',
        ),
      ).toEqual([
        { p: 'a', q: 'b', s: 'c' },
        { p: 'b', q: null, s: null },
        { p: 'c', q: null, s: null },
        { p: 'd', q: null, s: null },
      ]);
    });

    it('gives one row of nulls when it comes first and nothing matches', async () => {
      expect(await rows('OPTIONAL MATCH (x:Missing) RETURN x')).toEqual([{ x: null }]);
      expect(await rows('OPTIONAL MATCH (x:P) RETURN count(x) AS c')).toEqual([{ c: 4n }]);
    });

    it('propagates null entities', async () => {
      const [row] = await graph.query(
        `MATCH (p {n: 'd'}) OPTIONAL MATCH (p)-[r]->(q)
         RETURN q, r, q.n AS n, labels(q) AS l, type(r) AS t, q IS NULL AS isNull, q:P AS isP`,
      );
      expect(row).toEqual({ q: null, r: null, n: null, l: null, t: null, isNull: true, isP: null });
      expect(
        await rows(
          'MATCH (p) OPTIONAL MATCH (p)-->(q) RETURN count(q) AS c, collect(q.n) AS names',
        ),
      ).toEqual([{ c: 2n, names: expect.arrayContaining(['b', 'c']) as unknown }]);
    });

    it('carries null entities through WITH, and a later MATCH from null finds nothing', async () => {
      expect(
        await rows("MATCH (p {n: 'd'}) OPTIONAL MATCH (p)-->(q) WITH p, q RETURN p.n AS p, q AS q"),
      ).toEqual([{ p: 'd', q: null }]);
      expect(
        await rows("MATCH (p {n: 'd'}) OPTIONAL MATCH (p)-->(q) MATCH (q)-->(s) RETURN s"),
      ).toEqual([]);
    });

    it('is a no-op when all its variables are already bound', async () => {
      expect(
        await rows("MATCH (p {n: 'a'}) OPTIONAL MATCH (p) WHERE p.n = 'z' RETURN p.n AS n"),
      ).toEqual([{ n: 'a' }]);
    });
  });
}
