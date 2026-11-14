import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  defaultMapping,
  SemanticError,
  type CypherValue,
  type Graph,
  type GraphMapping,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

const mapping: GraphMapping = {
  ...defaultMapping,
  nodes: { ...defaultMapping.nodes, propertyTypes: { age: 'integer' } },
};

for (const backend of testBackends()) {
  describe(`aggregates on ${backend.name}`, () => {
    let graph: Graph;

    // Two teams; v holds mixed types.
    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      graph = createGraph({ dialect, executor, mapping });
      await createGraph({ dialect, executor, mapping, readOnly: false }).query(
        `CREATE (:P {team: 'a', age: 30, v: 1, s: 1.5}), (:P {team: 'a', age: 40, v: 'x', s: 2}),
                (:P {team: 'b', age: 20, v: 2.5}), (:P {team: 'b', v: true}), (:Q)`,
      );
    });
    afterAll(() => backend.dispose?.());

    const rows = (cypher: string, params: Record<string, CypherValue> = {}): Promise<unknown[]> =>
      graph.query(cypher, params);
    const one = async (cypher: string): Promise<CypherValue> =>
      Object.values((await graph.query(cypher))[0]!)[0] ?? null;

    it('counts rows and non-null values', async () => {
      expect(await one('MATCH (n) RETURN count(*)')).toBe(5n);
      expect(await one('MATCH (n:P) RETURN count(n.age)')).toBe(3n);
      expect(await one('MATCH (n:P) RETURN count(DISTINCT n.team)')).toBe(2n);
      expect(await one('MATCH (n) RETURN count(n)')).toBe(5n);
      expect(await one('MATCH (n:Missing) RETURN count(*)')).toBe(0n);
    });

    it('groups by the other items', async () => {
      expect(
        await rows(
          'MATCH (n:P) RETURN n.team AS team, count(*) AS c, sum(n.age) AS s ORDER BY team',
        ),
      ).toEqual([
        { team: 'a', c: 2n, s: 70n },
        { team: 'b', c: 2n, s: 20n },
      ]);
      expect(
        await rows('MATCH (n:P) WHERE n.age > 25 RETURN n, count(*) AS c ORDER BY n.age'),
      ).toHaveLength(2);
    });

    it('keeps Cypher number types', async () => {
      expect(await one('MATCH (n:P) RETURN sum(n.age)')).toBe(90n);
      expect(await one('MATCH (n:P) RETURN avg(n.age)')).toBe(30);
      expect(typeof (await one('MATCH (n:P) RETURN avg(n.age)'))).toBe('number');
      expect(await one('MATCH (n:P) RETURN sum(n.s)')).toBe(3.5);
      expect(await one("MATCH (n:P {team: 'a'}) RETURN sum(n.v)")).toBe(1n);
      expect(await one('MATCH (n:Missing) RETURN sum(n.age)')).toBe(0n);
      expect(await one('MATCH (n:Missing) RETURN avg(n.age)')).toBe(null);
      expect(await one('UNWIND [1, 2.5] AS x RETURN sum(x)')).toBe(3.5);
      expect(await one('UNWIND [1, 2] AS x RETURN sum(x)')).toBe(3n);
    });

    it('finds min and max, across types in Cypher order', async () => {
      expect(await one('MATCH (n:P) RETURN min(n.age)')).toBe(20n);
      expect(await one('MATCH (n:P) RETURN max(n.age)')).toBe(40n);
      expect(await one('MATCH (n:P) RETURN max(n.team)')).toBe('b');
      // string < boolean < number
      expect(await one('MATCH (n:P) RETURN min(n.v)')).toBe('x');
      expect(await one('MATCH (n:P) RETURN max(n.v)')).toBe(2.5);
      expect(await one('UNWIND [true, false] AS b RETURN min(b)')).toBe(false);
      expect(await one('MATCH (n:Missing) RETURN max(n.age)')).toBe(null);
    });

    it('collects non-null values', async () => {
      const ages = (await one('MATCH (n) RETURN collect(n.age)')) as bigint[];
      expect([...ages].sort()).toEqual([20n, 30n, 40n]);
      expect(await one('MATCH (n:Missing) RETURN collect(n.age)')).toEqual([]);
      const teams = (await one('MATCH (n:P) RETURN collect(DISTINCT n.team)')) as string[];
      expect([...teams].sort()).toEqual(['a', 'b']);
      expect(await one('UNWIND [1, null, 2] AS x RETURN size(collect(x))')).toBe(2n);
    });

    it('combines aggregates with grouping keys and constants', async () => {
      expect(
        await rows(
          'MATCH (n:P) RETURN n.team AS t, count(*) * 10 + 1 AS x, max(n.age) - min(n.age) AS spread ORDER BY t',
        ),
      ).toEqual([
        { t: 'a', x: 21n, spread: 10n },
        { t: 'b', x: 21n, spread: 0n },
      ]);
      expect(
        await rows('MATCH (n:P) RETURN n.team AS t, count(*) AS c ORDER BY c DESC, t LIMIT 1'),
      ).toEqual([{ t: 'a', c: 2n }]);
      expect(
        await rows('MATCH (n:P) RETURN n, count(*) AS c ORDER BY n.age DESC LIMIT 1'),
      ).toHaveLength(1);
    });

    it('computes percentiles, per group, skipping nulls and non-numbers', async () => {
      const cont = (p: string, list = '[10, 20, 30, 40]'): Promise<CypherValue> =>
        one(`UNWIND ${list} AS x RETURN percentileCont(x, ${p})`);
      const disc = (p: string, list = '[10, 20, 30, 40]'): Promise<CypherValue> =>
        one(`UNWIND ${list} AS x RETURN percentileDisc(x, ${p})`);
      expect(await cont('0.5')).toBe(25);
      expect(await cont('0.25')).toBe(17.5);
      expect(await cont('1')).toBe(40);
      expect(await cont('0.5', '[3, 1, 2]')).toBe(2);
      // Disc keeps the type: integers stay integers, mixed values keep theirs.
      expect(await disc('0.5')).toBe(20n);
      expect(await disc('0.51')).toBe(30n);
      expect(await disc('0')).toBe(10n);
      expect(await disc('0.5', "[1, null, 'x', 2.5, 4]")).toBe(2.5);
      expect(await disc('0.5', '[null]')).toBe(null);
      expect(await cont('0.5', '[]')).toBe(null);
      expect(await disc('null')).toBe(null);
      expect(
        await rows(
          'MATCH (n:P) RETURN n.team AS t, percentileDisc(n.age, 1.0) AS p, percentileCont(n.age, 0.5) AS c ORDER BY t',
        ),
      ).toEqual([
        { t: 'a', p: 40n, c: 35 },
        { t: 'b', p: 20n, c: 20 },
      ]);
    });

    it('raises NumberOutOfRange for a percentile outside 0 to 1, when the query runs', async () => {
      for (const p of [1.5, -0.1, 2n]) {
        const query = 'UNWIND [1, 2] AS x RETURN percentileCont(x, $p) AS v';
        expect(() => graph.compile(query)).not.toThrow();
        await expect(rows(query, { p })).rejects.toMatchObject({ code: 'NumberOutOfRange' });
      }
      await expect(
        rows('UNWIND [1] AS x RETURN percentileDisc(x, $p) AS v', { p: 'half' }),
      ).rejects.toThrow(/must be a number/);
      expect(() => graph.compile("UNWIND [1] AS x RETURN percentileDisc(x, 'a')")).toThrow(
        SemanticError,
      );
      expect(() => graph.compile('UNWIND [1] AS x RETURN percentileDisc(x)')).toThrow(
        SemanticError,
      );
    });

    it('rejects aggregates in the wrong places', () => {
      const compile = (q: string): unknown => graph.compile(q);
      expect(() => compile('MATCH (n) WHERE count(*) > 1 RETURN n')).toThrow(SemanticError);
      expect(() => compile('MATCH (n) RETURN count(count(*))')).toThrow(SemanticError);
      expect(() => compile('MATCH (n) RETURN n.team, count(*) + n.age')).toThrow(SemanticError);
      expect(() => compile('MATCH (n) RETURN n.team ORDER BY count(*)')).toThrow(SemanticError);
      expect(() => compile('MATCH (n) RETURN n.team AS t, count(*) ORDER BY n.age')).toThrow(
        SemanticError,
      );
      expect(() => compile('MATCH (n) RETURN sum(n)')).toThrow(SemanticError);
    });
  });
}
