import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  CypherRelationship,
  SemanticError,
  UnsupportedFeatureError,
  type CypherValue,
  type Graph,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

/** Sorted `a-b` pairs of the string columns `a` and `b`, to compare row sets. */
function pairs(records: Record<string, CypherValue>[]): string[] {
  const name = (value: CypherValue | undefined): string => {
    if (typeof value !== 'string') {
      throw new Error(`Expected a string column, got ${typeof value}`);
    }
    return value;
  };
  return records.map((r) => `${name(r['a'])}-${name(r['b'])}`).sort();
}

for (const backend of testBackends()) {
  describe(`MATCH relationships on ${backend.name}`, () => {
    let read: Graph;

    // (x)-[:KNOWS {since: 2000}]->(y)-[:LIKES {score: 1.5}]->(z), and a self-loop on z.
    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      read = createGraph({ dialect, executor });
      await createGraph({ dialect, executor, readOnly: false }).query(
        `CREATE (x:P {name: 'x'})-[:KNOWS {since: 2000}]->(y:P {name: 'y'}),
                (y)-[:LIKES {score: 1.5}]->(z:Q {name: 'z'}),
                (z)-[:SELF]->(z)`,
      );
    });
    afterAll(() => backend.dispose?.());

    const q = async (cypher: string): Promise<string[]> => pairs(await read.query(cypher));

    it('follows each direction', async () => {
      expect(await q('MATCH (a)-[:KNOWS]->(b) RETURN a.name AS a, b.name AS b')).toEqual(['x-y']);
      expect(await q('MATCH (a)<-[:KNOWS]-(b) RETURN a.name AS a, b.name AS b')).toEqual(['y-x']);
    });

    it('matches an undirected relationship once per orientation, and a self-loop once', async () => {
      expect(await q('MATCH (a)-[:KNOWS]-(b) RETURN a.name AS a, b.name AS b')).toEqual([
        'x-y',
        'y-x',
      ]);
      expect(await q('MATCH (a)-[:SELF]-(b) RETURN a.name AS a, b.name AS b')).toEqual(['z-z']);
    });

    it('filters by any of several types', async () => {
      expect(await q('MATCH (a)-[:KNOWS|LIKES]->(b) RETURN a.name AS a, b.name AS b')).toEqual([
        'x-y',
        'y-z',
      ]);
    });

    it('chains relationships and keeps them distinct within one MATCH', async () => {
      expect(await q('MATCH (a)-->(m)-->(b) RETURN a.name AS a, b.name AS b')).toEqual([
        'x-z',
        'y-z',
      ]);
      // Without uniqueness the self-loop would match twice in a row.
      expect(await q("MATCH (a {name: 'z'})-->(m)-->(b) RETURN a.name AS a, b.name AS b")).toEqual(
        [],
      );
      // Across MATCH clauses the same relationship may match again.
      expect(
        await q("MATCH (a {name: 'z'})-->(m) MATCH (m)-->(b) RETURN a.name AS a, b.name AS b"),
      ).toEqual(['z-z']);
    });

    it('filters on node and relationship properties, comparing numbers by value', async () => {
      expect(
        await q('MATCH (a)-[:KNOWS {since: 2000.0}]->(b) RETURN a.name AS a, b.name AS b'),
      ).toEqual(['x-y']);
      expect(
        await q("MATCH (a {name: 'y'})-[{score: 1.5}]->(b) RETURN a.name AS a, b.name AS b"),
      ).toEqual(['y-z']);
      expect(await q("MATCH (a {name: 'Y'})-->(b) RETURN a.name AS a, b.name AS b")).toEqual([]);
      expect(await q('MATCH (a {name: null})-->(b) RETURN a.name AS a, b.name AS b')).toEqual([]);
      expect(
        await q("MATCH (a {name: 'x', missing: 1})-->(b) RETURN a.name AS a, b.name AS b"),
      ).toEqual([]);
      expect(await q("MATCH ()-[r {since: '2000'}]->() RETURN r.since AS a, r.since AS b")).toEqual(
        [],
      );
    });

    it('uses values bound earlier in the pattern', async () => {
      const records = await read.query(
        "UNWIND ['x', 'q'] AS n MATCH (a {name: n})-->(b) RETURN a.name AS a, b.name AS b",
      );
      expect(pairs(records)).toEqual(['x-y']);
    });

    it('returns relationships with their endpoints and properties', async () => {
      const [record] = await read.query('MATCH (a)-[r:LIKES]->(b) RETURN r, a, b, r.score AS s');
      const r = record!['r'] as CypherRelationship;
      expect(r).toBeInstanceOf(CypherRelationship);
      expect(r).toMatchObject({ type: 'LIKES', properties: { score: 1.5 } });
      expect(r.startNodeId).toBe((record!['a'] as { id: string }).id);
      expect(r.endNodeId).toBe((record!['b'] as { id: string }).id);
      expect(record!['s']).toBe(1.5);
    });

    it('reuses a relationship bound by an earlier MATCH', async () => {
      expect(
        await q('MATCH ()-[r:KNOWS]->() MATCH (a)-[r]-(b) RETURN a.name AS a, b.name AS b'),
      ).toEqual(['x-y', 'y-x']);
    });

    it('rejects invalid and unsupported patterns', () => {
      expect(() => read.compile('MATCH (a)-[r]->(b)-[r]->(c) RETURN r')).toThrow(SemanticError);
      expect(() => read.compile('MATCH (r)-->() MATCH ()-[r]->() RETURN r')).toThrow(SemanticError);
      expect(() => read.compile('MATCH ()-[r]->() MATCH (r) RETURN r')).toThrow(SemanticError);
      expect(() => read.compile('MATCH (a $props) RETURN a')).toThrow(SemanticError);
      expect(() => read.compile('MATCH (a)-[*1..2]->(b) RETURN a')).toThrow(
        UnsupportedFeatureError,
      );
    });
  });
}
