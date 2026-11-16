import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  defaultMapping,
  LimitExceededError,
  SemanticError,
  UnsupportedFeatureError,
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
                (a:P {name: 'a', age: 30})-[:R]->(a), (:P {name: 'c', v: true})`,
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

    it('orders entities and paths among the other types', async () => {
      const query = (dir: string): string =>
        "MATCH p = (n:P {name: 'a'})-[r]->() " +
        "UNWIND [n, r, p, 1.5, ['list'], 'text', null, false, {a: 'map'}] AS x " +
        `RETURN x ORDER BY x ${dir}`;
      const kinds = (rows: CypherValue[]): string[] =>
        rows.map((x) =>
          x === null
            ? 'null'
            : Array.isArray(x)
              ? 'list'
              : typeof x === 'object'
                ? x.constructor.name.replace('Cypher', '').toLowerCase()
                : typeof x,
        );
      const ascending = [
        'object',
        'node',
        'relationship',
        'list',
        'path',
        'string',
        'boolean',
        'number',
        'null',
      ];
      expect(kinds(await column(query('')))).toEqual(ascending);
      expect(kinds(await column(query('DESC')))).toEqual([...ascending].reverse());
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
      // Reserved words as parameter names, as in Neo4j (#66).
      expect(
        await column('MATCH (n) RETURN n.name AS x ORDER BY x SKIP $skip LIMIT $limit', {
          skip: 1n,
          limit: 2n,
        }),
      ).toEqual(['a', 'b']);
      await expect(column(q, { s: -1n, l: 1n })).rejects.toThrow(SemanticError);
      expect(() => graph.compile('RETURN 1 SKIP 1.5')).toThrow(SemanticError);
    });

    it.runIf(backend.name === 'mysql')(
      'accepts only literals and parameters in SKIP and LIMIT on MySQL',
      () => {
        // MySQL's LIMIT takes no expression.
        expect(() => graph.compile('MATCH (n) RETURN n SKIP 1 + 1')).toThrow(
          UnsupportedFeatureError,
        );
        // Variables are still a SemanticError.
        expect(() => graph.compile('MATCH (n) RETURN n SKIP n.age')).toThrow(SemanticError);
      },
    );

    it.skipIf(backend.name === 'mysql')(
      'applies SKIP and LIMIT expressions that use no variables, computed once',
      async () => {
        const names = 'MATCH (n) RETURN n.name AS x ORDER BY x';
        expect(await column(`${names} SKIP 1 + 1 LIMIT toInteger(ceil(0.5))`)).toEqual(['b']);
        expect(await column(`${names} SKIP $s - 1 LIMIT size([1, 2])`, { s: 1n })).toEqual([
          'B',
          'a',
        ]);
        // In a WITH stage, and after aggregation.
        expect(
          await column('MATCH (n) WITH n ORDER BY n.name LIMIT 1 + 2 RETURN count(*) AS c'),
        ).toEqual([3n]);
        expect(
          await column('MATCH (n) RETURN n.age AS a, count(*) AS c ORDER BY a SKIP 2 - 1 LIMIT 1'),
        ).toEqual([30n]);
        // rand() is drawn once: the count is one of 0..4, not a mix of rows.
        const [count] = await column(
          'MATCH (n) WITH n SKIP toInteger(rand() * 4) RETURN count(*) AS c',
        );
        expect(Number(count)).toBeGreaterThanOrEqual(1);
        expect(Number(count)).toBeLessThanOrEqual(4);
      },
    );

    it.skipIf(backend.name === 'mysql')(
      'rejects SKIP and LIMIT expressions with variables, or of the wrong value',
      async () => {
        for (const query of [
          'MATCH (n) RETURN n SKIP n.age',
          'MATCH (n) RETURN n LIMIT size(n.name)',
          'MATCH (n) RETURN n LIMIT count(*)',
          'RETURN 1 LIMIT 0.5 * 2',
          "RETURN 1 LIMIT 'a' + 'b'",
        ]) {
          expect(() => graph.compile(query), query).toThrow(SemanticError);
        }
        await expect(column('RETURN 1 AS x LIMIT 1 - 2')).rejects.toMatchObject({
          code: 'NegativeIntegerArgument',
        });
        await expect(column('RETURN 1 AS x SKIP $l + 0', { l: 'a' })).rejects.toThrow();
        await expect(column('RETURN 1 AS x LIMIT toInteger($l)', { l: 1.5 })).resolves.toEqual([
          1n,
        ]);
        // The row cap still applies when the LIMIT is larger.
        const limits = { limits: { maxRowsPerStep: 2 } };
        const unwind = 'UNWIND range(1, 5) AS x RETURN x';
        expect(await graph.query(`${unwind} LIMIT 1 + 1`, {}, limits)).toHaveLength(2);
        await expect(graph.query(`${unwind} LIMIT 2 + 3`, {}, limits)).rejects.toThrow(
          LimitExceededError,
        );
      },
    );

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
