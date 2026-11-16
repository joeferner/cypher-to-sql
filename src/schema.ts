// The tables of a graph: their DDL as text (schemaSql, propertyIndexSql), and
// migrate, which creates what is missing and upgrades the stored data through
// the caller's executor. The library never opens a connection; migrate runs its
// statements in one write transaction of the executor it is given.

import type { Dialect } from './dialect/dialect.js';
import { SchemaError } from './errors.js';
import type { SqlExecutor, SqlTx } from './executor.js';
import { stringifyCypherJson } from './json.js';
import {
  defaultMapping,
  validateMapping,
  type GraphMapping,
  type ResolvedMapping,
} from './mapping.js';
import { declaredValue, type PropertyType } from './property-types.js';

/**
 * The version of the stored layout this library writes and reads:
 * 1. Version 1.0: declared `date` and `datetime` properties are ISO strings.
 * 2. Declared `date` and `datetime` properties are temporal values (#65).
 */
export const SCHEMA_VERSION = 2;

/** The name of the version table, after the mapping's prefix. */
export const VERSION_TABLE = 'cypher_to_sql_schema';

export interface SchemaSqlOptions {
  /**
   * `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, and a
   * version row only when there is none. MySQL has no `IF NOT EXISTS` for
   * indexes, so there its indexes are plain `CREATE INDEX` (migrate checks the
   * catalog instead).
   */
  ifNotExists?: boolean;
}

/**
 * The statements that create a graph's tables for `dialect` and `mapping`: the
 * node and edge tables with their checks, the indexes the planner uses (labels
 * on PostgreSQL, relationships by either end and type), one expression index
 * per declared property (see `propertyIndexSql`), and the version table with
 * the current `SCHEMA_VERSION`. Only text: run it with your migration tool,
 * or use `migrate`, which also upgrades existing data.
 */
export function schemaSql(
  dialect: Dialect,
  mapping: GraphMapping,
  options: SchemaSqlOptions = {},
): string[] {
  const m = validateMapping(mapping);
  const ddl = new Ddl(dialect, m, options.ifNotExists ?? false);
  return [
    ...ddl.tables(),
    ...ddl.standardIndexes(),
    ...declaredKeys(m).flatMap(({ kind, key }) => {
      const sql = ddl.propertyIndex(kind, key);
      return sql ? [sql.sql] : [];
    }),
    ...ddl.versionTable(SCHEMA_VERSION),
  ];
}

/**
 * The expression index for the declared property `key` of the node or edge
 * table: `CREATE INDEX <table>_<column>_<key> ON <table> ((<expression>))`,
 * with exactly the expression the planner reads the property with, so that
 * filters on it can use the index. Undefined where the database would not use
 * one: on MySQL for `string`, `date`, and `datetime` properties.
 */
export function propertyIndexSql(
  dialect: Dialect,
  mapping: GraphMapping,
  kind: 'nodes' | 'edges',
  key: string,
  options: SchemaSqlOptions = {},
): string | undefined {
  const m = validateMapping(mapping);
  if (!m[kind].propertyTypes?.[key]) {
    throw new SchemaError(
      `The mapping declares no type for the ${kind} property ${JSON.stringify(key)}`,
    );
  }
  return new Ddl(dialect, m, options.ifNotExists ?? false).propertyIndex(kind, key)?.sql;
}

export interface MigrateOptions {
  dialect: Dialect;
  /** An executor whose role may create tables and indexes and write the graph. */
  executor: SqlExecutor;
  mapping?: GraphMapping | undefined;
}

export interface MigrateResult {
  /** The schema version found: 0 for no tables, 1 for tables without a version table (1.0). */
  from: number;
  to: number;
  /** The statements that created tables and indexes, in order. */
  created: string[];
  /** Property values the data migrations rewrote. */
  converted: number;
  /**
   * Values a data migration could not convert (a declared `date` that is not
   * an ISO date): left as they were.
   */
  skipped: { table: string; id: unknown; key: string; value: unknown }[];
}

/** Rows per batch of a data migration. */
const BATCH = 500;

