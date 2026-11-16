import { afterAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  CypherArgumentError,
  CypherConstraintError,
  CypherTemporal,
  CypherTypeError,
  defaultMapping,
  indexSql,
  ReadOnlyViolationError,
  type BulkNode,
  type BulkRelationship,
  type BulkWriteResult,
  type CypherValue,
  type Graph,
  type GraphMapping,
  type IdStrategy,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

const mapping: GraphMapping = {
  ...defaultMapping,
  nodes: {
    ...defaultMapping.nodes,
    propertyTypes: { doc: 'string', key: 'string', n: 'integer', w: 'float', born: 'date' },
    indexes: [{ keys: ['doc', 'key'] }],
  },
  edges: { ...defaultMapping.edges, propertyTypes: { since: 'integer' } },
};

/** The input: a duplicate key, a null that removes a key, declared types, ends matching 0, 1, or 2 nodes. */
const nodes: BulkNode[] = [
  { labels: ['Item'], properties: { doc: 'd1', key: 'a', name: 'A', w: 2, n: 30, gone: null } },
  { labels: ['Item'], properties: { doc: 'd1', key: 'b', name: 'B' } },
  { labels: ['Item', 'Extra'], properties: { doc: 'd1', key: 'a', name: null, extra: 'x' } },
  { labels: ['Item'], properties: { doc: 'd1', key: 'c', born: '2024-03-01', list: [1, 2] } },
  { labels: ['Note'], properties: { tag: 't', text: 'one' } },
  { labels: ['Note'], properties: { tag: 't', text: 'two' } },
];
const relationships: BulkRelationship[] = [
  {
    type: 'LINK',
    start: { label: 'Item', match: { doc: 'd1', key: 'a' } },
    end: { label: 'Item', match: { doc: 'd1', key: 'b' } },
    properties: { since: 2020, w: 0.5 },
  },
  {
    type: 'LINK',
    start: { label: 'Item', match: { doc: 'd1', key: 'a' } },
    end: { label: 'Item', match: { doc: 'd1', key: 'missing' } },
  },
  {
    type: 'ABOUT',
    start: { label: 'Item', match: { doc: 'd1', key: 'c' } },
    end: { label: 'Note', match: { tag: 't' } },
  },
];

/** Every node and relationship, in a form that does not depend on ids. */
async function snapshot(graph: Graph): Promise<CypherValue[]> {
  const nodeRows = await graph.query(
    'MATCH (n) RETURN labels(n) AS labels, properties(n) AS p ORDER BY toString(n.key), n.text',
  );
  const relRows = await graph.query(
    'MATCH (a)-[r]->(b) RETURN type(r) AS t, properties(r) AS p, coalesce(a.key, a.text) AS a, ' +
      'coalesce(b.key, b.text) AS b ORDER BY t, a, b',
  );
  return [
    ...nodeRows.map((r) => ({ ...r, labels: [...(r['labels'] as string[])].sort() })),
    ...relRows,
  ];
}

for (const backend of testBackends()) {
  describe(`bulkWrite and bulkDelete on ${backend.name}`, () => {
    afterAll(() => backend.dispose?.());

    const open = async (idStrategy?: IdStrategy): Promise<Graph> => {
      const { dialect, executor } = await backend.open();
      return createGraph({
        dialect,
        executor,
        mapping,
        readOnly: false,
        ...(idStrategy ? { idStrategy } : {}),
      });
    };

    it('stores what the equivalent Cypher stores', async () => {
      const existing = "CREATE (:Item {doc: 'd1', key: 'b', old: 1})";

      const bulk = await open();
      await bulk.query(existing);
      const result = await bulk.bulkWrite(
        { nodes, relationships },
        { nodeKey: { Item: ['doc', 'key'] } },
      );
      expect(result).toEqual({
        nodesCreated: 4, // a, c, and the two notes
        nodesUpdated: 1, // b
        relationshipsCreated: 3, // a->b, and c to both notes
        relationshipsSkipped: 1,
      });
      const viaBulk = await snapshot(bulk);

      const cypher = await open();
      await cypher.query(existing);
      for (const node of nodes) {
        const keyed = node.labels.includes('Item');
        await cypher.query(
          keyed
            ? `MERGE (n:Item {doc: $p.doc, key: $p.key}) SET n += $p ${node.labels
                .filter((l) => l !== 'Item')
                .map((l) => `SET n:${l}`)
                .join(' ')}`
            : `CREATE (n:${node.labels.join(':')}) SET n = $p`,
          { p: node.properties as CypherValue },
        );
      }
      for (const rel of relationships) {
        const match = (alias: string, end: BulkRelationship['start']): string =>
          `MATCH (${alias}:${end.label} {${Object.keys(end.match)
            .map((k) => `${k}: $${alias}.${k}`)
            .join(', ')}})`;
        await cypher.query(
          `${match('a', rel.start)} ${match('b', rel.end)} CREATE (a)-[r:${rel.type}]->(b) SET r = $p`,
          {
            a: rel.start.match as CypherValue,
            b: rel.end.match as CypherValue,
            p: (rel.properties ?? {}) as CypherValue,
          },
        );
      }
      expect(viaBulk).toEqual(await snapshot(cypher));
      // The values as stored: declared types, a null that removed a key, a date.
      expect(viaBulk[0]).toEqual({
        labels: ['Extra', 'Item'],
        p: { doc: 'd1', key: 'a', w: 2, n: 30n, extra: 'x' },
      });
      expect(viaBulk[2]).toMatchObject({ p: { born: new CypherTemporal('date', '2024-03-01') } });
    });

    it('replaces, ignores, or refuses an existing key, as asked', async () => {
      const graph = await open();
      const write = (
        onConflict: 'replace' | 'ignore' | 'error',
        properties: object,
      ): Promise<BulkWriteResult> =>
        graph.bulkWrite(
          { nodes: [{ labels: ['Item'], properties: { doc: 'd', key: 'k', ...properties } }] },
          { nodeKey: { Item: ['doc', 'key'] }, onConflict },
        );
      expect(await write('replace', { a: 1, b: 2 })).toMatchObject({ nodesCreated: 1 });
      expect(await write('replace', { b: 3 })).toMatchObject({ nodesUpdated: 1, nodesCreated: 0 });
      expect(await write('ignore', { c: 4 })).toMatchObject({ nodesUpdated: 0, nodesCreated: 0 });
      await expect(write('error', {})).rejects.toMatchObject({
        constructor: CypherConstraintError,
        code: 'ConstraintValidationFailed',
      });
      expect((await graph.query('MATCH (n:Item) RETURN properties(n) AS p'))[0]!['p']).toEqual({
        doc: 'd',
        key: 'k',
        b: 3,
      });
      // A duplicate key within one call is refused too, before anything is written.
      await expect(
        graph.bulkWrite(
          {
            nodes: [
              { labels: ['Item'], properties: { doc: 'd', key: 'x' } },
              { labels: ['Item'], properties: { doc: 'd', key: 'x' } },
            ],
          },
          { nodeKey: { Item: ['doc', 'key'] }, onConflict: 'error' },
        ),
      ).rejects.toThrow(/nodes\[1\] has the same Item key as nodes\[0\]/);
      expect(await graph.query('MATCH (n:Item) RETURN count(n) AS c')).toEqual([{ c: 1n }]);
    });

    it('refuses a relationship without an end when asked, and writes nothing', async () => {
      const graph = await open();
      await expect(
        graph.bulkWrite(
          { nodes: nodes.slice(0, 2), relationships: relationships.slice(0, 2) },
          { nodeKey: { Item: ['doc', 'key'] }, missingEndpoint: 'error' },
        ),
      ).rejects.toMatchObject({ constructor: CypherConstraintError, code: 'MissingEndpoint' });
      expect(await graph.query('MATCH (n) RETURN count(n) AS c')).toEqual([{ c: 0n }]);
    });

    it('takes ids from the generator, and works in chunks', async () => {
      let next = 1000;
      const graph = await open({ kind: 'generator', generate: () => next++ });
      const many: BulkNode[] = Array.from({ length: 25 }, (_, i) => ({
        labels: ['Item'],
        properties: { doc: 'd', key: `k${i}` },
      }));
      const links: BulkRelationship[] = Array.from({ length: 24 }, (_, i) => ({
        type: 'NEXT',
        start: { label: 'Item', match: { doc: 'd', key: `k${i}` } },
        end: { label: 'Item', match: { doc: 'd', key: `k${i + 1}` } },
      }));
      const result = await graph.bulkWrite(
        { nodes: many, relationships: links },
        { nodeKey: { Item: ['doc', 'key'] }, chunkSize: 7 },
      );
      expect(result).toEqual({
        nodesCreated: 25,
        nodesUpdated: 0,
        relationshipsCreated: 24,
        relationshipsSkipped: 0,
      });
      expect(await graph.query("MATCH (a {key: 'k0'}) RETURN id(a) AS a")).toEqual([{ a: 1000n }]);
      const pairs = await graph.query(
        'MATCH (a)-[:NEXT]->(b) RETURN a.key AS s, b.key AS e ORDER BY id(a)',
      );
      expect(pairs).toEqual(links.map((_, i) => ({ s: `k${i}`, e: `k${i + 1}` })));
      // Again: every node exists, nothing is created.
      expect(
        await graph.bulkWrite({ nodes: many }, { nodeKey: { Item: ['doc', 'key'] }, chunkSize: 7 }),
      ).toMatchObject({ nodesCreated: 0, nodesUpdated: 25 });
    });

    it('deletes what DETACH DELETE deletes', async () => {
      const setup =
        "CREATE (a:Item {doc: 'd1', key: 'a'})-[:R {doc: 'd1'}]->(b:Item {doc: 'd1', key: 'b'}), " +
        "(b)-[:R {doc: 'd2'}]->(:Item {doc: 'd2', key: 'c'})";
      const bulk = await open();
      await bulk.query(setup);
      await expect(
        bulk.bulkDelete({ nodes: { label: 'Item', match: { doc: 'd1' } } }),
      ).rejects.toMatchObject({
        constructor: CypherConstraintError,
        code: 'DeleteConnectedNode',
      });
      expect(
        await bulk.bulkDelete({ nodes: { label: 'Item', match: { doc: 'd1' } }, detach: true }),
      ).toEqual({ nodesDeleted: 2, relationshipsDeleted: 2 });
      const viaBulk = await snapshot(bulk);

      const cypher = await open();
      await cypher.query(setup);
      await cypher.query("MATCH (n:Item {doc: 'd1'}) DETACH DELETE n");
      expect(viaBulk).toEqual(await snapshot(cypher));

      // Relationships by type and properties.
      const again = await open();
      await again.query(setup);
      expect(
        await again.bulkDelete({ relationships: { type: 'R', match: { doc: 'd2' } } }),
      ).toEqual({ nodesDeleted: 0, relationshipsDeleted: 1 });
      expect(await again.query('MATCH ()-[r]->() RETURN r.doc AS d')).toEqual([{ d: 'd1' }]);
    });

    it('reports a unique index violation as a constraint error, and writes nothing', async () => {
      const { dialect, executor } = await backend.open();
      const unique: GraphMapping = {
        ...mapping,
        nodes: { ...mapping.nodes, indexes: [{ keys: ['n'], unique: true }] },
      };
      const index = indexSql(dialect, unique, 'nodes', ['n'], { unique: true })!;
      await executor.transaction('write', (tx) => tx.query(index, []));
      const graph = createGraph({ dialect, executor, mapping: unique, readOnly: false });
      await expect(
        graph.bulkWrite({
          nodes: [
            { labels: ['Item'], properties: { n: 1n } },
            { labels: ['Item'], properties: { n: 1n } },
          ],
        }),
      ).rejects.toMatchObject({
        constructor: CypherConstraintError,
        code: 'ConstraintValidationFailed',
      });
      expect(await graph.query('MATCH (n) RETURN count(n) AS c')).toEqual([{ c: 0n }]);
    });

    it('checks its input and the graph', async () => {
      const graph = await open();
      await expect(
        graph.bulkWrite({ nodes: [{ labels: ['Item'], properties: { when: new Date() } }] }),
      ).rejects.toThrow(CypherTypeError);
      const declaredError = graph.bulkWrite({
        nodes: [{ labels: ['Item'], properties: { n: 'x' } }],
      });
      await expect(declaredError).rejects.toThrow(CypherTypeError);
      await expect(declaredError).rejects.toThrow(/^nodes\[0\]\.properties: .*declared as integer/);
      await expect(
        graph.bulkWrite({ nodes: [] }, { nodeKey: { Item: ['undeclared'] } }),
      ).rejects.toThrow(CypherArgumentError);
      await expect(
        graph.bulkWrite(
          { nodes: [{ labels: ['Item'], properties: { doc: 'd' } }] },
          { nodeKey: { Item: ['doc', 'key'] } },
        ),
      ).rejects.toThrow(/has no value for Item's key "key"/);
      const { dialect, executor } = await backend.open();
      const read = createGraph({ dialect, executor, mapping });
      await expect(read.bulkWrite({ nodes: [] })).rejects.toThrow(ReadOnlyViolationError);
      await expect(read.bulkDelete({})).rejects.toThrow(ReadOnlyViolationError);
    });
  });
}
