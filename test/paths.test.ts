import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  CypherNode,
  CypherPath,
  CypherRelationship,
  SemanticError,
  type CypherValue,
  type Graph,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

/** A path as names: `a-R->b-R->c` style, for compact assertions. */
function describePath(value: CypherValue): string {
  if (!(value instanceof CypherPath)) {
    throw new Error('expected a path');
  }
  const name = (node: CypherNode): string => node.properties['n'] as string;
  const parts = [name(value.nodes[0]!)];
  value.relationships.forEach((r, i) => {
    const next = value.nodes[i + 1]!;
    const forward = r.endNodeId === next.id;
    parts.push(forward ? `-${r.type}->` : `<-${r.type}-`, name(next));
  });
  return parts.join('');
}

for (const backend of testBackends()) {
  describe(`named paths and entity values on ${backend.name}`, () => {
    let graph: Graph;

    // a -R-> b -R-> c, and d -S-> b.
    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      graph = createGraph({ dialect, executor });
      await createGraph({ dialect, executor, readOnly: false }).query(
        `CREATE (a:N {n: 'a'})-[:R {w: 1}]->(b:N:M {n: 'b'})-[:R {w: 2}]->(:N {n: 'c'}),
                (:N {n: 'd'})-[:S]->(b)`,
      );
    });
    afterAll(() => backend.dispose?.());

    const paths = async (cypher: string): Promise<string[]> =>
      (await graph.query(cypher)).map((row) => describePath(row['p']!)).sort();

    it('returns fixed-length paths', async () => {
      expect(await paths(`MATCH p = ({n: 'a'})-->() RETURN p`)).toEqual(['a-R->b']);
      expect(await paths(`MATCH p = ({n: 'a'})-->()-->() RETURN p`)).toEqual(['a-R->b-R->c']);
      expect(await paths(`MATCH p = ({n: 'b'})-[:S]-() RETURN p`)).toEqual(['b<-S-d']);
      expect(await paths(`MATCH p = ({n: 'c'}) RETURN p`)).toEqual(['c']);
    });

    it('returns variable-length paths with their nodes', async () => {
      expect(await paths(`MATCH p = ({n: 'a'})-[*]->() RETURN p`)).toEqual([
        'a-R->b',
        'a-R->b-R->c',
      ]);
      expect(await paths(`MATCH p = ({n: 'c'})-[*0..]-({n: 'd'}) RETURN p`)).toEqual([
        'c<-R-b<-S-d',
      ]);
      expect(await paths(`MATCH p = ({n: 'a'})-[*0]->() RETURN p`)).toEqual(['a']);
      expect(await paths(`MATCH p = (:N {n: 'd'})-[:S]->()-[:R*1..]->() RETURN p`)).toEqual([
        'd-S->b-R->c',
      ]);
    });

    it('gives the path functions', async () => {
      const [row] = await graph.query(
        `MATCH p = ({n: 'a'})-[*2]->()
         RETURN length(p) AS len, nodes(p) AS nodes, relationships(p) AS rels`,
      );
      expect(row!['len']).toBe(2n);
      const nodes = row!['nodes'] as CypherNode[];
      expect(nodes.map((n) => n.properties['n'])).toEqual(['a', 'b', 'c']);
      expect(nodes[1]).toBeInstanceOf(CypherNode);
      expect(nodes[1]!.labels.sort()).toEqual(['M', 'N']);
      const rels = row!['rels'] as CypherRelationship[];
      expect(rels.map((r) => r.properties['w'])).toEqual([1n, 2n]);
      expect(rels[0]).toBeInstanceOf(CypherRelationship);
    });

    it('uses entities held in lists like entities', async () => {
      const [row] = await graph.query(
        `MATCH p = ({n: 'a'})-[*2]->()
         WITH nodes(p) AS ns, relationships(p) AS rs
         RETURN last(ns).n AS lastName, head(rs).w AS firstWeight, type(last(rs)) AS t,
                labels(head(tail(ns))) AS l, head(tail(ns)):M AS isM, id(head(ns)) IS NULL AS noId,
                keys(head(rs)) AS k, properties(last(ns)) AS props, size(ns) AS size`,
      );
      expect(row).toEqual({
        lastName: 'c',
        firstWeight: 1n,
        t: 'R',
        l: expect.arrayContaining(['M', 'N']) as unknown,
        isM: true,
        noId: false,
        k: ['w'],
        props: { n: 'c' },
        size: 3n,
      });
    });

    it('collects entities and compares them', async () => {
      const [row] = await graph.query(
        `MATCH (x:N)-[r:R]->() RETURN collect(x) AS xs, collect(r) AS rs`,
      );
      const xs = row!['xs'] as CypherNode[];
      expect(xs.every((x) => x instanceof CypherNode)).toBe(true);
      expect(xs.map((x) => x.properties['n']).sort()).toEqual(['a', 'b']);
      expect((row!['rs'] as unknown[]).every((r) => r instanceof CypherRelationship)).toBe(true);
      expect(
        await graph.query(
          `MATCH p = (a {n: 'a'})-->(b) RETURN head(nodes(p)) = a AS same, a IN nodes(p) AS inside,
                  b = head(nodes(p)) AS other, [a, b] AS pair`,
        ),
      ).toEqual([
        {
          same: true,
          inside: true,
          other: false,
          pair: [expect.any(CypherNode), expect.any(CypherNode)] as unknown,
        },
      ]);
    });

    it('is null after OPTIONAL MATCH without a match, and carried by WITH', async () => {
      expect(
        await graph.query(
          `MATCH (c {n: 'c'}) OPTIONAL MATCH p = (c)-->() RETURN p, length(p) AS l`,
        ),
      ).toEqual([{ p: null, l: null }]);
      expect(await paths(`MATCH p = ({n: 'a'})-->() WITH p WHERE length(p) = 1 RETURN p`)).toEqual([
        'a-R->b',
      ]);
    });

    it('rejects reserved keys and redeclared path variables', async () => {
      await expect(graph.query("RETURN {`~cypher`: 'node'} AS m")).rejects.toThrow(SemanticError);
      await expect(graph.query('RETURN $m AS m', { m: { '~cypher': 'node' } })).rejects.toThrow(
        SemanticError,
      );
      await expect(graph.query('MATCH p = (a) MATCH p = (b) RETURN p')).rejects.toThrow(
        SemanticError,
      );
    });
  });
}