/**
 * Brings a graph's tables up to this library's `SCHEMA_VERSION`, in one write
 * transaction of `executor` (MySQL commits each DDL statement by itself):
 *
 * - No tables: creates everything `schemaSql` lists.
 * - Tables without a version table (created by 1.0, or from the example
 *   schemas): version 1. Creates the version table, then upgrades.
 * - An older version: runs the data migrations from it, then records the new
 *   version. From 1: rewrites declared `date` and `datetime` strings as
 *   temporal values.
 * - Every run: creates the expression index of each declared property that
 *   has none (by name), so declaring a property and migrating adds its index.
 *
 * A version newer than the library's is a `SchemaError`. Run it from one
 * process (at deploy); it is safe to run again.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const { dialect, executor } = options;
  const m = validateMapping(options.mapping ?? defaultMapping);
  const ddl = new Ddl(dialect, m, true);
  return executor.transaction('write', async (tx) => {
    const catalog = new Catalog(dialect, m, tx);
    const created: string[] = [];
    const run = async (sql: string): Promise<void> => {
      await tx.query(sql, []);
      created.push(sql);
    };

    let from: number;
    if (await catalog.tableExists(ddl.versionTableName)) {
      from = await ddl.readVersion(tx);
    } else {
      from = (await catalog.tableExists(m.nodes.table)) ? 1 : 0;
    }
    if (from > SCHEMA_VERSION) {
      throw new SchemaError(
        `The graph's schema is version ${from}, newer than this library knows (${SCHEMA_VERSION}); upgrade cypher-to-sql`,
      );
    }

    if (from === 0) {
      for (const sql of [...ddl.tables(), ...ddl.standardIndexes()]) {
        if (!(await catalog.needsIndexCheck(sql)) || !(await catalog.indexExists(sql))) {
          await run(sql);
        }
      }
    }
    if (!(await catalog.tableExists(ddl.versionTableName))) {
      for (const sql of ddl.versionTable(from === 0 ? SCHEMA_VERSION : from)) {
        await run(sql);
      }
    }

    let converted = 0;
    const skipped: MigrateResult['skipped'] = [];
    if (from >= 1 && from < 2) {
      const result = await temporalStrings(dialect, m, tx);
      converted += result.converted;
      skipped.push(...result.skipped);
    }
    if (from !== SCHEMA_VERSION) {
      await tx.query(ddl.setVersion(SCHEMA_VERSION), []);
    }

    for (const { kind, key } of declaredKeys(m)) {
      const index = ddl.propertyIndex(kind, key);
      if (index && !(await catalog.indexExistsByName(index.table, index.name))) {
        await run(index.sql);
      }
    }
    return { from, to: SCHEMA_VERSION, created, converted, skipped };
  });
}

/** The declared property keys of the mapping, nodes first. */
function declaredKeys(
  m: ResolvedMapping,
): { kind: 'nodes' | 'edges'; key: string; type: PropertyType }[] {
  return (['nodes', 'edges'] as const).flatMap((kind) =>
    Object.entries(m[kind].propertyTypes ?? {}).map(([key, type]) => ({ kind, key, type })),
  );
}

/** Version 1 to 2: declared `date` and `datetime` strings become temporal values. */
async function temporalStrings(
  d: Dialect,
  m: ResolvedMapping,
  tx: SqlTx,
): Promise<Pick<MigrateResult, 'converted' | 'skipped'>> {
  let converted = 0;
  const skipped: MigrateResult['skipped'] = [];
  for (const { kind, key, type } of declaredKeys(m)) {
    if (type !== 'date' && type !== 'datetime') {
      continue;
    }
    const t = m[kind];
    const table = qualified(d, m, t.table);
    const id = d.quoteIdent(t.id);
    const properties = d.quoteIdent(t.properties);
    const member = d.jsonLiteralMember(properties, key);
    const select =
      `SELECT ${id} AS id, ${d.typedMember(properties, key, 'string')} AS v FROM ${table} ` +
      `WHERE ${d.jsonType(member)} = 'string' AND ${id} > ${d.typedPlaceholder(d.placeholder(1), 'integer')} ` +
      `ORDER BY ${id} LIMIT ${BATCH}`;
    const update =
      `UPDATE ${table} SET ${properties} = ${d.mergeProperties(properties, d.jsonInput(d.placeholder(1)))} ` +
      `WHERE ${id} = ${d.typedPlaceholder(d.placeholder(2), 'integer')}`;
    let last: unknown = -1;
    for (;;) {
      const rows = await tx.query(select, [last]);
      for (const row of rows) {
        const value = row['v'];
        try {
          const patch = { [key]: declaredValue(key, value as string, type) };
          await tx.query(update, [stringifyCypherJson(patch), row['id']]);
          converted++;
        } catch {
          skipped.push({ table: t.table, id: row['id'], key, value });
        }
      }
      if (rows.length < BATCH) {
        break;
      }
      last = rows[rows.length - 1]!['id'];
    }
  }
  return { converted, skipped };
}

