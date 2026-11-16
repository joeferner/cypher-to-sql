import { afterAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  CypherConstraintError,
  CypherTemporal,
  defaultMapping,
  indexSql,
  MappingError,
  migrate,
  mysql,
  postgres,
  propertyIndexSql,
  SCHEMA_VERSION,
  SchemaError,
  schemaSql,
  sqlite,
  type GraphMapping,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

/** A mapping with a prefix and declared properties of every type. */
const graphMapping = (prefix: string): GraphMapping => ({
  ...defaultMapping,
  prefix,
  nodes: {
    ...defaultMapping.nodes,
    propertyTypes: {
      name: 'string',
      age: 'integer',
      score: 'float',
      active: 'boolean',
      born: 'date',
      seen: 'datetime',
      'odd key': 'integer',
    },
  },
  edges: { ...defaultMapping.edges, propertyTypes: { weight: 'float', type: 'string' } },
});

/** Nodes keyed by (doc, id), unique, and by (doc, n), not unique; edges by a declared integer. */
const keyedMapping = (prefix: string): GraphMapping => ({
  ...defaultMapping,
  prefix,
  nodes: {
    ...defaultMapping.nodes,
    propertyTypes: { doc: 'string', id: 'string', n: 'integer', d: 'integer' },
    indexes: [{ keys: ['doc', 'id'], unique: true }, { keys: ['d', 'n'] }],
  },
  edges: {
    ...defaultMapping.edges,
    propertyTypes: { seq: 'integer' },
    indexes: [{ keys: ['seq'], unique: true }],
  },
});

describe('declared indexes (#84)', () => {
  it('requires declared, distinct keys', () => {
    const withIndexes = (indexes: unknown): GraphMapping => ({
      ...defaultMapping,
      nodes: {
        ...defaultMapping.nodes,
        propertyTypes: { a: 'string', b: 'integer' },
        indexes: indexes as never,
      },
    });
    for (const indexes of [
      [{ keys: ['a', 'missing'] }],
      [{ keys: [] }],
      [{ keys: ['a', 'a'] }],
      [{ keys: ['a'], unique: 'yes' }],
      [{ keys: ['a', 'b'] }, { keys: ['a', 'b'] }],
      'a',
    ]) {
      expect(() => schemaSql(sqlite(), withIndexes(indexes)), JSON.stringify(indexes)).toThrow(
        MappingError,
      );
    }
    expect(() =>
      schemaSql(sqlite(), withIndexes([{ keys: ['a', 'b'] }, { keys: ['a', 'b'], unique: true }])),
    ).not.toThrow();
  });

  it('creates composite and unique indexes over the properties’ own expressions', () => {
    const m = keyedMapping('');
    expect(indexSql(postgres(), m, 'nodes', ['doc', 'id'], { unique: true })).toBe(
      `CREATE UNIQUE INDEX "nodes_properties_doc_id_unique" ON "nodes" ((("properties" ->> 'doc')), (("properties" ->> 'id')))`,
    );
    expect(indexSql(sqlite(), m, 'nodes', ['d', 'n'])).toBe(
      `CREATE INDEX "nodes_properties_d_n" ON "nodes" ((("properties" ->> '$."d"')), (("properties" ->> '$."n"')))`,
    );
    // MySQL does not use an index on a string, so a key with one has none.
    expect(indexSql(mysql(), m, 'nodes', ['doc', 'id'], { unique: true })).toBeUndefined();
    expect(indexSql(mysql(), m, 'nodes', ['d', 'n'])).toMatch(
      /^CREATE INDEX `nodes_properties_d_n`/,
    );
    expect(() => indexSql(sqlite(), m, 'nodes', ['doc', 'id'])).toThrow(SchemaError);
    expect(schemaSql(postgres(), m, { ifNotExists: true })).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS "edges_properties_seq_unique" ON "edges" (((("properties" ->> 'seq')::bigint)))`,
    );
  });

  it('indexes the expressions the planner reads the keys with', () => {
    const m = keyedMapping('');
    for (const dialect of [sqlite(), postgres(), mysql()]) {
      const index = indexSql(dialect, m, 'nodes', ['d', 'n'])!;
      const sql = createGraph({ dialect, mapping: m, executor: undefined as never })
        .compile('MATCH (a {d: $d, n: $n}) RETURN a')
        .explain();
      const quoted = dialect.quoteIdent('properties');
      for (const part of index.slice(index.indexOf(' ((') + 3, -2).split('), (')) {
        expect(sql, `${dialect.name} ${part}`).toContain(part.replaceAll(quoted, `n0.${quoted}`));
      }
    }
  });
});

describe('schemaSql', () => {
  it('names tables and indexes after the mapping and its prefix', () => {
    const sql = schemaSql(postgres(), graphMapping('g1_'), { ifNotExists: true });
    expect(sql[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "g1_nodes" \(/);
    expect(sql[1]).toContain('REFERENCES "g1_nodes" ("id")');
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "g1_nodes_labels" ON "g1_nodes" USING gin ("labels" jsonb_path_ops)',
    );
    expect(sql).toContain(
      `CREATE INDEX IF NOT EXISTS "g1_nodes_properties_age" ON "g1_nodes" (((("properties" ->> 'age')::bigint)))`,
    );
    // A declared edge property `type` does not collide with the index on the type column.
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "g1_edges_type" ON "g1_edges" ("type")');
    expect(sql.some((s) => s.includes('"g1_edges_properties_type"'))).toBe(true);
    // A key that is not an identifier gets a cleaned name with a hash.
    expect(sql.some((s) => /"g1_nodes_properties_odd_key_[0-9a-f]{8}"/.test(s))).toBe(true);
    expect(sql.slice(-2)).toEqual([
      'CREATE TABLE IF NOT EXISTS "g1_cypher_to_sql_schema" (id integer PRIMARY KEY CHECK (id = 1), version integer NOT NULL)',
      `INSERT INTO "g1_cypher_to_sql_schema" (id, version) VALUES (1, ${SCHEMA_VERSION}) ON CONFLICT (id) DO NOTHING`,
    ]);
  });

  it('gives no index where MySQL would not use one', () => {
    const m = graphMapping('');
    expect(propertyIndexSql(mysql(), m, 'nodes', 'age')).toBe(
      'CREATE INDEX `nodes_properties_age` ON `nodes` ((CAST(JSON_EXTRACT(`properties`, \'$."age"\') AS SIGNED)))',
    );
    for (const key of ['name', 'born', 'seen']) {
      expect(propertyIndexSql(mysql(), m, 'nodes', key), key).toBeUndefined();
    }
    expect(() => propertyIndexSql(sqlite(), m, 'nodes', 'nope')).toThrow(SchemaError);
  });

  it('indexes exactly the expression the planner reads a declared property with', () => {
    const m = graphMapping('');
    for (const dialect of [sqlite(), postgres(), mysql()]) {
      const graph = createGraph({ dialect, mapping: m, executor: undefined as never });
      for (const [key, filter] of [
        ['age', 'n.age > 3'],
        ['score', 'n.score > 1.5'],
        ['active', 'n.active = true'],
        ['name', "n.name = 'x'"],
        ['born', "n.born > date('2024-01-01')"],
        ['seen', "n.seen > datetime('2024-01-01T00:00Z')"],
      ] as const) {
        const index = propertyIndexSql(dialect, m, 'nodes', key);
        if (!index) {
          continue;
        }
        // The index's expression, with the planner's table alias.
        const expression = /\(\((.*)\)\)$/.exec(index)![1]!;
        const quoted = dialect.quoteIdent('properties');
        const sql = graph.compile(`MATCH (n) WHERE ${filter} RETURN n`).explain();
        expect(sql, `${dialect.name} ${key}`).toContain(
          expression.replaceAll(quoted, `n0.${quoted}`),
        );
      }
    }
  });
});

for (const backend of testBackends()) {
  describe(`migrate on ${backend.name}`, () => {
    afterAll(() => backend.dispose?.());

    it('creates a graph from nothing, and changes nothing when run again', async () => {
      const { dialect, executor } = await backend.open();
      const mapping = graphMapping('m1_');
      const first = await migrate({ dialect, executor, mapping });
      expect(first).toMatchObject({ from: 0, to: SCHEMA_VERSION, converted: 0, skipped: [] });
      expect(first.created.length).toBeGreaterThan(4);
      expect(await migrate({ dialect, executor, mapping })).toEqual({
        from: SCHEMA_VERSION,
        to: SCHEMA_VERSION,
        created: [],
        converted: 0,
        skipped: [],
      });
      const graph = createGraph({ dialect, executor, mapping, readOnly: false });
      await graph.query(
        "CREATE (:P {name: 'Ada', age: 36, born: '1815-12-10'})-[:R {weight: 0.5}]->(:P {name: 'Bob'})",
      );
      expect(
        await graph.query(
          "MATCH (a {name: 'Ada'})-[r]->(b) RETURN a.age AS age, a.born.year AS y, r.weight AS w, b.name AS b",
        ),
      ).toEqual([{ age: 36n, y: 1815n, w: 0.5, b: 'Bob' }]);
    });

    it('keeps graphs with different prefixes apart in one database', async () => {
      const { dialect, executor } = await backend.open();
      const one = graphMapping('p1_');
      const two = graphMapping('p2_');
      await migrate({ dialect, executor, mapping: one });
      await migrate({ dialect, executor, mapping: two });
      await createGraph({ dialect, executor, mapping: one, readOnly: false }).query(
        "CREATE ({name: 'only in one'})",
      );
      const count = async (mapping: GraphMapping): Promise<unknown> =>
        (
          await createGraph({ dialect, executor, mapping }).query('MATCH (n) RETURN count(n) AS c')
        )[0]!['c'];
      expect(await count(one)).toBe(1n);
      expect(await count(two)).toBe(0n);
    });

    it('adds the index of a property declared later', async () => {
      const { dialect, executor } = await backend.open();
      const before = { ...defaultMapping, prefix: 'd1_' };
      await migrate({ dialect, executor, mapping: before });
      const after = {
        ...before,
        nodes: { ...before.nodes, propertyTypes: { age: 'integer' as const } },
      };
      const result = await migrate({ dialect, executor, mapping: after });
      expect(result.created).toEqual([
        propertyIndexSql(dialect, after, 'nodes', 'age', { ifNotExists: true }),
      ]);
    });

    it('creates declared composite and unique indexes, which writes then respect (#84)', async () => {
      const { dialect, executor } = await backend.open();
      const mapping = keyedMapping('k1_');
      const { created } = await migrate({ dialect, executor, mapping });
      const names = created.map((sql) => /INDEX (?:IF NOT EXISTS )?[`"]([^`"]+)/.exec(sql)?.[1]);
      expect(names).toContain('k1_nodes_properties_d_n');
      expect(names).toContain('k1_edges_properties_seq_unique');
      // MySQL gets no index (unique or not) on a string key.
      expect(names.includes('k1_nodes_properties_doc_id_unique')).toBe(backend.name !== 'mysql');

      const graph = createGraph({ dialect, executor, mapping, readOnly: false });
      await graph.query("CREATE (:N {doc: 'd1', id: 'a'}), (:N {doc: 'd2', id: 'a'})");
      await graph.query('CREATE ()-[:R {seq: 1}]->(), ()-[:R {seq: 2}]->()');
      // A duplicate key is a CypherConstraintError, and the query writes nothing.
      await expect(graph.query('CREATE ()-[:R {seq: 1}]->()')).rejects.toMatchObject({
        constructor: CypherConstraintError,
        code: 'ConstraintValidationFailed',
      });
      if (backend.name !== 'mysql') {
        await expect(graph.query("CREATE (:N {doc: 'd1', id: 'a'})")).rejects.toThrow(
          CypherConstraintError,
        );
      }
      // MERGE on the key finds the node instead of creating another.
      await graph.query('UNWIND $rows AS row MERGE (:N {doc: row.doc, id: row.id})', {
        rows: [
          { doc: 'd1', id: 'a' },
          { doc: 'd1', id: 'b' },
        ],
      });
      const count = async (cypher: string): Promise<unknown> =>
        (await graph.query(cypher))[0]!['c'];
      expect(await count('MATCH (n:N) RETURN count(n) AS c')).toBe(3n);
      expect(await count('MATCH ()-[r:R]->() RETURN count(r) AS c')).toBe(2n);
    });

    it('reports the duplicates that keep it from creating a unique index (#84)', async () => {
      const { dialect, executor } = await backend.open();
      const plain = { ...defaultMapping, prefix: 'k2_' };
      await migrate({ dialect, executor, mapping: plain });
      await createGraph({ dialect, executor, mapping: plain, readOnly: false }).query(
        'CREATE ()-[:R {seq: 7}]->(), ()-[:R {seq: 7}]->(), ()-[:R {seq: 8}]->(), ()-[:R]->(), ()-[:R]->()',
      );
      const mapping = keyedMapping('k2_');
      await expect(migrate({ dialect, executor, mapping })).rejects.toThrow(
        /unique index k2_edges_properties_seq_unique cannot be created: k2_edges has rows with the same key, for example \[7\]$/,
      );
    });

    it('refuses a schema newer than the library', async () => {
      const { dialect, executor } = await backend.open();
      const mapping = { ...defaultMapping, prefix: 'v1_' };
      await migrate({ dialect, executor, mapping });
      await executor.transaction('write', (tx) =>
        tx.query(`UPDATE ${dialect.quoteIdent('v1_cypher_to_sql_schema')} SET version = 99`, []),
      );
      await expect(migrate({ dialect, executor, mapping })).rejects.toThrow(
        /schema is version 99, newer than this library knows/,
      );
    });

    // Last: it adds a version table next to the backend's default tables.
    it('upgrades a 1.0 database: declared date strings become dates', async () => {
      const { dialect, executor } = await backend.open();
      // The backend's tables are as 1.0 left them: no version table, and
      // declared dates stored as strings.
      await executor.transaction('write', async (tx) => {
        for (const properties of [
          '{"k": 1, "born": "2024-03-01"}',
          '{"k": 2, "born": "not a date"}',
          '{"k": 3}',
        ]) {
          await tx.query(
            `INSERT INTO ${dialect.quoteIdent('nodes')} (${dialect.quoteIdent('labels')}, ${dialect.quoteIdent('properties')}) VALUES ('[]', '${properties}')`,
            [],
          );
        }
      });
      const mapping = {
        ...defaultMapping,
        nodes: { ...defaultMapping.nodes, propertyTypes: { born: 'date' as const } },
      };
      const result = await migrate({ dialect, executor, mapping });
      expect(result).toMatchObject({ from: 1, to: SCHEMA_VERSION, converted: 1 });
      expect(result.skipped).toEqual([
        { table: 'nodes', id: expect.anything() as unknown, key: 'born', value: 'not a date' },
      ]);
      const graph = createGraph({ dialect, executor, mapping });
      expect(
        await graph.query(
          "MATCH (n) WHERE n.born > date('2024-01-01') RETURN n.k AS k, n.born AS b",
        ),
      ).toEqual([{ k: 1n, b: new CypherTemporal('date', '2024-03-01') }]);
      expect(await migrate({ dialect, executor, mapping })).toMatchObject({
        from: SCHEMA_VERSION,
        converted: 0,
        created: [],
      });
    });
  });
}
