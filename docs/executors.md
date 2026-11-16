# Executors

The library never opens a database connection. You give it a `SqlExecutor`, an object that runs SQL on your own driver:

```ts
interface SqlExecutor {
  transaction<T>(mode: 'read' | 'write', fn: (tx: SqlTx) => Promise<T>): Promise<T>;
}
interface SqlTx {
  query(sql: string, values: unknown[]): Promise<Record<string, unknown>[]>;
}
```

`graph.query()` calls `transaction` once per Cypher query and runs every SQL step of the query through `tx.query` inside it. The mode comes from the compiled plan: a query without write clauses is `'read'`, even on a graph created with `readOnly: false`.

Ready-to-use executors, tested against real databases in [test/examples.test.ts](../test/examples.test.ts):

| Driver           | File                                                                            | Dialect      |
| ---------------- | ------------------------------------------------------------------------------- | ------------ |
| `pg`             | [examples/executors/pg.ts](../examples/executors/pg.ts)                         | `postgres()` |
| `better-sqlite3` | [examples/executors/better-sqlite3.ts](../examples/executors/better-sqlite3.ts) | `sqlite()`   |
| `node:sqlite`    | [examples/executors/node-sqlite.ts](../examples/executors/node-sqlite.ts)       | `sqlite()`   |
| `mysql2`         | [examples/executors/mysql2.ts](../examples/executors/mysql2.ts)                 | `mysql()`    |

```ts
import pg from 'pg';
import { createGraph, postgres } from 'cypher-to-sql';
import { pgExecutor } from './executors/pg.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const graph = createGraph({ dialect: postgres(), executor: pgExecutor(pool) });
const rows = await graph.query('MATCH (p:Person) RETURN p.name AS name LIMIT 10');
```

## What an executor must do

- **One transaction per call.** Run `BEGIN` before `fn` and `COMMIT` after it, or `ROLLBACK` if it throws, and rethrow the error. A query can run several SQL steps (a shortest path search runs one per depth, and `CREATE` one per entity), and they must all see the same data.
- **A consistent snapshot for reads.** On PostgreSQL, start read transactions with `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`: every step sees the same snapshot, and PostgreSQL refuses any write. SQLite gives each transaction its own snapshot anyway; `PRAGMA query_only = ON` makes it refuse writes.
- **Writes take the lock up front.** On SQLite, `BEGIN IMMEDIATE` for writes, so that a write transaction does not fail halfway when another connection writes.
- **One transaction at a time per connection.** `graph.query()` is async, and two queries can be in flight at once. With a pool (`pg`), take one client per transaction. With a single SQLite connection, queue the transactions, as the SQLite examples do.
- **64-bit integers.** Values the library binds can be `bigint`. The `pg` example binds them as text, which PostgreSQL casts exactly. Read integers back as `bigint` on SQLite (`safeIntegers` in `better-sqlite3`, `setReadBigInts` in `node:sqlite`); otherwise values above 2^53 lose precision. `pg` returns `bigint` columns as strings, which the library reads exactly.
- **Rows as objects keyed by column name.** The library reads the columns it selected by name.
- **Reuse prepared statements, if the driver allows it cheaply.** A write runs the same SQL for every row of a batch. The SQLite examples keep their last 100 prepared statements, which halves the cost of a batched `MERGE`. The `mysql2` example has the driver's own cache (`maxPreparedStatements`). The `pg` example does not: named statements stay on the server, one per distinct SQL text.
- **Errors unchanged.** Rethrow the driver's error. The library recognizes the errors that its SQL raises on purpose (run-time type errors, integer overflow) and turns them into `CypherTypeError` and `CypherArgumentError`; see [Errors](errors.md).

## PostgreSQL settings

The `pg` example also runs, after `BEGIN`:

- `SET LOCAL statement_timeout = <ms>`: a limit for each SQL step. The library's own `timeoutMs` limit is checked only between steps.
- `SET LOCAL jit = off`: expressions on JSON lists use set-returning functions and recursive CTEs with high row estimates, which can trigger JIT compilation that takes hundreds of milliseconds for a query that runs in under one. You can turn JIT off for the role instead.

## SQLite settings

- Use SQLite 3.44 or later (for `ORDER BY` inside aggregates) with the JSON and math functions, which are on in the builds of `better-sqlite3` and `node:sqlite`.
- For a graph that only reads, open the connection read-only (`new Database(path, { readonly: true })`, or `new DatabaseSync(path, { readOnly: true })`). The examples also set `PRAGMA query_only` on read transactions, which protects a shared connection.
- `node:sqlite` is available without a flag from Node.js 22.13. It is still marked experimental and prints a warning when loaded.
- SQLite's `upper()` and `lower()` change ASCII letters only, SQLite has no regular expressions, and it has no calendar or time-zone rules. For `toUpper` and `toLower` to follow Unicode, as in Cypher, for `=~`, and for temporal functions of values from the query (`date(n.since)`; those of literals and parameters always work), register the library's functions on the connection and use `sqlite({ functions: true })`:

  ```ts
  import Database from 'better-sqlite3';
  import { createGraph, registerSqliteFunctions, sqlite } from 'cypher-to-sql';

  const db = new Database('graph.db');
  registerSqliteFunctions(db); // also takes a node:sqlite DatabaseSync
  const graph = createGraph({
    dialect: sqlite({ functions: true }),
    executor: betterSqliteExecutor(db),
  });
  ```

  With the option and without the functions, queries that use them fail with SQLite's `no such function` error.

## MySQL settings

- Use MySQL 8.0.17 or later (`JSON_TABLE`, `LATERAL`, recursive CTEs, `JSON_OVERLAPS`), with the tables of [examples/schema/mysql.sql](../examples/schema/mysql.sql).
- Create the `mysql2` pool with `supportBigNumbers: true, bigNumberStrings: true`, so that 64-bit integers come back exactly, and with a low `maxPreparedStatements` (such as 64). The executor runs each step as a prepared statement, and every distinct query is a different SQL text. mysql2's default cache keeps up to 16,000 of them per connection on the server, which costs gigabytes of server memory, and MySQL allows only 16,382 prepared statements in all (`max_prepared_stmt_count`).
- Run the session settings that the dialect needs on each connection. The example executor runs them (`MYSQL_SESSION`) at the start of every transaction:

  ```sql
  SET SESSION sql_mode = CONCAT(REPLACE(@@sql_mode, 'ONLY_FULL_GROUP_BY', ''), ',PIPES_AS_CONCAT'),
      NAMES utf8mb4 COLLATE utf8mb4_bin,
      SESSION group_concat_max_len = 1073741824,
      SESSION cte_max_recursion_depth = 4294967295
  ```

  `||` then concatenates strings, the grouped queries the planner writes are accepted, strings are case-sensitive, lists built with `GROUP_CONCAT` aren't cut short, and `range()` and `split()` can go past 1,000 elements.

- MySQL has no `RETURNING`: for an `INSERT`, return one row `{ id: insertId }` (the example's `runMysqlStep` does), and `[]` for other statements that return no rows.
- Read transactions use `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`, so every step sees the same data and MySQL refuses writes. `max_execution_time` limits each step.

See [Safe execution](safe-execution.md) for database roles and limits, and [Schema](schema.md) for the tables.