function qualified(d: Dialect, m: ResolvedMapping, table: string): string {
  return m.schema ? `${d.quoteIdent(m.schema)}.${d.quoteIdent(table)}` : d.quoteIdent(table);
}

/**
 * An index name: `<table>_<suffix>`, made of identifier characters and at most
 * 60 long; a name that had to change gets a hash of the original, so that two
 * keys never share one.
 */
function indexName(table: string, suffix: string): string {
  const raw = `${table}_${suffix}`;
  const clean = raw.replace(/[^A-Za-z0-9_]/g, '_');
  if (clean === raw && raw.length <= 60) {
    return raw;
  }
  let hash = 0x811c9dc5;
  for (const char of raw) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  }
  return `${clean.slice(0, 51)}_${hash.toString(16).padStart(8, '0')}`;
}

/** The DDL of one graph, for one dialect. */
class Ddl {
  public readonly versionTableName: string;

  public constructor(
    private readonly d: Dialect,
    private readonly m: ResolvedMapping,
    private readonly ifNotExists: boolean,
  ) {
    this.versionTableName = `${m.prefix}${VERSION_TABLE}`;
  }

  private q(name: string): string {
    return this.d.quoteIdent(name);
  }

  private table(name: string): string {
    return qualified(this.d, this.m, name);
  }

  private create(): string {
    return this.ifNotExists ? 'CREATE TABLE IF NOT EXISTS' : 'CREATE TABLE';
  }

  /** `CREATE INDEX` with the index name, qualified on SQLite (attached databases). */
  private index(name: string, table: string, parts: string): string {
    const ifNotExists = this.ifNotExists && this.d.name !== 'mysql' ? ' IF NOT EXISTS' : '';
    const indexName =
      this.d.name === 'sqlite' && this.m.schema
        ? `${this.q(this.m.schema)}.${this.q(name)}`
        : this.q(name);
    const target = this.d.name === 'sqlite' ? this.q(table) : this.table(table);
    return `CREATE INDEX${ifNotExists} ${indexName} ON ${target} ${parts}`;
  }

