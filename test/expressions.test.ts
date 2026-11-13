import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  defaultMapping,
  SemanticError,
  type CypherValue,
  type Graph,
  type GraphMapping,
  type SqlExecutor,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

const mapping: GraphMapping = {
  ...defaultMapping,
  nodes: { ...defaultMapping.nodes, propertyTypes: { age: 'integer', name: 'string' } },
};

for (const backend of testBackends()) {
  describe(`expressions on ${backend.name}`, () => {
    let graph: Graph;
    let executor: SqlExecutor;

    beforeAll(async () => {
      const opened = await backend.open();
      const dialect = opened.dialect;
      executor = opened.executor;
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
      expect(await v("null + 'a'")).toBe(null);
    });

    it('concatenates a string with a number or boolean, as toString() writes them', async () => {
      expect(await v("1 + 'a'")).toBe('1a');
      expect(await v("'a' + -3")).toBe('a-3');
      expect(await v("'a' + 2.0")).toBe('a2.0');
      expect(await v("'a' + (0.1 + 0.2)")).toBe('a0.30000000000000004');
      expect(await v("'a' + 1e20")).toBe('a1.0E20');
      expect(await v("'a' + true")).toBe('atrue');
      expect(await v("false + 'a'")).toBe('falsea');
      // Types known only at run time: parameters and undeclared properties.
      expect(await v("$x + 'a'", { x: 1.5 })).toBe('1.5a');
      expect(await v("'a' + $x", { x: 12n })).toBe('a12');
      expect(await v("'a' + $x", { x: false })).toBe('afalse');
      expect(
        (await graph.query("MATCH (n:P) RETURN n.name + ':' + n.score AS s ORDER BY s")).map(
          (r) => r['s'],
        ),
      ).toEqual(['Ada:1.5', 'bob:2']);
      await expect(v('true + 1')).rejects.toThrow(/Type mismatch/);
      await expect(v("$x + 'a'", { x: [1n] })).resolves.toEqual([1n, 'a']);
      await expect(v("$x + 'a'", { x: { k: 1n } })).rejects.toThrow(/cannot apply/);
    });

    it('keeps number types in arithmetic', async () => {
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

    it('compares declared properties with parameters of any type, as Cypher does', async () => {
      const ages = async (cond: string, x: CypherValue): Promise<string[]> => names(cond, { x });
      expect(await ages('n.age > $x', 30n)).toEqual(['Ada']);
      expect(await ages('n.age >= $x', 36n)).toEqual(['Ada']);
      expect(await ages('$x < n.age', 30n)).toEqual(['Ada']);
      expect(await ages('$x >= n.age', 7n)).toEqual(['bob']);
      // A float against an integer property: by value.
      expect(await ages('n.age > $x', 35.5)).toEqual(['Ada']);
      expect(await ages('n.age < $x', 7.5)).toEqual(['bob']);
      expect(await ages('n.age <= $x', 6.9)).toEqual([]);
      expect(await ages('n.age = $x', 36.0)).toEqual(['Ada']);
      expect(await ages('n.age = $x', 36.5)).toEqual([]);
      // Another type: never equal, and not ordered.
      expect(await ages('n.age = $x', '36')).toEqual([]);
      expect(await ages('NOT n.age = $x', '36')).toEqual(['Ada', 'bob']);
      expect(await ages('n.age < $x', 'z')).toEqual([]);
      expect(await ages('n.name = $x', 'bob')).toEqual(['bob']);
      expect(await ages('n.name = $x', null)).toEqual([]);
      const values = await graph.query(
        `MATCH (n) RETURN n.name AS name, n.age = $s AS eq, n.age < $s AS lt, n.age = $i AS i
         ORDER BY name`,
        { s: 'x', i: 7n },
      );
      expect(values).toEqual([
        { name: 'Ada', eq: false, lt: null, i: false },
        { name: 'Cy', eq: null, lt: null, i: null },
        { name: 'bob', eq: false, lt: null, i: true },
      ]);
    });

    it('lets an index serve a declared property compared with a parameter', async () => {
      const plan = graph.compile('MATCH (n:P {name: $x}) RETURN n.age').steps[0]!;
      if (backend.name !== 'sqlite') {
        // A plain comparison, the shape an expression index on `properties ->> 'name'` serves.
        expect(plan.sql).toMatch(/\(n0\."properties" ->> 'name'\) = \(\$\d+::text\)\) AND/);
        return;
      }
      const used = await executor.transaction('write', async (tx) => {
        await tx.query(
          `CREATE INDEX IF NOT EXISTS nodes_name ON nodes (properties ->> '$."name"')`,
          [],
        );
        const values = plan.values.map((v) =>
          v.kind === 'sql'
            ? v.value
            : v.kind === 'parameterAs'
              ? 'Ada'
              : v.kind === 'parameterFits'
                ? 1
                : 10,
        );
        const rows = await tx.query(`EXPLAIN QUERY PLAN ${plan.sql}`, values);
        await tx.query('DROP INDEX nodes_name', []);
        return rows.map((r) => String(r['detail'])).join('\n');
      });
      expect(used).toMatch(/USING INDEX nodes_name/);
    });

    it('evaluates simple CASE with Cypher equality', async () => {
      const simple = (value: string): Promise<CypherValue> =>
        v(
          `CASE ${value} WHEN 1 THEN 'one' WHEN 2.0 THEN 'two' WHEN null THEN 'null' ELSE 'other' END`,
        );
      expect(await simple('1')).toBe('one');
      expect(await simple('2')).toBe('two');
      expect(await simple("'1'")).toBe('other');
      expect(await simple('null')).toBe('other');
      expect(await v("CASE $x WHEN 1 THEN 'one' ELSE 'other' END", { x: '1' })).toBe('other');
      expect(await v('CASE $x WHEN 1 THEN true END', { x: 1n })).toBe(true);
      expect(await v('CASE $x WHEN 1 THEN true END', { x: 2n })).toBe(null);
      expect(await v('CASE [1, 2] WHEN [1, 2] THEN 1 ELSE 0 END')).toBe(1n);
    });

    it('evaluates generic CASE, taking the first true condition', async () => {
      expect(await v('CASE WHEN 1 > 2 THEN 1 WHEN 2 > 1 THEN 2 WHEN true THEN 3 END')).toBe(2n);
      expect(await v('CASE WHEN null THEN 1 ELSE 2 END')).toBe(2n);
      expect(await v('CASE WHEN false THEN 1 END')).toBe(null);
      expect(
        (
          await graph.query(
            `MATCH (n) RETURN n.name AS name,
               CASE WHEN n.age >= 18 THEN 'adult' WHEN n.age < 18 THEN 'minor' ELSE 'unknown' END AS group
             ORDER BY name`,
          )
        ).map((r) => r['group']),
      ).toEqual(['adult', 'unknown', 'minor']);
      expect(await names("CASE n.name WHEN 'Ada' THEN true ELSE n:Q END")).toEqual(['Ada', 'Cy']);
    });

    it('types CASE results from their branches', async () => {
      // One native type, then mixed types as JSON (integers stay integers).
      expect(await v('CASE WHEN true THEN 1 ELSE 2 END + 1')).toBe(2n);
      expect(
        await v("[CASE WHEN true THEN 1 ELSE 'a' END, CASE WHEN false THEN 1 ELSE 'a' END]"),
      ).toEqual([1n, 'a']);
      expect(await v('CASE WHEN true THEN 1.5 ELSE 1 END')).toBe(1.5);
      expect(await v('CASE WHEN true THEN [1, 2] END[1]')).toBe(2n);
      expect(await v('CASE WHEN true THEN null END')).toBe(null);
      expect(
        (
          await graph.query(
            `MATCH (n:P) RETURN CASE WHEN n.age > 10 THEN n END AS n ORDER BY n.name`,
          )
        ).map(
          (r) =>
            (r['n'] as { properties: Record<string, unknown> } | null)?.properties['name'] ?? null,
        ),
      ).toEqual(['Ada', null]);
      expect(
        await graph.query(
          `MATCH (n) RETURN CASE WHEN count(*) > 2 THEN 'many' ELSE 'few' END AS size`,
        ),
      ).toEqual([{ size: 'many' }]);
      expect(() => graph.compile("RETURN CASE WHEN true THEN 'a' END - 1 AS v")).toThrow(
        SemanticError,
      );
    });

    it('rejects static type errors at compile time', () => {
      for (const expr of [
        '1 AND true',
        '[] OR true',
        "NOT 'a'",
        "'a' - 1",
        'true + 1',
        '1 IN 2',
        'CASE WHEN 1 THEN 2 END',
      ]) {
        expect(() => graph.compile(`RETURN ${expr} AS v`), expr).toThrow(SemanticError);
      }
    });
  });
}
