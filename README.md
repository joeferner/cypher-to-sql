# cypher-to-sql

Run [openCypher](https://opencypher.org/) queries against a property graph stored in plain relational tables. The library parses a query, plans it as parameterized SQL, runs it through an executor you supply, and assembles the rows into Cypher values (nodes, relationships, paths, lists, maps, scalars).

- **No graph extension required.** Works where Apache AGE and similar extensions are not available, such as managed PostgreSQL or SQLite.
- **Read-only by default.** A read-only graph can only emit `SELECT`, and every literal becomes a bind parameter.
- **Bring your own driver.** The library has no runtime dependency on a database driver.

> **Status:** early development. Only a small subset of Cypher works today, on PostgreSQL and SQLite. Any unsupported construct fails with an `UnsupportedFeatureError`. See [DESIGN.md](DESIGN.md) for how it works and [GitHub issues](https://github.com/joeferner/cypher-to-sql/issues) for the roadmap and progress.

## Usage

Create the two tables ([PostgreSQL](examples/schema/postgres.sql), [SQLite](examples/schema/sqlite.sql)), copy an executor for your driver from [examples/executors](examples/executors), and create a graph:

```ts
import pg from 'pg';
import { createGraph, postgres } from 'cypher-to-sql';
import { pgExecutor } from './executors/pg.js'; // from examples/executors/pg.ts

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const graph = createGraph({ dialect: postgres(), executor: pgExecutor(pool) }); // read-only by default

const records = await graph.query('MATCH (p:Person) RETURN p, p.name AS name LIMIT $n', { n: 10 });

// Inspect the SQL without running it
console.log(graph.compile('MATCH (p:Person) RETURN p LIMIT 5').explain());
```

For SQLite, use `sqlite()` with the [`better-sqlite3`](examples/executors/better-sqlite3.ts) or [`node:sqlite`](examples/executors/node-sqlite.ts) executor.

`CREATE` works only on a graph created with `readOnly: false`. Use a separate executor and database role for that graph, and never pass it untrusted queries:

```ts
const writer = createGraph({
  dialect: postgres(),
  executor: pgExecutor(writePool),
  readOnly: false,
});
await writer.query("CREATE (:Person {name: 'Ada'})-[:KNOWS]->(:Person {name: 'Alan'})");
```

## Documentation

- [Executors](docs/executors.md): what an executor does, and tested ones for `pg`, `better-sqlite3`, and `node:sqlite`.
- [Schema](docs/schema.md): the tables, the mapping, indexes, and declared property types.
- [Safe execution](docs/safe-execution.md): running untrusted or generated queries, database roles, timeouts, and limits.
- [Errors](docs/errors.md): the error classes, their hints, and a retry loop for generated queries.
- [Design](DESIGN.md): how queries become SQL.

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
