import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createGraph,
  CypherConstraintError,
  CypherTypeError,
  ReadOnlyViolationError,
  SemanticError,
  type Graph,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

for (const backend of testBackends()) {
  describe(`DELETE on ${backend.name}`, () => {
    let write: Graph;
    let read: Graph;

    // a -R-> b -R-> c, and d alone.
    beforeEach(async () => {
      const { dialect, executor } = await backend.open();
      write = createGraph({ dialect, executor, readOnly: false });
      read = createGraph({ dialect, executor });
      await write.query(
        "CREATE (a:N {n: 'a'})-[:R {w: 1}]->(b:N {n: 'b'})-[:R {w: 2}]->(:N {n: 'c'}), (:N {n: 'd'})",
      );
    });
    afterAll(() => backend.dispose?.());

    const names = async (): Promise<unknown[]> =>
      (await read.query('MATCH (n) RETURN n.n AS n ORDER BY n')).map((r) => r['n']);
    const count = async (): Promise<unknown> =>
      (await read.query('MATCH ()-[r]->() RETURN count(r) AS c'))[0]!['c'];

    it('deletes nodes without relationships, and relationships', async () => {
      await write.query("MATCH (n {n: 'd'}) DELETE n");
      expect(await names()).toEqual(['a', 'b', 'c']);
      await write.query('MATCH ()-[r {w: 1}]->() DELETE r');
      expect(await count()).toBe(1n);
    });

    it('fails to delete a node that still has relationships, unless DETACH', async () => {
      await expect(write.query("MATCH (n {n: 'b'}) DELETE n")).rejects.toThrow(
        CypherConstraintError,
      );
      expect(await names()).toEqual(['a', 'b', 'c', 'd']);
      await write.query("MATCH (n {n: 'b'}) DETACH DELETE n");
      expect(await names()).toEqual(['a', 'c', 'd']);
      expect(await count()).toBe(0n);
    });

    it('checks relationships after every row, so a node and its relationships can go together', async () => {
      await write.query("MATCH (n {n: 'b'})-[r]-() DELETE n, r");
      expect(await names()).toEqual(['a', 'c', 'd']);
    });

    it('deletes paths, values from lists and maps, and ignores null', async () => {
      await write.query("MATCH p = ({n: 'a'})-[*]->({n: 'c'}) DELETE p");
      expect(await names()).toEqual(['d']);
      await write.query('CREATE (:M {k: 1}), (:M {k: 2})');
      await write.query('MATCH (m:M) WITH collect(m) AS ms DELETE ms[0]');
      expect((await read.query('MATCH (m:M) RETURN count(m) AS c'))[0]!['c']).toBe(1n);
      await write.query('MATCH (m:M) WITH {key: m} AS map DELETE map.key');
      await write.query('OPTIONAL MATCH (x:Nope) DELETE x');
      expect(await names()).toEqual(['d']);
    });

    it('runs with CREATE and RETURN in the same query', async () => {
      expect(await write.query("MATCH (n {n: 'd'}) CREATE (x:T) DELETE n RETURN 42 AS v")).toEqual([
        { v: 42n },
      ]);
      expect(await names()).toEqual(['a', 'b', 'c', null]);
    });

    it('raises EntityNotFound for the properties and labels of deleted entities', async () => {
      for (const query of [
        "MATCH (n {n: 'd'}) DELETE n RETURN n.n AS v",
        "MATCH (n {n: 'd'}) DELETE n RETURN labels(n) AS v",
        "MATCH (n {n: 'd'}) DELETE n RETURN n:N AS v",
        "MATCH (n {n: 'd'}) DELETE n RETURN properties(n) AS v",
        "MATCH (n {n: 'd'}) DELETE n RETURN n['n'] AS v",
        'MATCH ()-[r {w: 1}]->() DELETE r RETURN r.w AS v',
      ]) {
        await expect(write.query(query), query).rejects.toMatchObject({
          name: 'EntityNotFoundError',
          code: 'DeletedEntityAccess',
        });
      }
      // Nothing is deleted: the error rolls the query back.
      expect(await names()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('still gives the type and id of deleted entities, and reads the others', async () => {
      const [row] = await write.query(
        "MATCH (a {n: 'a'})-[r]->(b) DELETE r RETURN type(r) AS t, id(r) IS NOT NULL AS hasId, b.n AS b",
      );
      expect(row).toEqual({ t: 'R', hasId: true, b: 'b' });
      // A variable that was not deleted, and a null one, read as before.
      expect(
        await write.query(
          "MATCH (n {n: 'd'}) OPTIONAL MATCH (n)-[x]->() DELETE x RETURN n.n AS n, x IS NULL AS none",
        ),
      ).toEqual([{ n: 'd', none: true }]);
    });

    it('rejects values that are not entities, and read-only graphs', async () => {
      expect(() => write.compile('MATCH (n) DELETE n:N')).toThrow(SemanticError);
      expect(() => write.compile('MATCH (n) DELETE 1 + 1')).toThrow(SemanticError);
      await expect(write.query("MATCH (n {n: 'a'}) DELETE n.n")).rejects.toThrow(CypherTypeError);
      expect(() => read.compile('MATCH (n) DETACH DELETE n')).toThrow(ReadOnlyViolationError);
      expect(write.compile('MATCH (n) DELETE n').readOnly).toBe(false);
    });
  });
}
