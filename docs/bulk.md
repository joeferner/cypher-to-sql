# Bulk writes

`graph.bulkWrite` loads many nodes and relationships without Cypher, in a few set-based statements per chunk of input, and `graph.bulkDelete` deletes many by label or type and property values. Each call runs in one write transaction: it writes everything or nothing. They need a writing graph (`readOnly: false`); on a read-only graph they reject with `ReadOnlyViolationError`.

Use them to load data from files or other systems. A Cypher `UNWIND $rows AS row MERGE ...` costs 2–3 statements per row; `bulkWrite` costs 2–3 statements per 5,000 rows, at 10,000–48,000 rows per second ([below](#speed)).

```ts
// The mapping declares the key properties: propertyTypes { tenant: 'string', id: 'string' },
// with indexes [{ keys: ['tenant', 'id'] }].
const graph = createGraph({ dialect, executor, mapping, readOnly: false });

const result = await graph.bulkWrite(
  {
    nodes: [
      { labels: ['Person'], properties: { tenant: 't1', id: 'p1', name: 'Ada' } },
      { labels: ['Person'], properties: { tenant: 't1', id: 'p2', name: 'Alan' } },
    ],
    relationships: [
      {
        type: 'KNOWS',
        start: { label: 'Person', match: { tenant: 't1', id: 'p1' } },
        end: { label: 'Person', match: { tenant: 't1', id: 'p2' } },
        properties: { since: 1936n },
      },
    ],
  },
  { nodeKey: { Person: ['tenant', 'id'] } },
);
// { nodesCreated: 2, nodesUpdated: 0, relationshipsCreated: 1, relationshipsSkipped: 0 }

await graph.bulkDelete({ nodes: { label: 'Person', match: { tenant: 't1' } }, detach: true });
// { nodesDeleted: 2, relationshipsDeleted: 1 }
```

## Nodes

Each node has `labels` (at least one) and `properties`. Property values are Cypher values, as for parameters ([values](values.md)): `bigint` integers, numbers as floats, strings, booleans, lists, maps, `CypherTemporal`, and `CypherDuration`. A `null` (or `undefined`) value means the key is absent. A [declared property](schema.md#properties) is checked and stored in its type, as a `SET` stores it: a whole number for an `integer` is stored as an integer, and a string for a `date` is stored as a date.

Without a `nodeKey` for any of its labels, a node is always inserted, like `CREATE`.

### Keys

`nodeKey` names, for a label, the properties whose values identify a node of that label: `{ Person: ['tenant', 'id'] }`. The key properties must be declared in `propertyTypes` as `string`, `integer`, `float`, or `boolean`, and every node with the label must have a value for each of them. Declare an [index](schema.md#composite-and-unique-indexes) on the same properties so that the lookups use it. A node may have at most one label with a `nodeKey`.

A node whose key no node with the label has yet is inserted. A node whose key exists already is handled as `onConflict` says:

| `onConflict`      | An existing node with the key                                                                | The same Cypher                                                         |
| ----------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `merge` (default) | Gets the node's labels and properties; a null removes the key                                | `MERGE (n:Person {tenant: ..., id: ...}) SET n += $properties, n:Admin` |
| `replace`         | Gets the node's labels; its properties are replaced                                          | `MERGE (n:Person {...}) SET n = $properties, n:Admin`                   |
| `ignore`          | Stays as it is                                                                               | `MERGE (n:Person {...}) ON CREATE SET n = $properties, n:Admin`         |
| `error`           | The call fails with `CypherConstraintError` `ConstraintValidationFailed`, and writes nothing |                                                                         |

Nodes of the input with the same key are combined in input order first, as if written one after the other: with `merge`, later properties overwrite earlier ones, with `replace` the last one wins, with `ignore` the first one, and with `error` the call fails. If several existing nodes have the key, each of them is updated.

## Relationships

Each relationship has a `type`, optional `properties`, and a `start` and an `end`: an optional `label` and a `match` of property values that find the node, as `MATCH (a:Label {key: value, ...})` does. They are written after the call's nodes, so they can connect nodes the same call writes.

- An end that matches several nodes gets a relationship for each, as `MATCH ... MATCH ... CREATE` would.
- An end that matches no node is skipped and counted in `relationshipsSkipped`; with `missingEndpoint: 'error'` the call fails with `CypherConstraintError` `MissingEndpoint` and writes nothing.
- Relationships are always created, like `CREATE`, never merged with existing ones.

`match` uses the index of declared properties; an end without a `label` or `match` on declared properties reads every node.

## Deleting

`bulkDelete` deletes the relationships, then the nodes, that match:

- `relationships: { type?, match? }`: the relationships with the type and property values.
- `nodes: { label?, match? }`: the nodes with the label and property values. A node that still has relationships fails the call with `CypherConstraintError` `DeleteConnectedNode`, unless `detach: true`, which deletes those relationships too, as `DETACH DELETE` does.

It returns `{ nodesDeleted, relationshipsDeleted }`. Leaving out both `label` and `match` matches everything.

## Options and limits

| Option            | Default | Meaning                                                                       |
| ----------------- | ------- | ----------------------------------------------------------------------------- |
| `nodeKey`         | none    | The key properties by label ([above](#keys)).                                 |
| `onConflict`      | `merge` | What a node whose key exists does: `merge`, `replace`, `ignore`, or `error`.  |
| `missingEndpoint` | `skip`  | What a relationship with an end that matches no node does: `skip` or `error`. |
| `chunkSize`       | 5,000   | Input rows per statement.                                                     |

The graph's [limits](safe-execution.md) apply: `maxCreatedEntities` (100,000 by default) bounds the nodes plus relationships of one call, checked before anything is written, and `timeoutMs` (30 seconds) is checked between statements. Raise them on the writing graph for larger calls, or split the input into several calls. Invalid input fails with `CypherArgumentError` or `CypherTypeError` before anything is written, with a message that names the input, such as `nodes[3].properties: Property "age" is declared as integer in the mapping, but the value is the string "x"`.

## How it works

For each label with a key, and each chunk of its nodes, the call runs a `SELECT` that joins the chunk (one JSON parameter) to the node table on the label and the key, then one `UPDATE` of the nodes it found, and one `INSERT ... SELECT` of the rest, with the other nodes. For relationships, a `SELECT` of the start and end ids of each chunk, then one `INSERT ... SELECT`. Ids come from the database, or from the `generator` [id strategy](../DESIGN.md#ids-write-mode).

Between the `SELECT` and the `INSERT`, another transaction can insert the same key, as with Cypher's `MERGE`. Declare the key's index `unique: true` to make such a race fail the call (with `CypherConstraintError` `ConstraintValidationFailed`; retrying it then finds the node) instead of storing two nodes with the key. MySQL has no index for string keys ([schema](schema.md#composite-and-unique-indexes)), so there a string key is neither fast nor protected by a unique index; use integer keys there.

## Speed

`npm run bench:writes` (nodes keyed by an integer `doc` and `key` with a composite index; batches of 1,000 on SQLite and 10,000 on PostgreSQL and MySQL, which run at the same rate at 1,000), rows per second:

| Workload                   | SQLite | PostgreSQL |  MySQL |
| -------------------------- | -----: | ---------: | -----: |
| `bulkWrite`, nodes new     | 47,679 |     21,196 | 22,653 |
| `bulkWrite`, nodes exist   | 39,272 |     20,800 | 24,682 |
| `bulkWrite`, relationships | 35,211 |     10,878 | 14,008 |

The same nodes through `UNWIND $rows AS row MERGE (n:Item {key: row.key}) SET n += row.props` run at 180–830 rows per second. On PostgreSQL, about 80% of a relationship `INSERT` is the foreign-key checks of its two ends.
