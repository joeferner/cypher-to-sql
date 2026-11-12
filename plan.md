# Plan: openCypher to SQL translator (TypeScript)

## Goal

A TypeScript library that runs openCypher queries against a property graph stored in relational tables. It parses a query, plans it as one or more parameterized SQL statements, runs them through a caller-supplied executor, and assembles the rows into Cypher-style results (nodes, relationships, paths, scalars, lists, maps).

Version 1 targets **PostgreSQL** (including managed PostgreSQL such as AWS RDS and Aurora, where graph extensions like Apache AGE are not available) and **SQLite**. SQLite also makes the test suite fast, because it runs in-process.

Version 1 is read-only for applications. It also supports `CREATE` behind an explicit write mode, so the conformance suite can build its test graphs with the translator itself.

## Why

- Teams that store a graph in plain relational tables cannot run Cypher against it without a graph extension or a separate graph database.
- Cypher is a better query language than recursive SQL for multi-hop questions, for both people and LLMs that generate queries.
- Read-only translation is safer than running user-supplied or generated SQL. In read-only mode the planner can only emit `SELECT`, and all literals become bind parameters.

## Scope

### Version 1

- Read-only openCypher in feature tiers (see below).
- `CREATE` of nodes and relationships, available only in write mode.
- Dialects: PostgreSQL and SQLite.
- The generic storage layout (see "Graph-to-relational mapping").
- Execution through a caller-supplied executor, with results assembled as Cypher values.

### Future goals

- **Other write clauses:** `MERGE`, `SET`, `DELETE`, `DETACH DELETE`, `REMOVE`, `FOREACH`.
- **Typed storage layout:** one table for each label or relationship type, with real columns for properties.
- **Other dialects**, for example MySQL 8 or SQL Server.
- **GQL** (ISO/IEC 39075), which is close to openCypher.

### Non-goals

- Procedures (`CALL`), APOC, vendor-specific functions, and `LOAD CSV`.
- Full openCypher conformance in version 1. Coverage grows in tiers, and every unsupported construct fails with a clear error.
- Schema management for application data. The library reads a mapping; it does not create application tables. (The test harness creates its own tables.)
- Database drivers, connections, and pooling. The caller executes the SQL with their own driver. The library has no runtime dependency on any database driver.

## Users and use cases

- An application that stores nodes and edges in PostgreSQL or SQLite and wants to let users, or an LLM, query them in Cypher.
- Generated queries are a main use case. Error messages must therefore say what was unsupported and suggest a rewrite, so that an automated retry loop can fix the query.

## Public API (draft)

```ts
// readOnly defaults to true. Write mode is readOnly: false (version 1: CREATE only).
const graph = createGraph({ dialect: postgres(), mapping, executor, readOnly: true });

// One entry point for every query. When readOnly is true, any write clause
// is rejected with ReadOnlyViolationError before planning.
const records = await graph.query(cypher, params);
// records: Array<Record<string, CypherValue>>, where CypherValue is
// Node | Relationship | Path | string | number | boolean | null | CypherValue[] | map

// Lower level, for inspection, logging, and tests. Same readOnly gate.
const plan = graph.compile(cypher);
plan.readOnly; // true when the query has no write clauses
plan.steps; // [{ sql, values, ... }] \u2014 usually one step
plan.explain(); // readable form of the plan

// Errors are typed: CypherSyntaxError, UnsupportedFeatureError, MappingError,
// SemanticError, LimitExceededError, ReadOnlyViolationError. Each has a message, the source position, and an optional `hint`.
```

The executor is a small interface that the caller implements over their own driver (`pg`, `better-sqlite3`, `node:sqlite`, and so on). The library does not ship driver adapters. The documentation includes short example executors, and the test harness has its own executors for `pg` and `better-sqlite3`.

```ts
interface SqlExecutor {
  transaction<T>(mode: 'read' | 'write', fn: (tx: SqlTx) => Promise<T>): Promise<T>;
}
interface SqlTx {
  query(sql: string, values: unknown[]): Promise<Row[]>;
}
```

