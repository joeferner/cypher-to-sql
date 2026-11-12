import { describe, expect, it } from 'vitest';
import {
  createGraph,
  defaultMapping,
  MappingError,
  postgres,
  sqlite,
  type GraphMapping,
  type SqlExecutor,
} from '../src/index.js';

const executor: SqlExecutor = {
  transaction: () => Promise.reject(new Error('compile only')),
};

const withNodes = (nodes: Partial<GraphMapping['nodes']>): GraphMapping => ({
  ...defaultMapping,
  nodes: { ...defaultMapping.nodes, ...nodes },
});

describe('mapping validation', () => {
  it('accepts the default mapping and custom names', () => {
    expect(() => createGraph({ dialect: sqlite(), executor })).not.toThrow();
    expect(() =>
      createGraph({
        dialect: sqlite(),
        executor,
        mapping: { ...withNodes({ table: 'Graph_Nodes_2' }), schema: 'g' },
      }),
    ).not.toThrow();
  });

  it.each([
    ['nodes; DROP TABLE nodes', 'nodes.table'],
    ['"nodes"', 'nodes.table'],
    ['2nodes', 'nodes.table'],
    ['', 'nodes.table'],
    ['my nodes', 'nodes.table'],
  ])('rejects the identifier %j', (table, path) => {
    expect(() =>
      createGraph({ dialect: sqlite(), executor, mapping: withNodes({ table }) }),
    ).toThrow(new RegExp(`Mapping value ${path} must be a SQL identifier`));
  });

  it('checks every column, the edge table, and the schema', () => {
    const bad = 'a-b';
    const cases: GraphMapping[] = [
      withNodes({ id: bad }),
      withNodes({ labels: bad }),
      withNodes({ properties: bad }),
      { ...defaultMapping, edges: { ...defaultMapping.edges, startId: bad } },
      { ...defaultMapping, edges: { ...defaultMapping.edges, type: bad } },
      { ...defaultMapping, schema: bad },
      withNodes({ id: 42 as unknown as string }),
    ];
    for (const mapping of cases) {
      expect(() => createGraph({ dialect: sqlite(), executor, mapping })).toThrow(MappingError);
    }
  });
});

describe('mapping in emitted SQL', () => {
  const mapping: GraphMapping = {
    schema: 'g',
    nodes: { table: 'vertex', id: 'vid', labels: 'tags', properties: 'attrs' },
    edges: {
      table: 'arc',
      id: 'aid',
      startId: 'src',
      endId: 'dst',
      type: 'kind',
      properties: 'attrs',
    },
  };

  it.each([sqlite(), postgres()])('uses only mapped names on $name', (dialect) => {
    const read = createGraph({ dialect, executor, mapping });
    const write = createGraph({ dialect, executor, mapping, readOnly: false });
    const sql = [
      ...read.compile('MATCH (n:A) RETURN n, n.k').steps,
      ...write.compile('MATCH (a) CREATE (a)-[:T {k: 1}]->(:B)').steps,
    ]
      .map((s) => s.sql)
      .join('\n');
    expect(sql).toContain('"g"."vertex"');
    expect(sql).toContain('"g"."arc"');
    for (const column of ['"vid"', '"tags"', '"attrs"', '"src"', '"dst"', '"kind"', '"aid"']) {
      expect(sql).toContain(column);
    }
    for (const defaultName of ['"nodes"', '"edges"', '"labels"', '"properties"', '"start_id"']) {
      expect(sql).not.toContain(defaultName);
    }
  });
});
