import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  CypherArgumentError,
  CypherTypeError,
  type CypherError,
  type CypherValue,
  type Graph,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

for (const backend of testBackends()) {
  describe(`run-time errors on ${backend.name}`, () => {
    let graph: Graph;

    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      graph = createGraph({ dialect, executor });
      await createGraph({ dialect, executor, readOnly: false }).query(
        "CREATE (:N {name: 'a', n: 1, l: [1, 2], b: true}), (:N {name: 'b'})",
      );
    });
    afterAll(() => backend.dispose?.());

    /** The error of `query`, which must fail. */
    const error = async (
      query: string,
      params: Record<string, CypherValue> = {},
    ): Promise<CypherError> => {
      try {
        await graph.query(query, params);
      } catch (e) {
        return e as CypherError;
      }
      throw new Error(`Expected ${query} to fail`);
    };

    /** Evaluates `RETURN <expr> AS v`. */
    const v = async (
      expr: string,
      params: Record<string, CypherValue> = {},
    ): Promise<CypherValue> => (await graph.query(`RETURN ${expr} AS v`, params))[0]!['v']!;

    it('raises a type error for values of the wrong type, with its position', async () => {
      const e = await error('MATCH (n:N) WHERE n.name RETURN n');
      expect(e).toBeInstanceOf(CypherTypeError);
      // The position of `n.name` (a property access is at its `.name`).
      expect(e).toMatchObject({ code: 'InvalidArgumentType', position: { line: 1, column: 19 } });
      expect(e.message).toMatch(/expected a boolean/);
      for (const query of [
        'MATCH (n:N) RETURN n.name + n.n',
        'MATCH (n:N) RETURN -n.name',
        'MATCH (n:N) RETURN n.n:Label',
        'MATCH (n:N) RETURN n.name[0]',
        'MATCH (n:N) RETURN n.l[n.name]',
        'MATCH (n:N) RETURN n.l[n.name..]',
        'MATCH (n:N) RETURN [x IN n.name | x]',
        'MATCH (n:N) RETURN any(x IN n.n WHERE x)',
        'MATCH (n:N) RETURN 1 IN n.name',
        'MATCH (n:N) RETURN toUpper(n.n)',
        'MATCH (n:N) RETURN toInteger(n.l)',
        'MATCH (n:N) RETURN labels(n.l)',
        'MATCH (n:N) RETURN keys(n.n)',
        'MATCH (n:N) RETURN size(n.b)',
      ]) {
        expect(await error(query), query).toBeInstanceOf(CypherTypeError);
      }
      expect(await error('RETURN $m[$k]', { m: { a: 1n }, k: 0n })).toMatchObject({
        code: 'MapElementAccessByNonString',
      });
    });

    it('gives null, not an error, for null values and the ...OrNull functions', async () => {
      // `name` is missing on one node: null, and no error from the other.
      expect(
        await graph.query("MATCH (n:N {name: 'b'}) RETURN n.x + 1 AS a, -n.x AS b, n.x[0] AS c"),
      ).toEqual([{ a: null, b: null, c: null }]);
      expect(await v('toIntegerOrNull($x)', { x: [1n] })).toBe(null);
      expect(await v('toStringOrNull($x)', { x: { a: 1n } })).toBe(null);
      expect(await v('toBooleanOrNull($x)', { x: 1.5 })).toBe(null);
      expect(await v('[x IN $l | x]', { l: null })).toBe(null);
      // Comparing values of different types is not an error.
      expect(await v("$x = 'a'", { x: 1n })).toBe(false);
      expect(await v("$x < 'a'", { x: 1n })).toBe(null);
    });

    it('raises an argument error for integer overflow and division by zero', async () => {
      const max = 9223372036854775807n;
      for (const [expr, params] of [
        ['$x + 1', { x: max }],
        ['$x * 2', { x: max }],
        ['-$x - 2', { x: max }],
        ['$x / $y', { x: 1n, y: 0n }],
        ['$x % $y', { x: 1n, y: 0n }],
        ['range(1, 5, $s)', { s: 0n }],
      ] as const) {
        const e = await error(`RETURN ${expr} AS v`, params);
        expect(e, expr).toBeInstanceOf(CypherArgumentError);
      }
      expect((await error('RETURN 1 / $y AS v', { y: 0n })).message).toMatch(/Division by zero/);
      expect(await v('$x + 1', { x: max - 1n })).toBe(max);
      // Float division by zero is not an error.
      expect(await v('1.0 / 0')).toBe(Infinity);
    });

    it('does not raise for branches that are not taken', async () => {
      expect(await v('CASE WHEN false THEN $x + 1 ELSE 0 END', { x: 'a' })).toBe(0n);
      expect(
        await graph.query("MATCH (n:N) WHERE n.name = 'a' AND n.n + 1 = 2 RETURN n.name AS name"),
      ).toEqual([{ name: 'a' }]);
    });
  });
}
