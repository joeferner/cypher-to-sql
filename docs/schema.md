# Schema

The graph lives in two tables: one row per node and one per relationship. Labels and properties are JSON. A third table, `cypher_to_sql_schema`, records the version of the stored layout. Queries only read and write the rows; the tables come from `migrate` or from your own DDL (below).

## Creating and upgrading the tables

`migrate` creates the tables and indexes a mapping needs, and upgrades data stored by an older version of the library, through an executor you give it:

```ts
import { migrate, postgres } from 'cypher-to-sql';

// At deploy, with an executor whose role may create tables.
const result = await migrate({ dialect: postgres(), executor: adminExecutor, mapping });
// { from: 0, to: 2, created: [...statements], converted: 0, skipped: [] }
```

- **No tables:** it creates the node and edge tables, their indexes, an index for each [declared property](#properties), and the version table.
- **Tables without a version table** (created by 1.0, or from the example DDL files): it treats them as version 1, adds the version table, and runs the upgrades.
- **Upgrades** run from the stored version to the library's (`SCHEMA_VERSION`). From version 1, declared `date` and `datetime` strings become temporal values ([below](#dates-and-date-times)); values that are not valid dates stay as they were and are listed in `result.skipped`.
- **Every run** creates the index of each declared property that has none, so declaring a property and running `migrate` adds its index.
- A version newer than the library's is a `SchemaError`.

It runs in one write transaction (MySQL commits each DDL statement by itself), and running it again changes nothing. Run it from one process, at deploy, not from every application instance.

To run the DDL with your own migration tool instead, `schemaSql(dialect, mapping, { ifNotExists })` returns the statements, and `propertyIndexSql(dialect, mapping, 'nodes', key)` the one index of a property declared later. Both only return text. The files in [examples/schema](../examples/schema) hold the same tables for the default mapping, without the version table; `migrate` takes them as version 1.

## Tables

| Table   | Column       | PostgreSQL        | SQLite        | Content                     |
| ------- | ------------ | ----------------- | ------------- | --------------------------- |
| `nodes` | `id`         | `bigint` identity | `INTEGER` key | Node id                     |
|         | `labels`     | `jsonb`           | `TEXT` (JSON) | JSON array of label strings |
|         | `properties` | `jsonb`           | `TEXT` (JSON) | JSON object                 |
| `edges` | `id`         | `bigint` identity | `INTEGER` key | Relationship id             |
|         | `start_id`   | `bigint`          | `INTEGER`     | Start node id               |
|         | `end_id`     | `bigint`          | `INTEGER`     | End node id                 |
|         | `type`       | `text`            | `TEXT`        | Relationship type           |
|         | `properties` | `jsonb`           | `TEXT` (JSON) | JSON object                 |

Ids are 64-bit integers; other id types are not supported yet (`id(n)` returns an integer). With ids the database does not generate, give the write graph an `idStrategy` of `{ kind: 'generator', generate }`.

## Mapping

`createGraph({ mapping })` sets the table and column names, and an optional schema (PostgreSQL) or attached database (SQLite) that prefixes both tables. Every name must be a plain SQL identifier; `validateMapping` checks them, so a mapping never puts other text into the SQL.

```ts
import { createGraph, defaultMapping, postgres } from 'cypher-to-sql';

const graph = createGraph({
  dialect: postgres(),
  executor,
  mapping: {
    ...defaultMapping,
    schema: 'tenant_42',
    nodes: { ...defaultMapping.nodes, table: 'graph_nodes' },
    edges: { ...defaultMapping.edges, table: 'graph_edges' },
  },
});
```

One mapping per schema serves many isolated graphs with the same code.

To keep several graphs in one database or schema, give each mapping a `prefix`. It prefixes every table of the graph, including the version table, and the names of the indexes `migrate` creates:

```ts
const sales = { ...defaultMapping, prefix: 'sales_' }; // sales_nodes, sales_edges, sales_cypher_to_sql_schema
await migrate({ dialect, executor: adminExecutor, mapping: sales });
const graph = createGraph({ dialect, executor, mapping: sales });
```

Renaming the tables without a prefix works for queries too, but such graphs share one version table; use a prefix (or a schema) for each graph you migrate.

## Data rules

Data written by the library follows these rules. Data written by other tools must follow them too:

- `labels` is a JSON array of strings, `properties` a JSON object.
- Property values are strings, numbers, booleans, or lists of those. There are no nested maps, and a null value is a missing key.
- Integers are stored without a decimal point (`1`) and floats with one (`1.0`); they come back as `bigint` and `number`. On PostgreSQL, `jsonb` keeps the difference.
- Keys starting with `~` (`~cypher`, `~id`, `~labels`, `~type`, `~start`, `~end`, `~nodes`, `~relationships`) are reserved.
- Declared property types (below) must hold; add `CHECK` constraints if other tools write to the tables.

## Indexes

`migrate`, `schemaSql`, and the DDL files create the indexes every graph needs:

- **Relationship ends:** `(start_id, type)` and `(end_id, type)`, used for every relationship pattern in either direction, with or without a type.
- **Relationship type:** `(type)`, for patterns with a type and no bound end.
- **Labels (PostgreSQL):** a GIN index on `labels`, used by label predicates (`(n:Person)` is `labels @> '["Person"]'`). SQLite has no equivalent; a label predicate there reads each candidate row's labels.

### Properties

A property filter on an undeclared key (`n.name = $name`, or `(n {name: $name})`) compares JSON values with Cypher's rules at run time, which no index can serve. To filter on a key with an index, declare its type in the mapping. The library then reads it as a typed SQL value, in the same form as an expression index. `migrate` creates that index (named `<table>_<column>_<key>`), and `propertyIndexSql` returns its DDL; the expression must match the library's exactly, so prefer them to writing it by hand:

```ts
const mapping = {
  ...defaultMapping,
  nodes: { ...defaultMapping.nodes, propertyTypes: { name: 'string', age: 'integer' } },
};
```

```sql
-- PostgreSQL
CREATE INDEX nodes_properties_name ON nodes (((properties ->> 'name')));
CREATE INDEX nodes_properties_age ON nodes ((((properties ->> 'age')::bigint)));

-- SQLite
CREATE INDEX nodes_properties_name ON nodes (((properties ->> '$."name"')));
CREATE INDEX nodes_properties_age ON nodes (((properties ->> '$."age"')));

-- MySQL (no index for string, date, and datetime properties: MySQL does not use one)
CREATE INDEX nodes_properties_age ON nodes ((CAST(JSON_EXTRACT(properties, '$."age"') AS SIGNED)));
```

- A declared type applies to the key on every label (or relationship type). The key is written into the SQL as a literal, so the index expression must match it exactly.
- Writes through the library check declared types: `CREATE`, `MERGE`, and `SET` reject a value of another type with a `SemanticError`. Two conversions: for `integer`, a JavaScript `number` (or a Cypher float) with an integral value up to 2^53, such as `30` from `JSON.parse`, is stored as that integer; for `date` and `datetime`, ISO 8601 text is stored as that temporal value (see below). `30.5`, or an integral float beyond 2^53, is still rejected, and an undeclared key keeps a `number` as a float.
- Reads trust the declaration: a stored value of another type makes the PostgreSQL cast fail. Add `CHECK` constraints when other tools write to the tables.
- Supported types: `string`, `integer`, `float`, `boolean`, `date`, and `datetime`.

#### Dates and date-times

A property declared as `date` or `datetime` holds a temporal value, as `date(...)` and `datetime(...)` give: `n.since` is a `date`, `n.since.year` works, and `n.since > date('2024-01-01')` compares dates. Writes take a temporal value of that kind or its ISO 8601 text (`'2024-03-01'`, or `'2024-02-29T13:45:00Z'` with a time zone), which they convert. In the table it is a JSON object with the value's text (`~s`), a sort key by instant (`~k`), and its components:

```json
{
  "since": {
    "~cypher": "date",
    "~s": "2024-03-01",
    "~k": "1000000001709251200000000000",
    "year": 2024,
    "...": "..."
  }
}
```

A comparison with a date known before the query runs (a parameter, or `date('2024-01-01')`) compares the sort keys, which an index on that expression serves; for a `datetime`, only an ordering (equal instants in different offsets are different values):

```sql
-- PostgreSQL
CREATE INDEX nodes_properties_since ON nodes ((((properties -> 'since') ->> '~k') COLLATE "C"));

-- SQLite
CREATE INDEX nodes_properties_since ON nodes ((((properties -> '$."since"') ->> '$."~k"')));
```

- As in Cypher, a string is not a date: `n.since = '2024-03-01'` is false. Compare with `date('2024-03-01')`.
- `MERGE (n {since: '2024-03-01'})` is an error: its pattern would never match the stored date, so it would create a node on every run. Use `date('2024-03-01')` or a `CypherTemporal` parameter.
- Version 1.0 stored these properties as strings. `migrate` rewrites them as temporal values (schema version 1 to 2). Without it, rewrite them once with the declaration in place: `MATCH (n) WHERE n.since IS NOT NULL SET n.since = n.since`.

`graph.compile(cypher).explain()` shows the SQL, so you can check a plan with `EXPLAIN` in the database.