  public tables(): string[] {
    const { nodes, edges } = this.m;
    const q = (name: string): string => this.q(name);
    switch (this.d.name) {
      case 'postgres':
        return [
          `${this.create()} ${this.table(nodes.table)} (\n` +
            `  ${q(nodes.id)} bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,\n` +
            `  ${q(nodes.labels)} jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(${q(nodes.labels)}) = 'array'),\n` +
            `  ${q(nodes.properties)} jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(${q(nodes.properties)}) = 'object')\n)`,
          `${this.create()} ${this.table(edges.table)} (\n` +
            `  ${q(edges.id)} bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,\n` +
            `  ${q(edges.startId)} bigint NOT NULL REFERENCES ${this.table(nodes.table)} (${q(nodes.id)}),\n` +
            `  ${q(edges.endId)} bigint NOT NULL REFERENCES ${this.table(nodes.table)} (${q(nodes.id)}),\n` +
            `  ${q(edges.type)} text NOT NULL,\n` +
            `  ${q(edges.properties)} jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(${q(edges.properties)}) = 'object')\n)`,
        ];
      case 'sqlite':
        return [
          `${this.create()} ${this.table(nodes.table)} (\n` +
            `  ${q(nodes.id)} INTEGER PRIMARY KEY,\n` +
            `  ${q(nodes.labels)} TEXT NOT NULL DEFAULT '[]' CHECK (json_type(${q(nodes.labels)}) = 'array'),\n` +
            `  ${q(nodes.properties)} TEXT NOT NULL DEFAULT '{}' CHECK (json_type(${q(nodes.properties)}) = 'object')\n)`,
          `${this.create()} ${this.table(edges.table)} (\n` +
            `  ${q(edges.id)} INTEGER PRIMARY KEY,\n` +
            `  ${q(edges.startId)} INTEGER NOT NULL REFERENCES ${q(nodes.table)} (${q(nodes.id)}),\n` +
            `  ${q(edges.endId)} INTEGER NOT NULL REFERENCES ${q(nodes.table)} (${q(nodes.id)}),\n` +
            `  ${q(edges.type)} TEXT NOT NULL,\n` +
            `  ${q(edges.properties)} TEXT NOT NULL DEFAULT '{}' CHECK (json_type(${q(edges.properties)}) = 'object')\n)`,
        ];
      case 'mysql':
        return [
          `${this.create()} ${this.table(nodes.table)} (\n` +
            `  ${q(nodes.id)} bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,\n` +
            `  ${q(nodes.labels)} json NOT NULL DEFAULT (JSON_ARRAY()) CHECK (JSON_TYPE(${q(nodes.labels)}) = 'ARRAY'),\n` +
            `  ${q(nodes.properties)} json NOT NULL DEFAULT (JSON_OBJECT()) CHECK (JSON_TYPE(${q(nodes.properties)}) = 'OBJECT')\n` +
            `) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin`,
          `${this.create()} ${this.table(edges.table)} (\n` +
            `  ${q(edges.id)} bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,\n` +
            `  ${q(edges.startId)} bigint NOT NULL,\n` +
            `  ${q(edges.endId)} bigint NOT NULL,\n` +
            `  ${q(edges.type)} varchar(255) NOT NULL,\n` +
            `  ${q(edges.properties)} json NOT NULL DEFAULT (JSON_OBJECT()) CHECK (JSON_TYPE(${q(edges.properties)}) = 'OBJECT'),\n` +
            `  FOREIGN KEY (${q(edges.startId)}) REFERENCES ${this.table(nodes.table)} (${q(nodes.id)}),\n` +
            `  FOREIGN KEY (${q(edges.endId)}) REFERENCES ${this.table(nodes.table)} (${q(nodes.id)})\n` +
            `) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin`,
        ];
      default:
        throw new SchemaError(`No DDL for the dialect ${this.d.name}`);
    }
  }

  /** Labels (PostgreSQL), and relationships by either end and by type. */
  public standardIndexes(): string[] {
    const { nodes, edges } = this.m;
    const q = (name: string): string => this.q(name);
    return [
      ...(this.d.name === 'postgres'
        ? [
            this.index(
              indexName(nodes.table, nodes.labels),
              nodes.table,
              `USING gin (${q(nodes.labels)} jsonb_path_ops)`,
            ),
          ]
        : []),
      this.index(
        indexName(edges.table, `${edges.startId}_${edges.type}`),
        edges.table,
        `(${q(edges.startId)}, ${q(edges.type)})`,
      ),
      this.index(
        indexName(edges.table, `${edges.endId}_${edges.type}`),
        edges.table,
        `(${q(edges.endId)}, ${q(edges.type)})`,
      ),
      this.index(indexName(edges.table, edges.type), edges.table, `(${q(edges.type)})`),
    ];
  }

  /** The expression index of a declared property, or undefined where it would go unused. */
  public propertyIndex(
    kind: 'nodes' | 'edges',
    key: string,
  ): { sql: string; name: string; table: string } | undefined {
    const t = this.m[kind];
    const type = t.propertyTypes?.[key];
    if (!type) {
      return undefined;
    }
    const d = this.d;
    const properties = this.q(t.properties);
    let expression: string;
    if (type === 'date' || type === 'datetime') {
      if (d.name === 'mysql') {
        return undefined;
      }
      // The sort key, as compareKnownTemporal compares it (src/planner/expr.ts).
      expression = d.orderString(
        d.typedMember(d.jsonLiteralMember(properties, key), '~k', 'string'),
      );
    } else {
      if (d.name === 'mysql' && type === 'string') {
        return undefined;
      }
      expression = d.typedMember(properties, key, type);
    }
    const name = indexName(t.table, `${t.properties}_${key}`);
    return { sql: this.index(name, t.table, `((${expression}))`), name, table: t.table };
  }

