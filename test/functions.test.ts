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
  describe(`functions on ${backend.name}`, () => {
    let graph: Graph;

    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      graph = createGraph({ dialect, executor });
      await createGraph({ dialect, executor, readOnly: false }).query(
        `CREATE (:A:B {name: ' Ada ', n: 7, f: 2.5, tags: ['x', 'y', 'z']})-[:KNOWS {since: 1}]->(:C)`,
      );
    });
    afterAll(() => backend.dispose?.());

    /** Evaluates `<expr>` with `a` bound to the :A node and `r` to the relationship. */
    const v = async (
      expr: string,
      params: Record<string, CypherValue> = {},
    ): Promise<CypherValue> =>
      (await graph.query(`MATCH (a:A)-[r]->(c) RETURN ${expr} AS v`, params))[0]!['v']!;

    it('reads entities', async () => {
      expect(await v('labels(a)')).toEqual(['A', 'B']);
      expect(await v('type(r)')).toBe('KNOWS');
      expect(await v('keys(a)')).toEqual(['f', 'n', 'name', 'tags']);
      expect(await v('keys(r)')).toEqual(['since']);
      expect(await v('properties(r)')).toEqual({ since: 1n });
      expect(await v('id(a) <> id(c)')).toBe(true);
      expect(await v('keys({b: 1, a: null})')).toEqual(['a', 'b']);
      expect(await v('labels(null)')).toBe(null);
    });

    it('converts between types', async () => {
      expect(await v('toString(a.n)')).toBe('7');
      expect(await v('toString(a.f)')).toBe('2.5');
      expect(await v('toString(1.0)')).toBe('1.0');
      expect(await v('toString(true)')).toBe('true');
      // Floats as Java's Double.toString writes them, like Neo4j.
      expect(await v('toString(0.1 + 0.2)')).toBe('0.30000000000000004');
      expect(await v('toString(0.001)')).toBe('0.001');
      expect(await v('toString(0.0009)')).toBe('9.0E-4');
      expect(await v('toString(9999999.0)')).toBe('9999999.0');
      expect(await v('toString(10000000.0)')).toBe('1.0E7');
      expect(await v('toString(-1.5e-10)')).toBe('-1.5E-10');
      expect(await v('toString(1.7976931348623157e308)')).toBe('1.7976931348623157E308');
      expect(await v('toString(-123.456)')).toBe('-123.456');
      expect(await v('toString(0.0)')).toBe('0.0');
      expect(await v('toString($f)', { f: 1e21 })).toBe('1.0E21');
      expect(await v("toInteger(' 42 ')")).toBe(42n);
      expect(await v("toInteger('4.7')")).toBe(4n);
      expect(await v('toInteger(-4.7)')).toBe(-4n);
      expect(await v("toInteger('x')")).toBe(null);
      expect(await v('toInteger($p)', { p: 'nope' })).toBe(null);
      expect(await v("toFloat('1e3')")).toBe(1000);
      expect(await v('toFloat(a.n)')).toBe(7);
      expect(typeof (await v('toFloat(a.n)'))).toBe('number');
      expect(await v("toBoolean(' TRUE ')")).toBe(true);
      expect(await v("toBoolean('yes')")).toBe(null);
      expect(await v('toBoolean(0)')).toBe(false);
    });

    it('evaluates coalesce with typed and JSON arguments', async () => {
      expect(await v('coalesce(null, a.missing, a.n, 1)')).toBe(7n);
      expect(await v('coalesce(null, 2, 3)')).toBe(2n);
      expect(await v('coalesce(a.missing, null)')).toBe(null);
    });

    it('works on lists', async () => {
      expect(await v('size(a.tags)')).toBe(3n);
      expect(await v('head(a.tags)')).toBe('x');
      expect(await v('last(a.tags)')).toBe('z');
      expect(await v('tail(a.tags)')).toEqual(['y', 'z']);
      expect(await v('head([])')).toBe(null);
      expect(await v('tail([])')).toEqual([]);
      expect(await v('reverse([1, 2.5, null])')).toEqual([null, 2.5, 1n]);
      expect(await v('range(1, 4)')).toEqual([1n, 2n, 3n, 4n]);
      expect(await v('range(5, 0, -2)')).toEqual([5n, 3n, 1n]);
      expect(await v('range(3, 1)')).toEqual([]);
      expect(await v('size(range(1, $n))', { n: 10n })).toBe(10n);
    });

    it('works on strings', async () => {
      expect(await v('size(a.name)')).toBe(5n);
      expect(await v('trim(a.name)')).toBe('Ada');
      expect(await v('toUpper(trim(a.name))')).toBe('ADA');
      expect(await v("toLower('AbC')")).toBe('abc');
      expect(await v("substring('hello', 1, 3)")).toBe('ell');
      expect(await v("substring('hello', 2)")).toBe('llo');
      expect(await v("left('hello', 2)")).toBe('he');
      expect(await v("right('hello', 2)")).toBe('lo');
      expect(await v("right('hello', 0)")).toBe('');
      expect(await v("replace('a-b-c', '-', '+')")).toBe('a+b+c');
      expect(await v("split('a,b,,c', ',')")).toEqual(['a', 'b', '', 'c']);
      expect(await v("split('', ',')")).toEqual(['']);
      expect(await v("reverse('abc')")).toBe('cba');
      expect(await v('reverse($s)', { s: 'xyz' })).toBe('zyx');
    });

    it('does math', async () => {
      expect(await v('abs(-3)')).toBe(3n);
      expect(await v('abs(-a.f)')).toBe(2.5);
      expect(await v('sign(-2.5)')).toBe(-1n);
      expect(await v('round(2.5)')).toBe(3);
      expect(await v('round(-2.5)')).toBe(-2);
      expect(await v('floor(2.7)')).toBe(2);
      expect(await v('ceil(a.f)')).toBe(3);
      expect(await v('sqrt(16)')).toBe(4);
      expect(await v('log10(1000)')).toBeCloseTo(3);
      expect(await v('exp(0)')).toBe(1);
      expect(await v('pi()')).toBeCloseTo(Math.PI);
      const r = await v('rand()');
      expect(typeof r === 'number' && r >= 0 && r < 1).toBe(true);
    });

    it('filters with functions', async () => {
      const rows = await graph.query(
        "MATCH (n) WHERE size(labels(n)) > 1 AND toLower(trim(n.name)) STARTS WITH 'a' RETURN n.n AS n",
      );
      expect(rows).toEqual([{ n: 7n }]);
    });

    it('is case-insensitive in function names', async () => {
      expect(await v('TOUPPER(trim(a.name))')).toBe('ADA');
    });

    it('rejects bad calls at compile time', () => {
      const compile = (expr: string): unknown => graph.compile(`RETURN ${expr} AS v`);
      expect(() => compile('size(1, 2)')).toThrow(SemanticError);
      expect(() => compile('toUpper(1)')).toThrow(SemanticError);
      expect(() => compile("substring('a', 'b')")).toThrow(SemanticError);
      expect(() => compile('toUpper(DISTINCT "a")')).toThrow(SemanticError);
      expect(() => compile('nosuch(1)')).toThrow(UnsupportedFeatureError);
      expect(() => compile('stDev(1)')).toThrow(/stDev\(\) is not supported/);
      try {
        compile('nosuch(1)');
      } catch (error) {
        expect((error as UnsupportedFeatureError).hint).toMatch(/Supported functions: .*toupper/);
      }
    });
  });
}
