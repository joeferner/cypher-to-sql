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
    expect(() => create(withTypes({ 'a"b': 'string' }))).toThrow(MappingError);
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
      ['age', '1.5'],
      ['age', '1e300'],
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

    it('stores an integral number as an integer for a property declared as integer (#63)', async () => {
      const graph = await setup();
      const ages = async (): Promise<CypherValue[]> =>
        (await graph.query('MATCH (n) RETURN n.age AS age, n.free AS free ORDER BY n.k')).map(
          (r) => [r['age']!, r['free']!],
        );
      // Every way of writing a property: CREATE with a value or a map parameter,
      // rows from UNWIND, MERGE, SET n.p, SET n += map, and SET n = map.
      await graph.query('CREATE ({k: 1, age: $a, free: $a})', { a: 30 });
      await graph.query('CREATE ($p)', { p: { k: 2, age: 31, free: 31 } });
      await graph.query('UNWIND $rows AS row CREATE ({k: row.k, age: row.age})', {
        rows: [{ k: 3, age: 32 }],
      });
      await graph.query('MERGE (n {k: 4, age: $a})', { a: 33 });
      await graph.query('CREATE ({k: 5, age: 30.0})');
      expect(await ages()).toEqual([
        [30n, 30], // an undeclared key keeps the float
        [31n, 31],
        [32n, null],
        [33n, null],
        [30n, null], // a Cypher float with an integral value
      ]);
      // MERGE finds the node by the converted value instead of creating another.
      await graph.query('MERGE (n {k: 4, age: $a}) SET n.age = $b', { a: 33, b: 40 });
      await graph.query('MATCH (n {k: 1}) SET n += $p', { p: { age: 41 } });
      await graph.query('MATCH (n {k: 2}) SET n = $p', { p: { k: 2, age: 42 } });
      expect(await ages()).toEqual([
        [41n, 30],
        [42n, null],
        [32n, null],
        [40n, null],
        [30n, null],
      ]);
      // A fraction, or an integral float beyond 2^53, is still rejected.
      for (const a of [30.5, 2 ** 53, -(2 ** 60)]) {
        await expect(graph.query('CREATE ({age: $a})', { a }), String(a)).rejects.toThrow(
          /declared as integer in the mapping, but the value is the float/,
        );
        await expect(graph.query('MATCH (n {k: 1}) SET n.age = $a', { a })).rejects.toThrow(
          SemanticError,
        );
      }
      // A declared float still takes no integer.
      await expect(graph.query('CREATE ({score: $s})', { s: 1n })).rejects.toThrow(
        /declared as float/,
      );
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
