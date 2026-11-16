import { afterAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  CypherTemporal,
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
          // Declared dates and date-times are temporal values (#65).
          born: new CypherTemporal('date', '1815-12-10'),
          seen: new CypherTemporal('datetime', '2024-02-29T13:45:00.500+01:00'),
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

    it('reads a declared date or datetime as a temporal value that compares as one (#65)', async () => {
      const graph = await setup();
      const date = (text: string): CypherTemporal => new CypherTemporal('date', text);
      // From ISO text or from a temporal value, in CREATE, SET, and SET +=.
      await graph.query(
        "CREATE ({k: 1, born: '2024-03-01', seen: '2024-02-29T13:45:00.5+01:00'}), " +
          "({k: 2, born: date('2023-01-01'), seen: datetime('2024-02-29T12:00Z')}), ({k: 3})",
      );
      await graph.query('MATCH (n {k: 3}) SET n.born = $b SET n += $p', {
        b: '2022-06-30',
        p: { seen: new CypherTemporal('datetime', '2024-02-29T12:40Z') },
      });
      const keys = async (where: string, params = {}): Promise<CypherValue[]> =>
        (await graph.query(`MATCH (n) WHERE ${where} RETURN n.k AS k ORDER BY k`, params)).map(
          (r) => r['k']!,
        );
      // Comparisons with a literal date, a date parameter, or one from the query.
      expect(await keys("n.born > date('2023-06-01')")).toEqual([1n]);
      expect(await keys("date('2023-06-01') > n.born")).toEqual([2n, 3n]);
      expect(await keys('n.born >= $d', { d: date('2023-01-01') })).toEqual([1n, 2n]);
      expect(await keys('n.born = $d', { d: date('2023-01-01') })).toEqual([2n]);
      expect(await keys('n.born < date({year: 2023, month: 1, day: 2})')).toEqual([2n, 3n]);
      expect(await keys("n.born IN [date('2022-06-30')]")).toEqual([3n]);
      // Datetimes by instant: 13:45+01:00 is 12:45Z.
      expect(await keys("n.seen < datetime('2024-02-29T12:41Z')")).toEqual([2n, 3n]);
      expect(await keys("n.seen = datetime('2024-02-29T12:00Z')")).toEqual([2n]);
      // As in Cypher, a string is not a date: = is false and an ordering is null.
      expect(await keys("n.born = '2024-03-01'")).toEqual([]);
      expect(await keys('n.born > $s', { s: '2000-01-01' })).toEqual([]);
      // Returned as temporal values, with components, sorted by date.
      expect(
        await graph.query(
          'MATCH (n) WHERE n.born IS NOT NULL RETURN n.born AS b, n.born.year AS y, n.seen AS s ORDER BY n.born',
        ),
      ).toEqual([
        { b: date('2022-06-30'), y: 2022n, s: new CypherTemporal('datetime', '2024-02-29T12:40Z') },
        { b: date('2023-01-01'), y: 2023n, s: new CypherTemporal('datetime', '2024-02-29T12:00Z') },
        {
          b: date('2024-03-01'),
          y: 2024n,
          s: new CypherTemporal('datetime', '2024-02-29T13:45:00.500+01:00'),
        },
      ]);
      expect((await props(graph))[0]).toMatchObject({ born: date('2024-03-01') });
      // A temporal value of the other kind, or a duration, is still rejected.
      await expect(graph.query("CREATE ({born: datetime('2024-03-01T00:00Z')})")).rejects.toThrow(
        /declared as date in the mapping, but the value is the datetime/,
      );
      // MERGE matches a date only with a date: with a string it would create a
      // node on every run, so it is an error.
      await expect(graph.query("MERGE ({k: 4, born: '2024-03-01'})")).rejects.toThrow(
        /MERGE matches the date property "born" only with a date/,
      );
      await graph.query("MERGE ({k: 4, born: date('2024-03-01')})");
      await graph.query("MERGE ({k: 4, born: date('2024-03-01')})");
      expect(await keys('n.k = 4')).toEqual([4n]);
    });

    it('serves a declared date compared with a known date by its sort key, which an index can match', () => {
      const sql = createGraph({
        dialect: sqlite(),
        executor: sqliteExecutor(createSqliteDatabase()),
        mapping,
      })
        .compile("MATCH (n) WHERE n.born > date('2024-01-01') RETURN n")
        .explain();
      // The expression of the index in docs/schema.md.
      expect(sql).toContain(`((n0."properties" -> '$."born"') ->> '$."~k"') > ?`);
    });

    it('compares a declared property with a value from the row as Cypher does, by its index (#77)', async () => {
      const graph = await setup();
      await graph.query("CREATE ({k: 1, age: 30, name: 'a', active: true}), ({k: 2})");
      // = on each row value: true, false, or null, as in Cypher, in RETURN and in WHERE.
      const rows = [
        { x: 30n },
        { x: 30.0 },
        { x: 30.5 },
        { x: 31n },
        { x: '30' },
        { x: null },
        {},
        { x: [30n] },
        { x: 1e300 },
      ];
      const ageEquals = async (): Promise<CypherValue[]> =>
        (
          await graph.query(
            'UNWIND $rows AS row MATCH (n {k: 1}) RETURN n.age = row.x AS eq, (n.age = row.x) IS NULL AS unknown',
            { rows },
          )
        ).map((r) => (r['unknown'] ? null : r['eq']!));
      expect(await ageEquals()).toEqual([
        true,
        true,
        false,
        false,
        false,
        null,
        null,
        false,
        false,
      ]);
      // A missing property is null whatever it is compared with.
      expect(
        (
          await graph.query('UNWIND $rows AS row MATCH (n {k: 2}) RETURN n.age = row.x AS eq', {
            rows: [{ x: 30n }, { x: 'a' }],
          })
        ).map((r) => r['eq']),
      ).toEqual([null, null]);
      // Strings and booleans.
      expect(
        (
          await graph.query(
            'UNWIND $rows AS row MATCH (n {k: 1}) RETURN n.name = row.s AS s, n.active = row.b AS b',
            {
              rows: [
                { s: 'a', b: true },
                { s: 'A', b: false },
                { s: 1n, b: 'true' },
              ],
            },
          )
        ).map((r) => [r['s'], r['b']]),
      ).toEqual([
        [true, true],
        [false, false],
        [false, false],
      ]);
      // In a pattern: MATCH and MERGE by a row value find the node.
      expect(
        await graph.query(
          'UNWIND $rows AS row MATCH (n {age: row.age}) RETURN n.k AS k, row.age AS age',
          { rows: [{ age: 30n }, { age: 30.0 }, { age: 99n }] },
        ),
      ).toEqual([
        { k: 1n, age: 30n },
        { k: 1n, age: 30.0 },
      ]);
      await graph.query("UNWIND $rows AS row MERGE (n {age: row.age}) SET n.name = 'merged'", {
        rows: [{ age: 30n }, { age: 40n }],
      });
      expect(
        await graph.query(
          'MATCH (n) WHERE n.age IS NOT NULL RETURN n.age AS age, n.name AS name ORDER BY age',
        ),
      ).toEqual([
        { age: 30n, name: 'merged' },
        { age: 40n, name: 'merged' },
      ]);
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
