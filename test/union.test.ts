import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGraph, ReadOnlyViolationError, SemanticError, type Graph } from '../src/index.js';
import { testBackends } from './support/backends.js';

for (const backend of testBackends()) {
  describe(`UNION on ${backend.name}`, () => {
    let read: Graph;
    let write: Graph;

    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      write = createGraph({ dialect, executor, readOnly: false });
      read = createGraph({ dialect, executor });
      await write.query("CREATE (:A {n: 'a'})-[:R]->(:B {n: 'b'})");
    });
    afterAll(() => backend.dispose?.());

    it('keeps every record with UNION ALL, in query order', async () => {
      expect(
        await read.query('UNWIND [1, 2, 1] AS x RETURN x UNION ALL UNWIND [2, 3] AS x RETURN x'),
      ).toEqual([{ x: 1n }, { x: 2n }, { x: 1n }, { x: 2n }, { x: 3n }]);
    });

    it('removes equivalent records with UNION, as DISTINCT compares them', async () => {
      expect(await read.query('UNWIND [1, 2, 1] AS x RETURN x UNION RETURN 2.0 AS x')).toEqual([
        { x: 1n },
        { x: 2n },
      ]);
      // Nodes by id, lists and maps by their elements, null as null.
      expect(
        await read.query(
          'MATCH (a:A) RETURN a AS v UNION MATCH (a)-[:R]->() RETURN a AS v UNION RETURN [1, {k: null}] AS v UNION RETURN [1.0, {k: null}] AS v UNION RETURN null AS v UNION RETURN null AS v',
        ),
      ).toHaveLength(3);
    });

    it('takes the columns of the first query, whatever the order of the others', async () => {
      expect(
        read
          .compile('RETURN 1 AS a, 2 AS b UNION RETURN 3 AS b, 4 AS a')
          .columns.map((c) => c.name),
      ).toEqual(['a', 'b']);
      const records = await read.query('RETURN 1 AS a, 2 AS b UNION RETURN 3 AS b, 4 AS a');
      expect(records).toEqual([
        { a: 1n, b: 2n },
        { a: 4n, b: 3n },
      ]);
      expect(Object.keys(records[1]!)).toEqual(['a', 'b']);
    });

    it('passes parameters to every query, and explains each', async () => {
      expect(await read.query('RETURN $x AS v UNION ALL RETURN $x + 1 AS v', { x: 1n })).toEqual([
        { v: 1n },
        { v: 2n },
      ]);
      expect(read.compile('RETURN 1 AS v UNION RETURN 2 AS v').explain()).toContain(
        '-- query 2 of UNION',
      );
    });

    it('rejects different columns and mixing UNION with UNION ALL', () => {
      expect(() => read.compile('RETURN 1 AS a UNION RETURN 2 AS b')).toThrow(SemanticError);
      expect(() => read.compile('RETURN 1 AS a UNION ALL RETURN 1 AS a, 2 AS b')).toThrow(
        SemanticError,
      );
      expect(() =>
        read.compile('RETURN 1 AS a UNION RETURN 2 AS a UNION ALL RETURN 3 AS a'),
      ).toThrow(/cannot be mixed/);
    });

    it('rejects a write clause in any query on a read-only graph', () => {
      expect(() => read.compile('RETURN 1 AS a UNION CREATE (n) RETURN 2 AS a')).toThrow(
        ReadOnlyViolationError,
      );
      expect(read.compile('RETURN 1 AS a UNION RETURN 2 AS a').readOnly).toBe(true);
      expect(write.compile('RETURN 1 AS a UNION CREATE (n) RETURN 2 AS a').readOnly).toBe(false);
    });
  });
}