  public versionTable(version: number): string[] {
    const table = this.table(this.versionTableName);
    const insert =
      this.d.name === 'postgres'
        ? `INSERT INTO ${table} (id, version) VALUES (1, ${version}) ON CONFLICT (id) DO NOTHING`
        : this.d.name === 'sqlite'
          ? `INSERT OR IGNORE INTO ${table} (id, version) VALUES (1, ${version})`
          : `INSERT IGNORE INTO ${table} (id, version) VALUES (1, ${version})`;
    return [
      `${this.create()} ${table} (id integer PRIMARY KEY CHECK (id = 1), version integer NOT NULL)`,
      insert,
    ];
  }

  public setVersion(version: number): string {
    return `UPDATE ${this.table(this.versionTableName)} SET version = ${version} WHERE id = 1`;
  }

  public async readVersion(tx: SqlTx): Promise<number> {
    const rows = await tx.query(
      `SELECT version FROM ${this.table(this.versionTableName)} WHERE id = 1`,
      [],
    );
    return rows.length === 0 ? 1 : Number(rows[0]!['version']);
  }
}

/** What exists in the database, from its catalog. */
class Catalog {
  public constructor(
    private readonly d: Dialect,
    private readonly m: ResolvedMapping,
    private readonly tx: SqlTx,
  ) {}

  public async tableExists(table: string): Promise<boolean> {
    const p = (i: number): string => this.d.placeholder(i);
    let rows;
    switch (this.d.name) {
      case 'postgres':
        rows = await this.tx.query(`SELECT to_regclass(${p(1)}) IS NOT NULL AS e`, [
          this.m.schema ? `"${this.m.schema}"."${table}"` : `"${table}"`,
        ]);
        return rows[0]!['e'] === true;
      case 'sqlite':
        rows = await this.tx.query(
          `SELECT count(*) AS e FROM ${this.m.schema ? `"${this.m.schema}".` : ''}sqlite_master ` +
            `WHERE type = 'table' AND name = ${p(1)}`,
          [table],
        );
        return Number(rows[0]!['e']) > 0;
      default:
        rows = await this.tx.query(
          `SELECT count(*) AS e FROM information_schema.tables ` +
            `WHERE table_schema = COALESCE(${p(1)}, DATABASE()) AND table_name = ${p(2)}`,
          [this.m.schema ?? null, table],
        );
        return Number(rows[0]!['e']) > 0;
    }
  }

  /** MySQL has no CREATE INDEX IF NOT EXISTS, so its indexes are looked up first. */
  public needsIndexCheck(sql: string): Promise<boolean> {
    return Promise.resolve(this.d.name === 'mysql' && sql.startsWith('CREATE INDEX'));
  }

  /** Whether the index a MySQL `CREATE INDEX` statement creates exists already. */
  public async indexExists(sql: string): Promise<boolean> {
    const match = /^CREATE INDEX `([^`]+)` ON (?:`[^`]+`\.)?`([^`]+)`/.exec(sql);
    return match ? this.indexExistsByName(match[2]!, match[1]!) : false;
  }

  public async indexExistsByName(table: string, name: string): Promise<boolean> {
    const p = (i: number): string => this.d.placeholder(i);
    let rows;
    switch (this.d.name) {
      case 'postgres':
        rows = await this.tx.query(`SELECT to_regclass(${p(1)}) IS NOT NULL AS e`, [
          this.m.schema ? `"${this.m.schema}"."${name}"` : `"${name}"`,
        ]);
        return rows[0]!['e'] === true;
      case 'sqlite':
        rows = await this.tx.query(
          `SELECT count(*) AS e FROM ${this.m.schema ? `"${this.m.schema}".` : ''}sqlite_master ` +
            `WHERE type = 'index' AND name = ${p(1)}`,
          [name],
        );
        return Number(rows[0]!['e']) > 0;
      default:
        rows = await this.tx.query(
          `SELECT count(*) AS e FROM information_schema.statistics ` +
            `WHERE table_schema = COALESCE(${p(1)}, DATABASE()) AND table_name = ${p(2)} AND index_name = ${p(3)}`,
          [this.m.schema ?? null, table, name],
        );
        return Number(rows[0]!['e']) > 0;
    }
  }
}
