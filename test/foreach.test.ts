import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createGraph, ReadOnlyViolationError, type Graph } from '../src/index.js';
import { testBackends } from './support/backends.js';

for (const backend of testBackends()) {
  describe(`FOREACH on ${backend.name}`, () => {
    let write: Graph;
    let read: Graph;

    beforeEach(async () => {
      const { dialect, executor } = await backend.open();
      write = createGraph({ dialect, executor, readOnly: false });
      read = createGraph({ dialect, executor });
    });
    afterAll(() => backend.dispose?.());

    const values = async (query: string): Promise<unknown[]> =>
      (await read.query(query)).map((r) => r['v']);

    it('creates once for each element', async () => {
      await write.query('FOREACH (x IN [1, 2, 3] | CREATE (:N {v: x * 10}))');
      expect(await values('MATCH (n:N) RETURN n.v AS v ORDER BY v')).toEqual([10n, 20n, 30n]);
    });

    it('runs for each row, and leaves the rows as they were', async () => {
      await write.query("CREATE (:P {name: 'a'}), (:P {name: 'b'})");
      const rows = await write.query(
        'MATCH (p:P) FOREACH (i IN range(1, 2) | CREATE (p)-[:HAS]->(:C {i: i})) RETURN p.name AS name ORDER BY name',
      );
      expect(rows).toEqual([{ name: 'a' }, { name: 'b' }]);
      expect(await values('MATCH (:P)-[:HAS]->(c:C) RETURN c.i AS v ORDER BY v')).toEqual([
        1n,
        1n,
        2n,
        2n,
      ]);
    });

    it('sets properties of nodes in a list, and nests', async () => {
      await write.query('CREATE (:N {k: 1}), (:N {k: 2})');
      await write.query(
        'MATCH (n:N) WITH collect(n) AS ns FOREACH (n IN ns | SET n.seen = true FOREACH (j IN [1] | SET n.j = j))',
      );
      expect(
        await read.query('MATCH (n:N) RETURN n.k AS k, n.seen AS s, n.j AS j ORDER BY k'),
      ).toEqual([
        { k: 1n, s: true, j: 1n },
        { k: 2n, s: true, j: 1n },
      ]);
    });

    it('does nothing for an empty or null list', async () => {
      await write.query('FOREACH (x IN [] | CREATE (:N))');
      await write.query('FOREACH (x IN null | CREATE (:N))');
      expect(await values('MATCH (n:N) RETURN count(n) AS v')).toEqual([0n]);
    });

    it('merges and deletes inside', async () => {
      await write.query('FOREACH (x IN [1, 1, 2] | MERGE (:N {k: x}))');
      expect(await values('MATCH (n:N) RETURN n.k AS v ORDER BY v')).toEqual([1n, 2n]);
      await write.query('MATCH (n:N) WITH collect(n) AS ns FOREACH (n IN ns | DELETE n)');
      expect(await values('MATCH (n:N) RETURN count(n) AS v')).toEqual([0n]);
    });

    it('is a write clause', async () => {
      await expect(read.query('FOREACH (x IN [1] | CREATE (:N))')).rejects.toThrow(
        ReadOnlyViolationError,
      );
    });
  });
}
