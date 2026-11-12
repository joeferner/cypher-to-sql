# cypher-to-sql

Run [openCypher](https://opencypher.org/) queries against a property graph stored in plain relational tables. The library parses a query, plans it as parameterized SQL, runs it through an executor you supply, and assembles the rows into Cypher values (nodes, relationships, paths, lists, maps, scalars).

- **No graph extension required.** Works where Apache AGE and similar extensions are not available, such as managed PostgreSQL or SQLite.
- **Read-only by default.** A read-only graph can only emit `SELECT`, and every literal becomes a bind parameter.
- **Bring your own driver.** The library has no runtime dependency on a database driver.

> **Status:** early development. Only a small subset of Cypher works today, on PostgreSQL and SQLite. Any unsupported construct fails with an `UnsupportedFeatureError`. See [DESIGN.md](DESIGN.md) for how it works and [GitHub issues](https://github.com/joeferner/cypher-to-sql/issues) for the roadmap and progress.

## Usage

```ts
import Database from 'better-sqlite3';
import { createGraph, sqlite, type SqlExecutor } from 'cypher-to-sql';

const db = new Database('graph.db');
db.defaultSafeIntegers(true); // Cypher integers are 64-bit; they come back as bigint

// A minimal executor. Run every step of a query in one transaction.
const executor: SqlExecutor = {
  async transaction(mode, fn) {
    db.exec(mode === 'read' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE');
    try {
      const result = await fn({
        query: async (sql, values) => {
          const stmt = db.prepare(sql);
          if (stmt.reader) return stmt.all(...values);
          stmt.run(...values);
          return [];
        },
      });
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  },
};

const graph = createGraph({ dialect: sqlite(), executor }); // readOnly: true by default

const records = await graph.query('MATCH (p:Person) RETURN p, p.name AS name LIMIT $n', { n: 10 });

// Inspect the SQL without running it
console.log(graph.compile('MATCH (p:Person) RETURN p LIMIT 5').explain());
```

The test executor in [test/support/sqlite.ts](test/support/sqlite.ts) is a more complete example. For example, it sets `PRAGMA query_only` on read transactions.

For PostgreSQL, use `postgres()` and an executor over your driver. [test/support/postgres.ts](test/support/postgres.ts) has one for `pg`. Read transactions use `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, so every step of a query sees the same snapshot. The same file has the DDL for the storage layout with `jsonb` columns.

### Writing

`CREATE` works only on a graph created with `readOnly: false`. Use a separate executor and database role for that graph, and never pass it untrusted queries.

```ts
const writer = createGraph({ dialect: sqlite(), executor, readOnly: false });
await writer.query("CREATE (:Person {name: 'Ada'})-[:KNOWS]->(:Person {name: 'Alan'})");
```

## Storage layout

The graph lives in one node table and one edge table. Labels and properties are stored as JSON. You can change the table and column names through the `mapping` option.

```sql
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY,
  labels TEXT NOT NULL,      -- JSON array of strings
  properties TEXT NOT NULL   -- JSON object
);
CREATE TABLE edges (
  id INTEGER PRIMARY KEY,
  start_id INTEGER NOT NULL REFERENCES nodes (id),
  end_id INTEGER NOT NULL REFERENCES nodes (id),
  type TEXT NOT NULL,
  properties TEXT NOT NULL   -- JSON object
);
CREATE INDEX edges_start_id ON edges (start_id);
CREATE INDEX edges_end_id ON edges (end_id);
CREATE INDEX edges_type ON edges (type);
```

## Errors

Every error the library raises on purpose extends `CypherError` and has a message, a source position, and an optional `hint`: `CypherSyntaxError`, `UnsupportedFeatureError`, `SemanticError`, `MappingError`, `LimitExceededError`, and `ReadOnlyViolationError`. The hints are written so that an automated retry loop (for example, an LLM generating queries) can fix the query.

## Development

```sh
git submodule update --init   # openCypher grammar and TCK
npm install
npm run db:up                 # PostgreSQL in Docker (compose.yaml), on localhost:55432
npm test                      # unit tests + allow-listed TCK scenarios, on SQLite and PostgreSQL
npm run test:tck:all          # every TCK scenario; passing ids go to tmp/tck-passing-*.json
npm run pre-commit            # format, lint, typecheck, test
npm run db:down               # remove the PostgreSQL container
```

The tests need PostgreSQL running. They connect to `TEST_POSTGRES_URL`, which defaults to `postgres://cypher:cypher@localhost:55432/cypher`; the dev container points it at the host. Set `POSTGRES_VERSION` to change the version that `db:up` starts (default 18).

Conformance is measured with the official [openCypher TCK](https://github.com/opencypher/openCypher/tree/main/tck). [test/tck/allow-list.json](test/tck/allow-list.json) lists the scenarios that must pass on each dialect.

## License

MIT
