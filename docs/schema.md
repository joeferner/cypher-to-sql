# Schema

The graph lives in two tables: one row per node and one per relationship. Labels and properties are JSON. The library reads and writes these tables; it never creates or changes them.

DDL for the default mapping, tested in [test/examples.test.ts](../test/examples.test.ts):

- PostgreSQL: [examples/schema/postgres.sql](../examples/schema/postgres.sql)
- SQLite: [examples/schema/sqlite.sql](../examples/schema/sqlite.sql)

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

## Data rules

Data written by the library follows these rules. Data written by other tools must follow them too:

- `labels` is a JSON array of strings, `properties` a JSON object.
- Property values are strings, numbers, booleans, or lists of those. There are no nested maps, and a null value is a missing key.
- Integers are stored without a decimal point (`1`) and floats with one (`1.0`); they come back as `bigint` and `number`. On PostgreSQL, `jsonb` keeps the difference.
- Keys starting with `~` (`~cypher`, `~id`, `~labels`, `~type`, `~start`, `~end`, `~nodes`, `~relationships`) are reserved.
- Declared property types (below) must hold; add `CHECK` constraints if other tools write to the tables.

## Indexes

The DDL files create the indexes every graph needs:

- **Relationship ends:** `(start_id, type)` and `(end_id, type)`, used for every relationship pattern in either direction, with or without a type.
- **Relationship type:** `(type)`, for patterns with a type and no bound end.
- **Labels (PostgreSQL):** a GIN index on `labels`, used by label predicates (`(n:Person)` is `labels @> '["Person"]'`). SQLite has no equivalent; a label predicate there reads each candidate row's labels.

### Properties

A property filter on an undeclared key (`n.name = $name`, or `(n {name: $name})`) compares JSON values with Cypher's rules at run time, which no index can serve. To filter on a key with an index, declare its type in the mapping. The library then reads it as a typed SQL value, in the same form as an expression index:

```ts
const mapping = {
  ...defaultMapping,
  nodes: { ...defaultMapping.nodes, propertyTypes: { name: 'string', age: 'integer' } },
};
```

```sql
-- PostgreSQL
CREATE INDEX nodes_name ON nodes ((properties ->> 'name'));
CREATE INDEX nodes_age ON nodes (((properties ->> 'age')::bigint));

-- SQLite
CREATE INDEX nodes_name ON nodes (properties ->> '$."name"');
CREATE INDEX nodes_age ON nodes (properties ->> '$."age"');
```

- A declared type applies to the key on every label (or relationship type). The key is written into the SQL as a literal, so the index expression must match it exactly.
- Writes through the library check declared types: `CREATE` rejects a value of another type with a `SemanticError`.
- Reads trust the declaration: a stored value of another type makes the PostgreSQL cast fail. Add `CHECK` constraints when other tools write to the tables.
- Supported types: `string`, `integer`, `float`, `boolean`, `date` (`YYYY-MM-DD`), and `datetime` (ISO 8601 with a time zone). Dates are stored as strings.

`graph.compile(cypher).explain()` shows the SQL, so you can check a plan with `EXPLAIN` in the database.
