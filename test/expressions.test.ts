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
  nodes: { ...defaultMapping.nodes, propertyTypes: { age: 'integer', name: 'string' } },
};

for (const backend of testBackends()) {
  describe(`expressions on ${backend.name}`, () => {
    let graph: Graph;

    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      graph = createGraph({ dialect, executor, mapping });
      await createGraph({ dialect, executor, mapping, readOnly: false }).query(
        `CREATE (:P {name: 'Ada', age: 36, score: 1.5, tags: ['a', 'b'], nick: 'a%_'}),
                (:P {name: 'bob', age: 7, score: 2}),
                (:Q {name: 'Cy'})`,
      );
    });
    afterAll(() => backend.dispose?.());

    /** Evaluates `RETURN <expr> AS v`. */
    const v = async (
      expr: string,
      params: Record<string, CypherValue> = {},
    ): Promise<CypherValue> => (await graph.query(`RETURN ${expr} AS v`, params))[0]!['v']!;

    /** Names of P/Q nodes matching `WHERE <cond>`, sorted. */
    const names = async (
      cond: string,
      params: Record<string, CypherValue> = {},
    ): Promise<string[]> =>
      (await graph.query(`MATCH (n) WHERE ${cond} RETURN n.name AS name`, params))
        .map((r) => r['name'] as string)
        .sort();

    it('uses three-valued logic', async () => {
      expect(await v('true AND null')).toBe(null);
      expect(await v('false AND null')).toBe(false);
      expect(await v('true OR null')).toBe(true);
      expect(await v('false OR null')).toBe(null);
      expect(await v('true XOR null')).toBe(null);
      expect(await v('true XOR false')).toBe(true);
      expect(await v('NOT null')).toBe(null);
    });

    it('compares numbers by value and different types as unequal and unordered', async () => {
      expect(await v('1 = 1.0')).toBe(true);
      expect(await v('1 < 1.5')).toBe(true);
      expect(await v("1 = '1'")).toBe(false);
      expect(await v("1 <> '1'")).toBe(true);
      expect(await v("1 < '1'")).toBe(null);
      expect(await v('null = null')).toBe(null);
      expect(await v('$p = 2', { p: 2.0 })).toBe(true);
      expect(await v('$p < $q', { p: 'a', q: 'b' })).toBe(true);
      expect(await v('$p < $q', { p: 'a', q: 1n })).toBe(null);
    });

    it('compares strings by code point, case sensitively', async () => {
      expect(await v("'B' < 'a'")).toBe(true);
      expect(await v("'a' = 'A'")).toBe(false);
      expect(await names("n.name < 'C'")).toEqual(['Ada']);
    });

    it('compares lists and maps structurally', async () => {
      expect(await v('[1, [2]] = [1.0, [2.0]]')).toBe(true);
      expect(await v('[1, null] = [1, null]')).toBe(null);
      expect(await v('[1, null] = [2, null]')).toBe(false);
      expect(await v('[1, 2] = [1]')).toBe(false);
      expect(await v('{a: 1} = {a: 1.0}')).toBe(true);
      expect(await v('{a: null} = {a: null}')).toBe(null);
      expect(await v('{a: 1} = {b: 1}')).toBe(false);
      expect(await v('[1, 2] < [1, 3]')).toBe(true);
      expect(await v('[1, 2] < [1]')).toBe(false);
      expect(await v('[1, null] < [1, 2]')).toBe(null);
      expect(await names('n.tags = $t', { t: ['a', 'b'] })).toEqual(['Ada']);
    });

    it('evaluates IN with nulls', async () => {
      expect(await v('2 IN [1, 2]')).toBe(true);
      expect(await v('3 IN [1, 2]')).toBe(false);
      expect(await v('3 IN [1, null]')).toBe(null);
      expect(await v('null IN [1]')).toBe(null);
      expect(await v('1 IN []')).toBe(false);
      expect(await v('[1] IN [[1.0], 2]')).toBe(true);
      expect(await names("n.name IN ['Ada', 'Cy', 1]")).toEqual(['Ada', 'Cy']);
    });

    it('evaluates string predicates without LIKE wildcards', async () => {
      expect(await v("'abc' STARTS WITH 'ab'")).toBe(true);
      expect(await v("'abc' ENDS WITH ''")).toBe(true);
      expect(await v("'abc' CONTAINS 'B'")).toBe(false);
      expect(await v("1 STARTS WITH 'a'")).toBe(null);
      expect(await names("n.nick STARTS WITH 'a%'")).toEqual(['Ada']);
      expect(await names("n.nick CONTAINS '_'")).toEqual(['Ada']);
      expect(await names("n.name STARTS WITH 'a'")).toEqual([]);
    });

    it('evaluates IS NULL on missing properties', async () => {
      expect(await names('n.score IS NULL')).toEqual(['Cy']);
      expect(await names('n.score IS NOT NULL')).toEqual(['Ada', 'bob']);
    });

    it('does arithmetic with Cypher number types', async () => {
      expect(await v('7 / 2')).toBe(3n);
      expect(await v('-7 / 2')).toBe(-3n);
      expect(await v('7 % 3')).toBe(1n);
      expect(await v('7.5 % 2')).toBe(1.5);
      expect(await v('7 / 2.0')).toBe(3.5);
      expect(await v('2 ^ 3')).toBe(8);
      expect(await v('0.1 + 0.2')).toBe(0.30000000000000004);
      expect(await v("'a' + 'b'")).toBe('ab');
      expect(await v('1 + null')).toBe(null);
      expect(await v('1.0 / 0')).toBe(Infinity);
      expect(await v('$x + 1', { x: 2n })).toBe(3n);
      expect(await v('$x + 1', { x: 2.5 })).toBe(3.5);
      expect(await v('$x * 2', { x: 2.0 })).toBe(4);
      expect(typeof (await v('$x * 2', { x: 2.0 }))).toBe('number');
      expect(await v('[1] + [2, 3] + 4')).toEqual([1n, 2n, 3n, 4n]);
      expect(await v('-$x', { x: 2n })).toBe(-2n);
    });

    it('filters with labels, arithmetic, and declared types', async () => {
      expect(await names('n:P AND n.age > 10')).toEqual(['Ada']);
      expect(await names('n:Q OR n.score >= 2')).toEqual(['Cy', 'bob']);
      expect(await names('NOT n:P')).toEqual(['Cy']);
      expect(await names('n.age + 1 = 8')).toEqual(['bob']);
      expect(await names('n.score * 2 = 3.0')).toEqual(['Ada']);
    });

    it('reads declared properties as typed SQL values', () => {
      const sql = graph.compile('MATCH (n) WHERE n.age > 30 RETURN n.age').steps[0]!.sql;
      expect(sql).toMatch(backend.name === 'postgres' ? /->> 'age'\)::bigint/ : /->> '\$\."age"'/);
    });

    it('rejects static type errors at compile time', () => {
      for (const expr of ['1 AND true', '[] OR true', "NOT 'a'", "'a' - 1", 'true + 1', '1 IN 2']) {
        expect(() => graph.compile(`RETURN ${expr} AS v`), expr).toThrow(SemanticError);
      }
    });
  });
}
