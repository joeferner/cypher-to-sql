import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  SemanticError,
  UnsupportedFeatureError,
  type CypherValue,
  type Graph,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

for (const backend of testBackends()) {
  describe(`list expressions on ${backend.name}`, () => {
    let graph: Graph;

    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      graph = createGraph({ dialect, executor });
      await createGraph({ dialect, executor, readOnly: false }).query(
        `CREATE (:P {name: 'Ada', tags: ['a', 'b', 'c']})-[:R {w: 1}]->(:P {name: 'Bob', tags: []})
                -[:R {w: 2}]->(:P {name: 'Cy'})`,
      );
    });
    afterAll(() => backend.dispose?.());

    /** Evaluates `RETURN <expr> AS v`. */
    const v = async (
      expr: string,
      params: Record<string, CypherValue> = {},
    ): Promise<CypherValue> => (await graph.query(`RETURN ${expr} AS v`, params))[0]!['v']!;

    it('indexes lists', async () => {
      expect(await v('[1, 2, 3][0]')).toBe(1n);
      expect(await v('[1, 2, 3][2]')).toBe(3n);
      expect(await v('[1, 2, 3][-1]')).toBe(3n);
      expect(await v('[1, 2, 3][3]')).toBe(null);
      expect(await v('[1, 2, 3][-4]')).toBe(null);
      expect(await v('[[1, 2], [3]][0][1]')).toBe(2n);
      expect(await v('$l[$i]', { l: ['x', 'y'], i: 1n })).toBe('y');
      expect(await v('[1, 2][null]')).toBe(null);
      expect(await v('null[0]')).toBe(null);
      expect(await v('$l[$i]', { l: ['x'], i: 'a' })).toBe(null);
    });

    it('looks up maps, nodes, and relationships by key', async () => {
      expect(await v("{a: 1, b: {c: 2}}['b']['c']")).toBe(2n);
      expect(await v('$m[$k]', { m: { 'a"b': 1n, a: 2n }, k: 'a"b' })).toBe(1n);
      expect(await v("{a: 1}['z']")).toBe(null);
      expect(
        await graph.query(
          `MATCH (n:P {name: 'Ada'})-[r]->() WITH n, r, 'name' AS k
           RETURN n['name'] AS name, n[k] AS byKey, r['w'] AS w, n.tags[1] AS tag`,
        ),
      ).toEqual([{ name: 'Ada', byKey: 'Ada', w: 1n, tag: 'b' }]);
    });

    it('slices lists', async () => {
      expect(await v('[1, 2, 3, 4][1..3]')).toEqual([2n, 3n]);
      expect(await v('[1, 2, 3][1..]')).toEqual([2n, 3n]);
      expect(await v('[1, 2, 3][..2]')).toEqual([1n, 2n]);
      expect(await v('[1, 2, 3][-2..]')).toEqual([2n, 3n]);
      expect(await v('[1, 2, 3][3..1]')).toEqual([]);
      expect(await v('[1, 2, 3][-5..5]')).toEqual([1n, 2n, 3n]);
      expect(await v('[1, 2, 3][1..null]')).toBe(null);
      expect(await v('$l[$a..$b]', { l: [1n, 2n, 3n], a: 0n, b: -1n })).toEqual([1n, 2n]);
    });

    it('builds lists with comprehensions', async () => {
      expect(await v('[x IN [1, 2, 3, 4] WHERE x % 2 = 0]')).toEqual([2n, 4n]);
      expect(await v('[x IN [1, 2, 3] | x * 10]')).toEqual([10n, 20n, 30n]);
      expect(await v('[x IN [1, null, 3] WHERE x > 1 | toString(x)]')).toEqual(['3']);
      expect(await v('[x IN [1, null] | x]')).toEqual([1n, null]);
      expect(await v('[x IN [] | x]')).toEqual([]);
      expect(await v('[x IN null | x]')).toBe(null);
      expect(await v('[x IN [[1, 2], [3]] | [y IN x | y + 1]]')).toEqual([[2n, 3n], [4n]]);
      expect(await v('size([x IN range(1, 10) WHERE x > 7])')).toBe(3n);
    });

    it('evaluates quantifiers with three-valued logic', async () => {
      expect(await v('all(x IN [1, 2] WHERE x > 0)')).toBe(true);
      expect(await v('all(x IN [1, -2] WHERE x > 0)')).toBe(false);
      expect(await v('all(x IN [1, null] WHERE x > 0)')).toBe(null);
      expect(await v('all(x IN [-1, null] WHERE x > 0)')).toBe(false);
      expect(await v('any(x IN [1, null] WHERE x > 0)')).toBe(true);
      expect(await v('any(x IN [-1, null] WHERE x > 0)')).toBe(null);
      expect(await v('none(x IN [-1, -2] WHERE x > 0)')).toBe(true);
      expect(await v('none(x IN [1, null] WHERE x > 0)')).toBe(false);
      expect(await v('single(x IN [1, -2] WHERE x > 0)')).toBe(true);
      expect(await v('single(x IN [1, 2] WHERE x > 0)')).toBe(false);
      expect(await v('single(x IN [1, null] WHERE x > 0)')).toBe(null);
      expect(await v('single(x IN [1, 2, null] WHERE x > 0)')).toBe(false);
      expect(
        await v(
          '[all(x IN [] WHERE x), any(x IN [] WHERE x), none(x IN [] WHERE x), single(x IN [] WHERE x)]',
        ),
      ).toEqual([true, false, true, false]);
      expect(await v('any(x IN null WHERE x)')).toBe(null);
    });

    it('works on entities, paths, and outer variables', async () => {
      expect(
        await graph.query(
          `MATCH p = (a:P {name: 'Ada'})-[*]->(c:P {name: 'Cy'})
           RETURN [n IN nodes(p) | n.name] AS names,
                  [r IN relationships(p) WHERE r.w > 1 | r.w] AS heavy,
                  all(n IN nodes(p) WHERE n:P) AS allP,
                  any(n IN nodes(p) WHERE n.name = a.name) AS hasA`,
        ),
      ).toEqual([{ names: ['Ada', 'Bob', 'Cy'], heavy: [2n], allP: true, hasA: true }]);
      expect(
        await graph.query(`MATCH (n:P) WHERE any(t IN n.tags WHERE t = 'b') RETURN n.name AS name`),
      ).toEqual([{ name: 'Ada' }]);
      // The element variable hides an outer variable of the same name.
      expect(
        await graph.query(
          `MATCH (n:P {name: 'Bob'}) RETURN [n IN [1, 2] | n * 2] AS l, n.name AS name`,
        ),
      ).toEqual([{ l: [2n, 4n], name: 'Bob' }]);
    });

    it('works with aggregation, WITH, and ORDER BY', async () => {
      expect(
        await graph.query(
          `MATCH (n:P) RETURN [x IN collect(n.name) WHERE x <> 'Bob'] AS names, count(*) AS c`,
        ),
      ).toEqual([{ names: expect.arrayContaining(['Ada', 'Cy']) as unknown, c: 3n }]);
      expect(
        await graph.query(
          `MATCH (n:P) WITH n.name AS name, [t IN coalesce(n.tags, []) | t] AS tags
           WHERE size(tags) > 0 RETURN name, tags[0] AS first ORDER BY [x IN tags | x][0]`,
        ),
      ).toEqual([{ name: 'Ada', first: 'a' }]);
    });

    it('rejects type errors and misuse', async () => {
      await expect(v('true[0]')).rejects.toThrow(SemanticError);
      await expect(v('[1, 2][1.5]')).rejects.toThrow(SemanticError);
      await expect(v("[1, 2]['a']")).rejects.toThrow(SemanticError);
      await expect(v('{a: 1}[0]')).rejects.toThrow(SemanticError);
      await expect(v('[1, 2][true..]')).rejects.toThrow(SemanticError);
      await expect(v('[x IN 5 | x]')).rejects.toThrow(SemanticError);
      await expect(v('all(x IN [1])')).rejects.toThrow(SemanticError);
      await expect(v('[x IN [1, 2] | count(*)]')).rejects.toThrow(SemanticError);
      await expect(v('any(x IN [1] WHERE sum(x) > 0)')).rejects.toThrow(SemanticError);
      await expect(v('[x IN [1] | y]')).rejects.toThrow(SemanticError);
      await expect(v('[x IN [1] | x], x')).rejects.toThrow(SemanticError);
      await expect(v('[p = ()-->() | p]')).rejects.toThrow(UnsupportedFeatureError);
    });
  });
}