The executor's transaction mode comes from the plan, not from the flag. A query with no write clauses runs in a `'read'` transaction even on a graph with `readOnly: false`.

Also export `parse(cypher)` (the AST) and `assertReadOnly(cypher)` for callers that only need the guard.

## Execution model: one or more statements

The planner turns a query into a **plan of one or more SQL steps**. A single statement is the default. The planner uses several steps when that is faster or simpler:

- **Shortest path:** breadth-first search, one step for each depth, that stops as soon as it reaches the target (or meets in the middle when it searches from both ends). A recursive CTE cannot stop early in the same way.
- **Large `WITH` stages:** materialize an intermediate result once, instead of repeating it inside several subqueries.
- **Entity hydration:** first find the matching ids, then fetch the full nodes and relationships in one batched step.

Rules:

- All steps of one query run in **one transaction**, so every step sees the same data.
  - PostgreSQL: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`.
  - SQLite: one read transaction on a connection opened read-only (or with `PRAGMA query_only`).
- Intermediate results go to the next step as **bound arrays**, not temp tables. PostgreSQL does not allow `CREATE TEMP TABLE` in a read-only transaction.
  - PostgreSQL: `= ANY($1)`.
  - SQLite: `IN (SELECT value FROM json_each(?))`.
- Limits (see "Limits") apply to every step and to the whole query. When a limit is exceeded, the query fails with `LimitExceededError`. It never returns silently truncated results.
- **Results are assembled in TypeScript.** Each SQL step can use whatever column shape is easiest (ids, JSON objects, arrays). The assembler builds the final Cypher values, so the result matches what a graph database would return, including paths and nested lists.

## Graph-to-relational mapping (generic layout)

Version 1 uses one fixed shape, the **generic layout**. The mapping configures the table and column names, so the library works with an existing database that uses this shape.

| Table      | Columns                                                               |
| ---------- | --------------------------------------------------------------------- |
| Node table | id, labels (JSON array), properties (JSON object)                     |
| Edge table | id, start node id, end node id, type (text), properties (JSON object) |

- JSON is `jsonb` on PostgreSQL and JSON text on SQLite (JSON1 functions).
- Optional declared property types (`string`, `integer`, `float`, `boolean`, `date`, `datetime`), used for casts from JSON. Undeclared properties use a documented comparison rule.
- An optional schema or table prefix, so that one mapping can serve many isolated graphs.
- Recommended indexes: edge start id, edge end id, edge type, and expression or GIN indexes for frequently filtered properties. The documentation includes DDL for both dialects.

## Id generation (write mode)

The id strategy is configurable:

```ts
idStrategy:
  | { kind: 'database' }                                       // default
  | { kind: 'generator'; generate: (entity: 'node' | 'relationship') => string | number }
```

- **Database:** the id column is generated by the database (an identity column on PostgreSQL, `INTEGER PRIMARY KEY` on SQLite). Each `INSERT` uses `RETURNING id` so that later parts of the pattern can refer to the new entity. PostgreSQL does not guarantee the row order of `RETURNING` for a multi-row insert, so version 1 inserts one entity per statement in this mode. `CREATE` is mainly for test setup, so speed is not a goal here.
- **Generator:** the library calls the caller's function before it inserts, so it knows every id up front and can batch the inserts (for example, UUIDs or ids from a sequence service).
- Ids that the query supplies as properties are ordinary properties. They never replace the internal id.

## Limits

All limits are configurable for each graph and can be lowered for each query. These are the defaults:

| Limit                | Default | Behavior                                                                                                                                                    |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxPathDepth`       | 10      | Upper bound for `[*]` and `[*n..]`. A query with an explicit upper bound above it is rejected.                                                              |
| `maxRowsPerStep`     | 100,000 | Each step is emitted with `LIMIT maxRowsPerStep + 1`. Getting the extra row means the limit is exceeded.                                                    |
| `maxResultRows`      | 10,000  | Final records. The error hint suggests adding `LIMIT` to the query.                                                                                         |
| `maxFrontierSize`    | 100,000 | Ids carried from one breadth-first search step to the next                                                                                                  |
| `maxSteps`           | 32      | SQL steps in one plan, including breadth-first search depths                                                                                                |
| `timeoutMs`          | 30,000  | Total wall-clock time, checked between steps. Timeouts for single statements belong to the caller's executor (for example, PostgreSQL `statement_timeout`). |
| `maxCreatedEntities` | 100,000 | Nodes plus relationships created by one query (write mode only)                                                                                             |

