# Safe execution

A main use of the library is running queries you did not write, for example queries an LLM generates. Treat each such query as untrusted, and use several layers of defense:

1. **The library.** A graph is read-only by default; its planner has no code that emits anything but `SELECT`. Every literal and parameter is a bind value, and table and column names come only from the mapping, which must be plain identifiers. Query text never becomes SQL text.
2. **The database.** A role or connection that can only read the graph's tables.
3. **Limits.** Row, step, and time limits in the library, and a statement timeout in the database.

## Read-only graphs

`createGraph` makes a read-only graph unless you pass `readOnly: false`. On a read-only graph, a query with `CREATE` (or `MERGE`, `SET`, `DELETE`, ...) fails with `ReadOnlyViolationError` before any SQL is built. `assertReadOnly(cypher)` runs the same check without a graph.

For writes, make a separate graph with `readOnly: false` and its own executor and database role. Never pass it untrusted queries. A query without write clauses still runs in a `'read'` transaction on a write graph.

Procedures you register (`createGraph({ procedures })`) can be called from a read-only graph, with arguments that the query chooses. They run your TypeScript, not SQL, so the database role doesn't limit them. Register only procedures that are safe for anyone who can send queries, and check their arguments.

## PostgreSQL role

Give the executor of a read-only graph a role that can only read the graph's tables, and set its defaults there, so they hold even if an executor forgets them:

```sql
CREATE ROLE graph_reader LOGIN PASSWORD '...';
GRANT USAGE ON SCHEMA graph TO graph_reader;
GRANT SELECT ON graph.nodes, graph.edges TO graph_reader;
ALTER ROLE graph_reader SET default_transaction_read_only = on;
ALTER ROLE graph_reader SET statement_timeout = '5s';
ALTER ROLE graph_reader SET jit = off;
```

The [`pg` executor](../examples/executors/pg.ts) also starts read transactions with `READ ONLY` and sets `statement_timeout` and `jit` for each transaction.

## SQLite connection

Open the connection of a read-only graph read-only, so SQLite refuses every write:

```ts
const db = new Database('graph.db', { readonly: true }); // better-sqlite3
const db = new DatabaseSync('graph.db', { readOnly: true }); // node:sqlite
```

The [SQLite executors](executors.md) also set `PRAGMA query_only` in read transactions, which protects a connection that is shared with writes.

SQLite has no statement timeout, so keep the library's limits low for SQLite graphs that run untrusted queries.

## Limits

Each graph has limits; a query can lower them but never raise them. Exceeding a limit raises `LimitExceededError`; results are never cut short silently.

| Limit                | Default | What it bounds                                                                            |
| -------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `maxPathDepth`       | 10      | Upper bound of `[*]` and `[*n..]`; an explicit upper bound above it is an error.          |
| `maxRowsPerStep`     | 100,000 | Rows one SQL step may return, and paths one variable-length pattern may find.             |
| `maxResultRows`      | 10,000  | Records a query may return.                                                               |
| `maxFrontierSize`    | 100,000 | Nodes a shortest path search carries from one depth to the next.                          |
| `maxSteps`           | 32      | SQL steps of a read query, including shortest path search depths.                         |
| `timeoutMs`          | 30,000  | Total time of a query, checked between SQL steps (use a statement timeout for each step). |
| `maxCreatedEntities` | 100,000 | Nodes and relationships one query creates.                                                |

```ts
const graph = createGraph({ dialect, executor, limits: { maxResultRows: 1000, timeoutMs: 5000 } });

// Lower them further for one query
await graph.query(cypher, params, { limits: { maxPathDepth: 4 } });
```

For untrusted queries, keep the limits at or below the defaults, and set a statement timeout in the database: the library's `timeoutMs` cannot stop a single SQL statement. The defaults were checked on graphs of up to 100,000 nodes (see [the benchmarks](../bench/README.md#limits)): the main risk is a variable-length pattern on a dense graph, whose number of paths grows with the degree to the power of the depth, and `maxRowsPerStep` stops it.

## Before running a query

- `graph.compile(cypher)` parses and plans a query without touching the database. It throws the same syntax, semantic, unsupported-feature, and read-only errors that `query` would, and `explain()` shows the SQL.
- Pass values as parameters (`$name`), not by building Cypher text.
- Catch `CypherError` and feed its message and `hint` back to the generator; see [Errors](errors.md).
