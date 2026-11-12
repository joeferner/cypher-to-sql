import { afterAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  defaultMapping,
  MappingError,
  SemanticError,
  sqlite,
  type CypherValue,
  type Graph,
  type GraphMapping,
} from '../src/index.js';
import { testBackends } from './support/backends.js';
import { createSqliteDatabase, sqliteExecutor } from './support/sqlite.js';

const mapping: GraphMapping = {
  ...defaultMapping,
  nodes: {
    ...defaultMapping.nodes,
    propertyTypes: {
      name: 'string',
      age: 'integer',
      score: 'float',
      active: 'boolean',
      born: 'date',
      seen: 'datetime',
    },
  },
  edges: { ...defaultMapping.edges, propertyTypes: { weight: 'float' } },
};

describe('mapping validation', () => {
  const create = (m: GraphMapping): Graph =>
    createGraph({
      dialect: sqlite(),
      executor: sqliteExecutor(createSqliteDatabase()),
      mapping: m,
    });

  it('accepts declared property types', () => {
    expect(() => create(mapping)).not.toThrow();
  });

  it('rejects unknown types and empty keys', () => {
    const withTypes = (propertyTypes: unknown): GraphMapping => ({
      ...defaultMapping,
      nodes: { ...defaultMapping.nodes, propertyTypes } as GraphMapping['nodes'],
    });
    expect(() => create(withTypes({ age: 'int' }))).toThrow(MappingError);
    expect(() => create(withTypes({ '': 'string' }))).toThrow(MappingError);
    expect(() => create(withTypes(['string']))).toThrow(MappingError);
  });
});

for (const backend of testBackends()) {
  afterAll(() => backend.dispose?.());

  const setup = async (): Promise<Graph> => {
    const { dialect, executor } = await backend.open();
    return createGraph({ dialect, executor, mapping, readOnly: false });
  };

  const props = async (graph: Graph): Promise<CypherValue[]> =>
    (await graph.query('MATCH (n) RETURN n')).map(
      (r) => (r['n'] as { properties: CypherValue }).properties,
    );

  describe(`declared property types on ${backend.name}`, () => {
    it('accepts values of the declared types, nulls, and undeclared keys', async () => {
      const graph = await setup();
      await graph.query(
        `CREATE ({name: 'Ada', age: 36, score: 1.0, active: true, born: '1815-12-10',
                  seen: '2024-02-29T13:45:00.5+01:00', nick: null, other: [1, 'x']})`,
      );
      expect(await props(graph)).toEqual([
        {
          name: 'Ada',
          age: 36n,
          score: 1.0,
          active: true,
          born: '1815-12-10',
          seen: '2024-02-29T13:45:00.5+01:00',
          other: [1n, 'x'],
        },
      ]);
    });

    it.each([
      ['age', '1.0'],
      ['age', "'36'"],
      ['score', '1'],
      ['name', '1'],
      ['active', "'true'"],
      ['born', "'2023-02-29'"],
      ['born', "'1815-12-10T00:00:00Z'"],
      ['seen', "'2024-02-29T13:45:00'"],
      ['seen', "'2024-02-29T24:00:00Z'"],
      ['age', '[1, 2]'],
    ])('rejects %s: %s in a literal map, and rolls back the whole query', async (key, value) => {
      const graph = await setup();
      await expect(graph.query(`CREATE (), ({${key}: ${value}})`)).rejects.toThrow(SemanticError);
      expect(await props(graph)).toEqual([]);
    });

    it('checks parameter maps and values from rows', async () => {
      const graph = await setup();
      await expect(graph.query('CREATE ($p)', { p: { age: 1.5 } })).rejects.toThrow(
        /declared as integer/,
      );
      await expect(graph.query('UNWIND [1, 2.5] AS a CREATE ({age: a})')).rejects.toThrow(
        SemanticError,
      );
      expect(await props(graph)).toEqual([]);
      await graph.query('UNWIND [1, 2] AS a CREATE ({age: a})');
      expect(await props(graph)).toHaveLength(2);
    });

    it('checks relationship properties with the edge types', async () => {
      const graph = await setup();
      await expect(graph.query('CREATE ()-[:R {weight: 1}]->()')).rejects.toThrow(
        /declared as float/,
      );
      // `age` is declared for nodes only.
      await graph.query("CREATE ()-[:R {weight: 0.5, age: 'old'}]->()");
    });
  });
}