## Architecture

```
Cypher text
  \u2192 Parser (ANTLR4 openCypher grammar, antlr4ng runtime)
  \u2192 AST (typed, positions kept)
  \u2192 Mode and feature gate (read mode rejects writes; reject constructs outside the enabled tiers)
  \u2192 Semantic analysis (variable scopes, types, aggregation grouping, path variables)
  \u2192 Logical plan (scans, expands, filters, projections, aggregates, path search, create)
  \u2192 Physical plan (split into SQL steps; pick a CTE or iterative strategy for each path search)
  \u2192 Dialect emitter (PostgreSQL, SQLite)
  \u2192 Executor (one transaction) \u2192 Result assembler \u2192 Cypher values
```

Notes:

- Use the official openCypher ANTLR4 grammar. Do not parse with regular expressions.
- The logical plan does not depend on the dialect. Physical planning and emitting do. Having two dialects from the start keeps this boundary honest.
- Every literal in the query becomes a bind parameter. Identifiers come only from the mapping, never from the query text, so the output cannot contain injected SQL.
- The `readOnly` flag is checked twice. The gate rejects write clauses in the AST, and a graph made with `readOnly: true` builds its planner without write operators. So it cannot produce a write statement, even through a bug in the gate.

## Translation rules (core)

| Cypher                                                      | SQL                                                                                                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node pattern `(a:Label {k: v})`                             | Scan of the node table, with a label filter and property filters                                                                                    |
| Fixed relationship `-[r:T]->`                               | Join to the edge table on start and end ids                                                                                                         |
| Undirected `-[r]-`                                          | Join on either direction (`OR` or `UNION ALL`), without double counting                                                                             |
| Several relationship variables in one `MATCH`               | Add `r1.id <> r2.id` for each pair (relationship uniqueness)                                                                                        |
| `WHERE` expressions                                         | SQL expressions with Cypher null semantics and safe casts                                                                                           |
| `RETURN`, `DISTINCT`, `ORDER BY`, `SKIP`, `LIMIT`           | Direct equivalents                                                                                                                                  |
| Aggregates (`count`, `sum`, `avg`, `min`, `max`, `collect`) | SQL aggregates. Non-aggregated return items become the `GROUP BY` (implicit grouping). `collect` becomes a JSON array aggregate with nulls removed. |
| Variable length `[*1..n]`                                   | Recursive CTE with arrays of visited ids and a required upper bound, or iterative steps                                                             |
| `shortestPath` / `allShortestPaths`                         | Iterative breadth-first search steps, or a recursive CTE stopped at the first depth that reaches the target                                         |
| `nodes(p)`, `relationships(p)`, `length(p)`                 | Built from the path id arrays and hydrated by the assembler                                                                                         |
| `OPTIONAL MATCH`                                            | PostgreSQL: `LEFT JOIN LATERAL`. SQLite: `LEFT JOIN` with correlated conditions, or a separate step.                                                |
| `WITH`                                                      | CTE or subquery for each stage, or a separate step for large stages                                                                                 |
| `UNWIND`                                                    | PostgreSQL: `jsonb_array_elements`. SQLite: `json_each`.                                                                                            |
| Pattern predicates, `EXISTS { }`                            | `EXISTS (SELECT ...)`                                                                                                                               |
| `CREATE` (write mode)                                       | `INSERT` into the node and edge tables, in pattern order, in one write transaction                                                                  |

