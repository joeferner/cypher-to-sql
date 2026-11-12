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
  describe(`RETURN options on ${backend.name}`, () => {
    let graph: Graph;

    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      graph = createGraph({ dialect, executor, mapping });
      await createGraph({ dialect, executor, mapping, readOnly: false }).query(
        `CREATE (:P {name: 'b', age: 30, v: 2}), (:P {name: 'B', age: 20, v: 'x'}),
                (:P {name: 'a', age: 30}), (:P {name: 'c', v: true})`,
      );
    });
    afterAll(() => backend.dispose?.());

    const column = async (
      cypher: string,
      params: Record<string, CypherValue> = {},
    ): Promise<CypherValue[]> =>
      (await graph.query(cypher, params)).map((r) => Object.values(r)[0] ?? null);

    it('orders strings by code point and declared integers numerically', async () => {
      expect(await column('MATCH (n) RETURN n.name AS x ORDER BY x')).toEqual(['B', 'a', 'b', 'c']);
      expect(await column('MATCH (n) RETURN n.name AS x ORDER BY n.age DESC, x')).toEqual([
        'c',
        'a',
        'b',
        'B',
      ]);
    });

    it('orders mixed types in Cypher order, with nulls last ascending and first descending', async () => {
      expect(await column('MATCH (n) RETURN n.v AS v ORDER BY v')).toEqual(['x', true, 2n, null]);
      expect(await column('MATCH (n) RETURN n.v AS v ORDER BY v DESC')).toEqual([
        null,
        2n,
        true,
        'x',
      ]);
      expect(
        await column('UNWIND [2, 1.5, {a: 1}, [1], null, false, "z"] AS x RETURN x ORDER BY x'),
      ).toEqual([{ a: 1n }, [1n], 'z', false, 1.5, 2n, null]);
    });

    it('orders by expressions and by variables that are not returned', async () => {
      expect(
        await column('MATCH (n:P) WHERE n.age IS NOT NULL RETURN n.name ORDER BY -n.age, n.name'),
      ).toEqual(['a', 'b', 'B']);
      // An alias hides the variable it shadows.
      expect(await column('MATCH (n) RETURN n.age AS n ORDER BY n DESC LIMIT 1')).toEqual([null]);
    });

    it('applies SKIP and LIMIT, as literals or parameters', async () => {
      const q = 'MATCH (n) RETURN n.name AS x ORDER BY x SKIP $s LIMIT $l';
      expect(await column(q, { s: 1n, l: 2n })).toEqual(['a', 'b']);
      expect(await column('MATCH (n) RETURN n.name AS x ORDER BY x SKIP 3')).toEqual(['c']);
      await expect(column(q, { s: -1n, l: 1n })).rejects.toThrow(SemanticError);
      expect(() => graph.compile('RETURN 1 SKIP 1.5')).toThrow(SemanticError);
    });

    it('removes duplicate rows with DISTINCT, including nodes and lists', async () => {
      expect(await column('MATCH (n) RETURN DISTINCT n.age AS a ORDER BY a')).toEqual([
        20n,
        30n,
        null,
      ]);
      expect(await graph.query('MATCH (n), (m) RETURN DISTINCT n ORDER BY n.name')).toHaveLength(4);
      expect(await column('UNWIND [[1], [1], [2]] AS l RETURN DISTINCT l ORDER BY l')).toEqual([
        [1n],
        [2n],
      ]);
    });

    it('allows only projected values in ORDER BY after DISTINCT', async () => {
      expect(await column('MATCH (n) RETURN DISTINCT n.name AS x ORDER BY n.name DESC')).toEqual([
        'c',
        'b',
        'a',
        'B',
      ]);
      expect(await column('MATCH (n) RETURN DISTINCT n ORDER BY n.name LIMIT 1')).toHaveLength(1);
      expect(() => graph.compile('MATCH (n) RETURN DISTINCT n.name ORDER BY n.age')).toThrow(
        SemanticError,
      );
    });
  });
}
