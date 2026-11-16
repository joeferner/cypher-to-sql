# cypher-to-sql

Run [openCypher](https://opencypher.org/) queries against a property graph stored in plain relational tables. The library parses a query, plans it as parameterized SQL, runs it through an executor you supply, and assembles the rows into Cypher values (nodes, relationships, paths, lists, maps, scalars).

- **No graph extension required.** Works where Apache AGE and similar extensions are not available, such as managed PostgreSQL or SQLite.
- **Read-only by default.** A read-only graph can only emit `SELECT`, and every literal becomes a bind parameter.
- **Bring your own driver.** The library has no runtime dependency on a database driver.

Reads and writes openCypher 9 on PostgreSQL, SQLite, and MySQL 8, and passes 93–99.97% of the [openCypher TCK](#conformance) depending on the database. What it does not support fails with an error that says so, usually with a hint for a rewrite; see [Limitations](#limitations). [DESIGN.md](DESIGN.md) explains how it works.

## Usage

Copy an executor for your driver from [examples/executors](examples/executors), create the tables with `migrate` (or the DDL that `schemaSql` returns; see [Schema](docs/schema.md#creating-and-upgrading-the-tables)), and create a graph:

```ts
import pg from 'pg';
import { createGraph, migrate, postgres, toJson } from 'cypher-to-sql';
import { pgExecutor } from './executors/pg.js'; // from examples/executors/pg.ts

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// Creates the tables, or upgrades them; safe to run again (at deploy, with a role that may create tables)
await migrate({ dialect: postgres(), executor: pgExecutor(pool) });
const graph = createGraph({ dialect: postgres(), executor: pgExecutor(pool) }); // read-only by default

const records = await graph.query('MATCH (p:Person) RETURN p, p.name AS name LIMIT $n', { n: 10 });
// Integers come back as bigint: toJson(records) gives plain JSON (docs/values.md)
console.log(JSON.stringify(toJson(records)));

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

For SQLite, use `sqlite()` with the [`better-sqlite3`](examples/executors/better-sqlite3.ts) or [`node:sqlite`](examples/executors/node-sqlite.ts) executor. For MySQL 8.0.17 or newer, use `mysql()` with the [`mysql2`](examples/executors/mysql2.ts) executor, which sets the session options the dialect needs (see [Executors](docs/executors.md#mysql-settings)).

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

- [Executors](docs/executors.md): what an executor does, and tested ones for `pg`, `better-sqlite3`, `node:sqlite`, and `mysql2`.
- [Values](docs/values.md): the JavaScript types of results and parameters, and `toJson` for plain JSON.
- [Schema](docs/schema.md): the tables, `migrate`, the mapping and table prefixes, indexes, and declared property types.
- [Safe execution](docs/safe-execution.md): running untrusted or generated queries, database roles, timeouts, and limits.
- [Errors](docs/errors.md): the error classes, their hints, and a retry loop for generated queries.
- [Design](DESIGN.md): how queries become SQL.

## Limitations

The language is openCypher 9, plus `=~`, `shortestPath()`, `allShortestPaths()`, map projections, and `EXISTS { }` as in Neo4j. Not supported:

- **Constructs of later Cypher versions:** `CALL { }` subqueries, `COUNT { }` and `COLLECT { }`, `reduce()`, `LOAD CSV`, `USE`, dynamic labels, and schema commands (indexes and constraints are created in SQL). Their syntax errors carry a hint with a rewrite.
- **Some functions:** `stDev()`, `stDevP()`, `cot()`, the hyperbolic functions, `degrees()`, `radians()`, `haversin()`, `timestamp()`, `elementId()`, `randomUUID()`, `toIntegerList()` and the other list conversions, spatial `point()`, and a few others. The error lists the supported ones.
- **Built-in procedures:** `CALL` runs only the [procedures you register](#usage), with literal or parameter arguments.
- **A few combinations,** each with its own `UnsupportedFeatureError`, such as a named path in `CREATE` or `shortestPath()` inside `EXISTS`.

Each database has its own limits:

- **SQLite** has no NaN (`0.0 / 0.0` is null). Unicode `toUpper()` and `toLower()`, `=~`, and temporal functions of values from the query need [the library's functions registered](docs/executors.md#sqlite-settings).
- **MySQL** runs temporal functions and arithmetic only on literals and parameters, not on values from the query (`date(n.since)` is an `UnsupportedFeatureError`). It has no NaN, compares JSON integers beyond 2^53 imprecisely, takes only a literal or a parameter in `SKIP` and `LIMIT`, and doesn't use an index for a declared string property, so a lookup by one scans (see [Performance](#performance)). It also needs [session settings](docs/executors.md#mysql-settings).
- **Deep variable-length patterns** on large graphs can hit the `maxRowsPerStep` [limit](docs/safe-execution.md#limits) on every database (shortest paths between a few pairs of nodes search from both ends and rarely do); see [Performance](#performance).

## Development

```sh
git submodule update --init   # openCypher grammar and TCK
npm install
npm run db:up                 # PostgreSQL (localhost:55432) and MySQL (localhost:53306) in Docker
npm test                      # unit tests + allow-listed TCK scenarios, on SQLite, PostgreSQL, and MySQL
npm run test:tck:all          # every TCK scenario; passing ids go to tmp/tck-passing-*.json
npm run pre-commit            # format, lint, typecheck, test
npm run bench                 # benchmarks on reference graphs (bench/README.md)
npm run db:up:reference       # PostgreSQL, Neo4j, and ArcadeDB
npm run test:diff             # differential tests against Neo4j and ArcadeDB (diff/README.md)
npm run db:down               # remove the containers
```

The tests need PostgreSQL running. They connect to `TEST_POSTGRES_URL`, which defaults to `postgres://cypher:cypher@localhost:55432/cypher`; the dev container points it at the host. Set `POSTGRES_VERSION` to change the version that `db:up` starts (default 18). They also need MySQL, at `TEST_MYSQL_URL` (default `mysql://cypher:cypher@localhost:53306/cypher`; `MYSQL_VERSION` picks the version, default 8.4). Each test file creates its own database there as root (password `TEST_MYSQL_ROOT_PASSWORD`, default `cypher`). `TEST_BACKENDS=mysql` (or any comma-separated list of `sqlite`, `postgres`, `mysql`) runs the unit tests on some dialects only. The differential tests also connect to `NEO4J_URL` (default `bolt://localhost:57687`) and `ARCADEDB_URL` (default `http://localhost:52480`).

## Conformance

Conformance is measured with the official [openCypher TCK](https://github.com/opencypher/openCypher/tree/main/tck). [test/tck/allow-list.json](test/tck/allow-list.json) lists the scenarios that must pass on each dialect.

| Dialect    | Passing scenarios |  Share |
| ---------- | ----------------: | -----: |
| SQLite     |     3,886 / 3,897 | 99.72% |
| PostgreSQL |     3,896 / 3,897 | 99.97% |
| MySQL      |     3,630 / 3,897 | 93.15% |

The passing scenarios are in the allow-list, so `npm test` keeps them passing. Counts are from `npm run test:tck:all` (2026-11-15), and each expanded scenario outline counts once.

- **SQLite** fails 10 scenarios that use NaN: SQLite has no NaN (`0.0 / 0.0` is null there).
- **All three** fail Match4 [4], which needs a 21-hop variable-length match, past the default `maxPathDepth` of 10.
- **MySQL** skips 253 scenarios because temporal functions and arithmetic on values from the query aren't supported there yet (those of literals and parameters work). It also has no NaN (10 scenarios), compares JSON integers beyond 2^53 imprecisely (2), and runs one scenario that sums a very large `range()` too slowly for the test timeout.

## Performance

The [benchmarks](bench/README.md) run one query corpus on SQLite, PostgreSQL, and MySQL through this library, and on Neo4j and ArcadeDB. On the large reference graph (100,000 nodes, 450,000 relationships), median milliseconds:

| Query                              | SQLite | PostgreSQL | MySQL | Neo4j | ArcadeDB |
| ---------------------------------- | -----: | ---------: | ----: | ----: | -------: |
| lookup by name (declared, indexed) |    0.3 |        1.2 | 110\* |   2.6 |      1.3 |
| lookup by name (undeclared)        |    102 |        115 |   320 |   2.3 |      1.3 |
| one hop from a named node          |    0.4 |        2.0 | 989\* |   2.3 |      1.7 |
| `ORDER BY ... LIMIT` over all      |    504 |        739 |   576 |    54 |      196 |
| `*1..3` from a named node          |     72 |        2.3 | 240\* |   2.2 |      3.1 |
| `shortestPath` to a far node       |    6.5 |         15 | 293\* |   3.2 |      3.2 |

\* MySQL scans for a declared string property: it does not use a functional index for one.

- **Lookups and short patterns from a known node** are as fast as the native engines, or faster, when the filtered properties are [declared](docs/schema.md#properties) and indexed. On MySQL that works for declared numbers, not strings.
- **Filters on undeclared properties** scan every node's JSON: about 50 times slower. Declare the keys that queries filter on.
- **Scans and aggregates over the whole graph** are 2–9 times slower than Neo4j, and often close to ArcadeDB. MySQL is slower than SQLite and PostgreSQL at them.
- **Shortest paths** search from both ends, as the native engines do, so a far shortest path takes milliseconds; each search depth is still one SQL statement.
- **Variable-length patterns on large or dense graphs** are the biggest gap: a deep `*` pattern enumerates paths, and can hit the `maxRowsPerStep` safety limit.

### Writes

`npm run bench:writes` ingests batches of 1,000 rows with one `UNWIND $rows AS row ...` query each, into a graph whose `key` is indexed (declared, for this library), after an untimed warm-up round. The same Cypher runs on Neo4j and ArcadeDB. Rows per second:

| Batch of 1,000                                                              | SQLite | PostgreSQL | MySQL |  Neo4j | ArcadeDB |
| --------------------------------------------------------------------------- | -----: | ---------: | ----: | -----: | -------: |
| `CREATE (:Item {key: row.key, name: row.name, ...})`                        | 10,453 |      3,447 | 3,780 | 10,820 |   35,567 |
| same, with `idStrategy` generator                                           | 12,976 |      5,729 | 7,619 |        |          |
| `CREATE (n:Item {key: row.key}) SET n += row.props`                         |    718 |        390 | 1,014 |  9,566 |   17,360 |
| `MERGE (n:Item {key: row.key}) SET n += row.props`, new                     |    317 |        173 |   292 | 23,282 |   13,144 |
| `MERGE` again, nodes exist                                                  |    261 |        139 |   207 |  7,719 |   22,769 |
| `MATCH (a {key: row.from}) MATCH (b {key: row.to}) CREATE (a)-[:LINK]->(b)` |    505 |        142 |   189 | 10,652 |   18,292 |

- **Write properties inline in `CREATE`.** It is one statement per row and as fast as Neo4j on SQLite; `SET n += row.props` adds two more statements and is 4–15 times slower.
- **Use `idStrategy: { kind: 'generator', ... }` for bulk loads:** plain `CREATE` gets up to 2 times faster.
- **`MERGE` and `MATCH` by a value from the row don't use the property index yet ([#77](https://github.com/joeferner/cypher-to-sql/issues/77)),** so they are 20–160 times slower than in Neo4j and ArcadeDB, and slow down as the graph grows (doubling a batch roughly triples its time; Neo4j and ArcadeDB stay flat). Until then, load nodes that are known to be new with `CREATE`, and run `MERGE` or relationship matches as one query per row with parameters (`MERGE (n:Item {key: $key})`), which stays linear: about 1,000 rows per second on SQLite.
- A single query is limited to 30 seconds (`timeoutMs`) and 100,000 created entities (`maxCreatedEntities`); raise them on the writing graph for larger batches.

These numbers come from one laptop (Intel i7-10510U), with the servers in Docker at the [compose](compose.yaml) settings. SQLite runs in-process, while the other engines pay a network round trip of about 2 ms. The full tables, the setup, and what the results imply are in [bench/README.md](bench/README.md#compared-with-neo4j-and-arcadedb-47) (writes: [bench/README.md](bench/README.md#writes-69)).

## License

[MIT](LICENSE)