## Dialect differences to plan for

| Topic                 | PostgreSQL                                             | SQLite                                                                                |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Correlated joins      | `LATERAL`                                              | No `LATERAL`. Use correlated subqueries, table-valued `json_each`, or separate steps. |
| Arrays                | Native arrays and `jsonb`                              | JSON text only                                                                        |
| Path cycle check      | Array containment on the path                          | `instr` or `json_each` on a JSON path string                                          |
| Typing                | Strict types; a failed cast raises an error            | Type affinity; values can change type silently                                        |
| `LIKE`                | Case sensitive                                         | Case-insensitive for ASCII. Use `instr` / `substr` for `CONTAINS` and `STARTS WITH`.  |
| Read-only enforcement | `READ ONLY` transaction plus a role with only `SELECT` | Read-only connection or `PRAGMA query_only`                                           |
| Integer size          | `bigint`, with overflow errors                         | 64-bit integers; overflow changes the value to a float                                |

## Behavior that needs care

- **Null semantics.** Cypher and SQL mostly agree on three-valued logic. Lists, maps, and `IN` with nulls do not always agree. Test each case.
- **Failed casts** return null in Cypher. Use safe-cast helpers in both dialects.
- **Numbers.** Cypher integer division truncates, and integer overflow is an error. Map these exactly in both dialects.
- **Mixed-type comparisons** return null in Cypher. SQL raises an error or converts the type.
- **Sort order.** Cypher defines a global order across types. Pin null ordering explicitly.
- **Strings.** Comparison is case sensitive. Use a binary collation explicitly.
- **Unbounded paths.** `[*]` without an upper bound is rejected or capped by a configurable maximum depth.

## Feature tiers

| Tier               | Scope                                                                                                                                                                                                                  | Done when                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **0. Skeleton**    | Parser, AST, mode gate, error types, mapping validation, limits, executor interface, both emitters for `MATCH (n) RETURN n LIMIT k`, `CREATE` of nodes and relationships with literal properties (write mode)          | The TCK harness loads scenario graphs with `CREATE` on both dialects           |
| **1. Core**        | Fixed-length patterns in all directions, `WHERE`, `RETURN` with aliases, `DISTINCT`, `ORDER BY`, `SKIP`, `LIMIT`, aggregates with implicit grouping, common scalar and string functions, parameters                    | The tier 1 TCK allow-list passes on both dialects                              |
| **2. Paths**       | Variable-length patterns, `shortestPath`, `allShortestPaths`, named paths and path functions, multi-step plans                                                                                                         | The tier 2 allow-list passes, and benchmarks meet targets on a reference graph |
| **3. Composition** | `OPTIONAL MATCH`, `WITH`, `UNWIND`, `CASE`, pattern predicates, `EXISTS { }`, list comprehensions, map projections, temporal functions. `UNWIND` and `MATCH` combined with `CREATE`, which TCK setup scripts also use. | Added one at a time, in the order real query logs and TCK setup needs show     |

Release 1.0 is tiers 0\u20132 plus `OPTIONAL MATCH`, `WITH`, and `UNWIND` from tier 3.

## Testing

1. **Unit tests** (vitest) for each stage: parse, semantic analysis, logical and physical plans, and emitted SQL snapshots for each dialect.
2. **openCypher TCK.** The official conformance suite (`tck/features/` in the `opencypher/openCypher` repository, Apache 2.0) is a set of Gherkin feature files.
   - Parse them with `@cucumber/gherkin` and generate one vitest test for each scenario and dialect. A full Cucumber runtime is not necessary.
   - Run each scenario's setup through a graph made with `readOnly: false` (`CREATE`), and run the scenario's query through a separate graph made with `readOnly: true`. This also tests the gate on every scenario. A setup script that uses a construct not supported yet marks the scenario as skipped, with that reason.
   - Write a formatter from assembled results to the TCK's value notation (`(:A {k: 1})`, `[:T]`, `<(...)-[...]->(...)>`). Support both "in any order" and "in order" comparisons.
   - Keep a checked-in allow-list of passing scenario ids, grouped by tier and dialect. CI fails when a listed scenario fails, and the list grows with coverage.
   - Scenarios that expect a compile-time error confirm that unsupported or invalid queries are rejected.
   - SQLite runs in-process through `better-sqlite3` (a dev dependency only), with an in-memory database for each scenario, so the full suite runs on every change. PostgreSQL runs in a container in CI through `pg` (also a dev dependency only).
