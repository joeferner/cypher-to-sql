import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createGraph,
  CypherTypeError,
  SemanticError,
  UnsupportedFeatureError,
  type Graph,
  type Procedures,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

const calls: Record<string, unknown>[] = [];

const procedures: Procedures = {
  'geo.city': {
    inputs: [
      { name: 'name', type: 'STRING' },
      { name: 'scale', type: 'FLOAT' },
    ],
    outputs: [
      { name: 'city', type: 'STRING' },
      { name: 'size', type: 'FLOAT' },
    ],
    call: (args) => {
      calls.push(args);
      const name = args['name'] as string;
      return name === 'none'
        ? []
        : [{ city: `${name} North`, size: Number(args['scale']) * 2 }, { city: `${name} South` }];
    },
  },
  'util.nothing': { inputs: [], outputs: [], call: () => [] },
};

for (const backend of testBackends()) {
  describe(`CALL on ${backend.name}`, () => {
    /** Read-only: CALL needs no write mode. */
    let read: Graph;

    beforeEach(async () => {
      const { dialect, executor } = await backend.open();
      await createGraph({ dialect, executor, readOnly: false }).query(
        "CREATE (:P {name: 'a'}), (:P {name: 'b'})",
      );
      read = createGraph({ dialect, executor, procedures });
      calls.length = 0;
    });
    afterAll(() => backend.dispose?.());

    it('returns every output of a standalone call, in order, with missing outputs null', async () => {
      expect(read.compile("CALL geo.city('X', 1)").columns.map((c) => c.name)).toEqual([
        'city',
        'size',
      ]);
      expect(await read.query("CALL geo.city('X', 1)")).toEqual([
        { city: 'X North', size: 2 },
        { city: 'X South', size: null },
      ]);
      // The integer argument of a FLOAT input arrives as a float.
      expect(calls).toEqual([{ name: 'X', scale: 1 }]);
    });

    it('takes implicit arguments from parameters', async () => {
      expect(await read.query('CALL geo.city', { name: 'Y', scale: 0.5 })).toEqual([
        { city: 'Y North', size: 1 },
        { city: 'Y South', size: null },
      ]);
    });

    it('joins the rows with each row of the query, renames, and filters', async () => {
      const rows = await read.query(
        "MATCH (p:P) CALL geo.city($n, 1) YIELD city AS c WHERE c ENDS WITH 'North' RETURN p.name AS p, c ORDER BY p",
        { n: 'Z' },
      );
      expect(rows).toEqual([
        { p: 'a', c: 'Z North' },
        { p: 'b', c: 'Z North' },
      ]);
    });

    it('leaves the rows as they are for a void procedure, and removes them for no rows', async () => {
      expect(
        await read.query('MATCH (p:P) CALL util.nothing() RETURN p.name AS p ORDER BY p'),
      ).toEqual([{ p: 'a' }, { p: 'b' }]);
      expect(read.compile('CALL util.nothing()').columns).toEqual([]);
      expect(await read.query('CALL util.nothing()')).toEqual([]);
      expect(await read.query("MATCH (p:P) CALL geo.city('none', 1) YIELD city RETURN p")).toEqual(
        [],
      );
    });

    it('rejects unknown procedures, wrong arguments, and bound variables when compiling', () => {
      for (const query of [
        'CALL no.such()',
        "CALL geo.city('X')",
        'CALL geo.city(1, 1)',
        "CALL geo.city('X', 1) YIELD nope RETURN nope",
        "WITH 1 AS city CALL geo.city('X', 1) YIELD city RETURN city",
        "CALL geo.city('X', 1) YIELD city AS c, size AS c RETURN c",
        "MATCH (p) CALL geo.city('X', count(p)) YIELD city RETURN city",
      ]) {
        expect(() => read.compile(query), query).toThrow(SemanticError);
      }
    });

    it('checks parameter arguments when the query runs', async () => {
      await expect(read.query('CALL geo.city($n, 1)', { n: 5n })).rejects.toThrow(CypherTypeError);
      await expect(read.query('CALL geo.city', { name: 'X' })).rejects.toThrow(SemanticError);
    });

    it('does not support arguments from the rows yet', () => {
      expect(() =>
        read.compile('MATCH (p:P) CALL geo.city(p.name, 1) YIELD city RETURN city'),
      ).toThrow(UnsupportedFeatureError);
    });
  });
}
