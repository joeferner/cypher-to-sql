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

`CALL` works with procedures you register. They're read-only TypeScript functions that return rows, and there are no built-in ones:

```ts
const graph = createGraph({
  dialect: postgres(),
  executor: pgExecutor(pool),
  procedures: {
    'geo.lookup': {
      inputs: [{ name: 'code', type: 'STRING' }],
      outputs: [{ name: 'country', type: 'STRING' }],
      call: ({ code }) => (code === 'SE' ? [{ country: 'Sweden' }] : []),
    },
  },
});
await graph.query("CALL geo.lookup('SE') YIELD country RETURN country");
```

For SQLite, use `sqlite()` with the [`better-sqlite3`](examples/executors/better-sqlite3.ts) or [`node:sqlite`](examples/executors/node-sqlite.ts) executor.

`CREATE`, `MERGE`, `SET`, `REMOVE`, `DELETE`, and `FOREACH` work only on a graph created with `readOnly: false`. Use a separate executor and database role for that graph, and never pass it untrusted queries:

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
npm run bench                 # benchmarks on reference graphs (bench/README.md)
npm run db:up:reference       # PostgreSQL, Neo4j, and ArcadeDB
npm run test:diff             # differential tests against Neo4j and ArcadeDB (diff/README.md)
npm run db:down               # remove the containers
```

The tests need PostgreSQL running. They connect to `TEST_POSTGRES_URL`, which defaults to `postgres://cypher:cypher@localhost:55432/cypher`; the dev container points it at the host. Set `POSTGRES_VERSION` to change the version that `db:up` starts (default 18). The differential tests also connect to `NEO4J_URL` (default `bolt://localhost:57687`) and `ARCADEDB_URL` (default `http://localhost:52480`).

Conformance is measured with the official [openCypher TCK](https://github.com/opencypher/openCypher/tree/main/tck). [test/tck/allow-list.json](test/tck/allow-list.json) lists the scenarios that must pass on each dialect.

| Dialect    | Passing scenarios |  Share |
| ---------- | ----------------: | -----: |
| SQLite     |     3,886 / 3,897 | 99.72% |
| PostgreSQL |     3,896 / 3,897 | 99.97% |

3,886 scenarios pass on both dialects. They are all in the allow-list, so `npm test` keeps them passing. The 10 that pass only on PostgreSQL use NaN: SQLite has no NaN (`0.0 / 0.0` is null there). The one that fails on both, Match4 [4], needs a 21-hop variable-length match, past the default `maxPathDepth` of 10. Counts are from `npm run test:tck:all` (2026-11-15), and each expanded scenario outline counts once.

## Performance

The [benchmarks](bench/README.md) run one query corpus on SQLite and PostgreSQL through this library, and on Neo4j and ArcadeDB. On the large reference graph (100,000 nodes, 450,000 relationships), median milliseconds:

| Query                              | SQLite | PostgreSQL | Neo4j | ArcadeDB |
| ---------------------------------- | -----: | ---------: | ----: | -------: |
| lookup by name (declared, indexed) |    0.3 |        1.2 |   2.6 |      1.3 |
| lookup by name (undeclared)        |    102 |        115 |   2.3 |      1.3 |
| one hop from a named node          |    0.4 |        2.0 |   2.3 |      1.7 |
| `ORDER BY ... LIMIT` over all      |    504 |        739 |    54 |      196 |
| `*1..3` from a named node          |     72 |        2.3 |   2.2 |      3.1 |
| `shortestPath` to a far node       |  limit |      limit |   3.2 |      3.2 |

- **Lookups and short patterns from a known node** are as fast as the native engines, or faster, when the filtered properties are [declared](docs/schema.md#properties) and indexed.
- **Filters on undeclared properties** scan every node's JSON: about 50 times slower. Declare the keys that queries filter on.
- **Scans and aggregates over the whole graph** are 2–9 times slower than Neo4j, and often close to ArcadeDB.
- **Deep path searches on large or dense graphs** are the biggest gap. On the large graph, the far shortest path above hits the `maxRowsPerStep` safety limit, while the native engines follow adjacency in 3 ms.

These numbers come from one laptop (Intel i7-10510U), with the servers in Docker at the [compose](compose.yaml) settings. SQLite runs in-process, while the other engines pay a network round trip of about 2 ms. The full tables, the setup, and what the results imply are in [bench/README.md](bench/README.md#compared-with-neo4j-and-arcadedb-47).

## License

[MIT](LICENSE)