3. **Differential tests.** Load the same graph into a reference graph engine (for example, Neo4j in a container), PostgreSQL, and SQLite. Run a query corpus on all three and compare the results. Sources for the corpus: real query logs, generated queries, and hand-written edge cases. When results differ, use the TCK to decide which side is wrong.
4. **Integration tests** against real PostgreSQL versions in containers, and against SQLite through `better-sqlite3`. These use the test executors, which also act as the reference examples for the documentation.
5. **Performance benchmarks** on reference graphs of different sizes and densities, with focus on variable-length and shortest-path queries. Compare single-statement and multi-step strategies. Record the results to detect regressions.

## Safe execution guidance (documentation for callers)

- Keep the default `readOnly: true` for any graph that runs user-supplied or generated queries. Give its executor a database role (PostgreSQL) or a read-only connection (SQLite) with only read access to the mapped tables.
- When you need writes, make a separate graph with `readOnly: false` and a separate executor whose role or connection can write. Do not use that graph for untrusted queries.
- Set a statement timeout in the executor, and keep the library's limits at or below the defaults unless there is a reason.
- Treat the library's read-only gate as one layer of defense, not the only layer.

## Project setup

- TypeScript, ESM, Node LTS, strict mode. The core library has no runtime dependencies other than the ANTLR runtime. Database drivers (`pg`, `better-sqlite3`) are dev dependencies only.
- Packages: `core` (parser, analysis, planning, assembler), `dialect-postgres`, `dialect-sqlite`, and `tck-harness` (dev only, includes the test executors).
- CI: lint, type check, unit tests, the TCK allow-list on both dialects, and integration tests.
- License the project so that it can include and run the Apache 2.0 TCK and grammar.

## Milestones (estimates for one engineer)

| Milestone | Content                                                                                               | Estimate       |
| --------- | ----------------------------------------------------------------------------------------------------- | -------------- |
| M1        | Tier 0 on both dialects, test executors, and the TCK harness (`CREATE` loader, formatter, allow-list) | 3 weeks        |
| M2        | Tier 1 on both dialects                                                                               | 2\u20133 weeks |
| M3        | Tier 2, multi-step plans, and benchmarks                                                              | 3 weeks        |
| M4        | `OPTIONAL MATCH`, `WITH`, `UNWIND`, and the differential test suite                                   | 2\u20133 weeks |
| M5        | Hardening, documentation, 1.0 release                                                                 | 1\u20132 weeks |

## Risks

- **Path search performance** on dense or large graphs. Mitigations: required depth bounds, row caps, multi-step breadth-first search, indexes on start and end ids, and benchmarks from M3 onward.
- **Semantic drift.** Results that differ from a graph database in small ways, such as nulls, ordering, or duplicate rows. Mitigations: the TCK and the differential tests.
- **Dialect divergence.** SQLite's loose typing and missing `LATERAL` can make the two dialects return different results. Mitigation: run every TCK scenario on both dialects and treat a difference between them as a failure.
- **Consistency across steps.** Multi-step plans depend on the caller's executor running every step in one transaction. Mitigations: the executor interface makes the transaction required, the documentation states the isolation level each dialect needs, and the example executors show it.
- **Grammar and parser maintenance** when the openCypher grammar changes. Mitigation: pin the grammar version and regenerate it on purpose.
- **Scope growth toward full Cypher.** Mitigation: the tier gate and the future-goals list.

## Open questions

- Should the default limits change after the M3 benchmarks? They are starting values, not measured ones.
