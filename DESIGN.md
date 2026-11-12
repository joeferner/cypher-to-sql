# Design

How cypher-to-sql works and the rules it keeps. For the roadmap and progress, see the [GitHub issues and milestones](https://github.com/joeferner/cypher-to-sql/milestones).

## Scope

Version 1 runs read-only openCypher on PostgreSQL (including managed PostgreSQL such as RDS and Aurora, where graph extensions are not available) and SQLite. `CREATE` is available behind an explicit write mode, mainly so that the TCK can build its test graphs with the library itself. Coverage grows feature by feature, and every unsupported construct fails with a clear `UnsupportedFeatureError`.

**Non-goals:** procedures (`CALL`), APOC, vendor-specific functions, and `LOAD CSV`. Managing application schemas: the library reads a mapping and never creates application tables. Database drivers, connections, and pooling: the caller runs the SQL with their own driver, and the library has no runtime dependency on any driver.

Generated queries (for example, from an LLM) are a main use case. Error messages therefore say what is unsupported and, where possible, give a `hint` with a rewrite, so that an automated retry loop can fix the query.

## Architecture

```
Cypher text
  → Parser (official openCypher ANTLR4 grammar, antlr4ng runtime)
  → AST (typed, positions kept; unsupported constructs stay as explicit nodes)
  → Mode and feature gate (read mode rejects writes; unsupported constructs are rejected)
  → Planner (read planner; write planner only on write graphs)
  → Dialect (PostgreSQL, SQLite)
  → Executor (one transaction) → Result assembler → Cypher values
```

- Never parse Cypher with regular expressions. The grammar is pinned in `grammar/Cypher.g4` and regenerated on purpose.
- The planner never writes database-specific SQL. All dialect-specific syntax goes through the `Dialect` interface. Supporting two dialects from the start keeps that boundary honest.
- One package. The TCK harness and the test executors live under `test/` and are not published.

## Security model

- Every literal and parameter becomes a bind value. Identifiers come only from the mapping, and `validateMapping` requires each one to be a plain SQL identifier. Query text never becomes SQL text.
- `readOnly` (the default is true) is enforced twice. The gate rejects write clauses in the AST, and a graph made with `readOnly: true` has no write planner at all, so even a bug in the gate cannot produce an `INSERT`.
- The executor's transaction mode comes from the plan, not from the flag. A query without write clauses runs in a `'read'` transaction even on a write graph.

### Guidance for callers

- Keep `readOnly: true` for any graph that runs user-supplied or generated queries. Give its executor a database role (PostgreSQL) or a read-only connection (SQLite, or `PRAGMA query_only`) that can only read the mapped tables.
- For writes, make a separate graph with `readOnly: false` and a separate executor that can write. Never pass that graph untrusted queries.
- Set a statement timeout in the executor (for example, PostgreSQL `statement_timeout`), and keep the library's limits at or below the defaults.
- On PostgreSQL, turn JIT off in the executor (`SET LOCAL jit = off` after `BEGIN`, or for the role). The SQL for expressions on JSON lists uses set-returning functions and recursive CTEs with high row estimates, so JIT compilation can take hundreds of milliseconds for a query that runs in under one.
- Treat the library's read-only gate as one layer of defense, not the only one.

## Execution model

A query compiles to a plan of one or more SQL steps (`graph.compile(cypher).explain()` shows them). One statement is the default. The planner uses more than one step when that is faster or simpler:

- **Shortest path:** breadth-first search with one step per depth, which stops as soon as it reaches the target. A recursive CTE cannot stop early in the same way.
- **Entity hydration:** first find matching ids, then fetch full nodes and relationships in one batched step.
- **Large `WITH` stages:** materialize an intermediate result once instead of repeating it.
- **Writes after reading clauses:** a source `SELECT` runs first, then the `CREATE` inserts run once per source row (`perRow` steps). The source is fully read before any insert, so new entities are never matched by the same query.

Rules:

- All steps of a query run in **one transaction**, so every step sees the same data. PostgreSQL uses `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` for reads. SQLite uses one read transaction on a read-only connection (or with `PRAGMA query_only`).
- Intermediate results pass to the next step as **bound arrays**, never temp tables, because PostgreSQL does not allow `CREATE TEMP TABLE` in a read-only transaction. PostgreSQL uses `= ANY($1)`; SQLite uses `IN (SELECT value FROM json_each(?))`.
- **Results are assembled in TypeScript.** Each step selects whatever column shape is easiest (ids, JSON text). The assembler builds the Cypher values. JSON values always cross the driver boundary as JSON text, so the int/float distinction survives on every driver.

## Storage layout (generic)

| Table | Columns                                                               |
| ----- | --------------------------------------------------------------------- |
| Nodes | id, labels (JSON array), properties (JSON object)                     |
| Edges | id, start node id, end node id, type (text), properties (JSON object) |

- JSON is `jsonb` on PostgreSQL and JSON text on SQLite (JSON1 functions).
- The mapping configures table and column names and an optional schema, so one mapping can serve many isolated graphs.
- Integers are stored without a decimal point (`1`) and floats always with one (`1.0`), so they read back as `bigint` and `number`.
- Recommended indexes: edge start id, edge end id, edge type, plus expression or GIN indexes for frequently filtered properties.
- Integers read back from JSON outside the 64-bit range are floats (`jsonb` prints `1e308` as plain digits).
- Later: a typed layout with one table per label (#26).

### Declared property types

`mapping.nodes.propertyTypes` and `mapping.edges.propertyTypes` declare a type for a property key: `string`, `integer`, `float`, `boolean`, `date` (ISO 8601 `YYYY-MM-DD`), or `datetime` (ISO 8601 with a time zone). Temporal values are stored as strings. A type applies to the key across every label (or relationship type), which matches the generic layout: one expression index on a key covers the whole table, and a node with several labels cannot get conflicting types.

- **Writes:** `CREATE` rejects a non-null value that does not have the declared type, with a `SemanticError` and a hint. There is no conversion (`1` is not a float). Values are checked at run time, so literals, parameters, and values from `MATCH`/`UNWIND` rows are all covered. Undeclared keys accept any property value.
- **Reads:** a declared property is read as a native SQL value without a type check (`Dialect.typedMember`), so comparisons against it are plain SQL and can use an expression index. The key comes from the mapping and is written into the SQL as a literal, so the index expression must match it exactly:

  ```sql
  -- PostgreSQL, for nodes.propertyTypes = { age: 'integer', name: 'string' }
  CREATE INDEX nodes_age ON nodes (((properties ->> 'age')::bigint));
  CREATE INDEX nodes_name ON nodes ((properties ->> 'name'));
  -- SQLite
  CREATE INDEX nodes_age ON nodes (properties ->> '$."age"');
  ```

  Undeclared properties are JSON values whose type is checked at run time (see "Expressions"); they cannot use these indexes.

- Data written to the tables by something other than this library is not checked. Add `CHECK` constraints if other writers exist, because a value of the wrong type makes the PostgreSQL cast fail.

## Expressions

`src/planner/expr.ts` compiles expressions (in `WHERE`, `RETURN`, `UNWIND`, and property maps) with a static type for each one: a native SQL value (boolean, integer, float, string), a JSON value whose Cypher type is known only at run time, null, or an entity.

- **Both types known** (literals, declared properties, results of typed operations): plain SQL, for example `(properties ->> 'age')::bigint > $1`.
- **A JSON operand:** the SQL checks its run-time type (`Dialect.jsonType`) and gives null for values of a different type, as Cypher does. Operands used more than once are computed once in a scalar subquery with an optimization fence (`Dialect.noFlatten`); without the fence, the planners copy the expression into every use, which grows exponentially with nesting.
- **Lists and maps:** `=` walks both values with a recursive CTE (`Dialect.jsonDeepEquals`), so nesting depth does not change the SQL size. List ordering is lexicographic at the top level; ordering nested lists or maps is null.
- **Results:** a native value is selected in its SQL type and converted by the assembler, so floats stay exact. Floats converted to JSON keep a fraction (`2.0`); on SQLite this goes through the shortest of 15 to 17 significant digits, because `json_quote` rounds to 15.
- **Type errors:** a type error the compiler can see (`1 AND true`, `'a' - 1`, `[] OR x`) is a `SemanticError` at compile time. A type error that depends on data is null at run time instead of an error (#30).
- **PostgreSQL constant folding:** PostgreSQL may evaluate a CASE branch early when its input is a constant (a bound parameter), even if the branch is not taken. Casts out of JSON are therefore guarded so that they never fail.

### Functions

`src/planner/functions.ts` compiles function calls (names are case-insensitive). Arguments of a known wrong type are a `SemanticError` at compile time; JSON arguments of the wrong type give null at run time (#30); a null argument gives null.

| Group      | Functions                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Entities   | `id`, `labels`, `type`, `keys`, `properties`                                                                                                    |
| Conversion | `coalesce`, `toString`, `toInteger`, `toFloat`, `toBoolean`, and their `...OrNull` forms                                                        |
| Lists      | `size`, `head`, `last`, `tail`, `reverse`, `range`                                                                                              |
| Strings    | `size`, `substring`, `left`, `right`, `toUpper`/`upper`, `toLower`/`lower`, `trim`, `ltrim`, `rtrim`, `replace`, `split`, `reverse`             |
| Numbers    | `abs`, `sign`, `round`, `ceil`, `floor`, `sqrt`, `exp`, `log`, `log10`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `pi`, `e`, `rand` |

Any other function is an `UnsupportedFeatureError` whose hint lists the supported ones. Aggregates are #9; temporal functions, path functions (`nodes`, `relationships`, `length`), `startNode`/`endNode`, and `round` with a precision are not supported yet. Known differences: string parsing in `toInteger`/`toFloat` accepts JSON number syntax on SQLite (so not `+1` or `.5`) and a slightly wider syntax on PostgreSQL; `toUpper`/`toLower` follow the database (SQLite changes ASCII letters only); `trim` removes spaces only.

## Ids (write mode)

- `{ kind: 'database' }` (the default): the database generates ids. Each `INSERT` uses `RETURNING id` so that later parts of the pattern can refer to the new entity. PostgreSQL does not guarantee row order for a multi-row `RETURNING`, so this mode inserts one entity per statement. Speed is not a goal for `CREATE`.
- `{ kind: 'generator', generate }`: the library calls the caller's function before inserting, so it knows every id up front.
- Ids supplied as properties in a query are ordinary properties. They never replace the internal id.

## Limits

Set for each graph; a query can lower them but never raise them. Exceeding a limit raises `LimitExceededError`. Results are never silently truncated.

| Limit                | Default | Behavior                                                                                           |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `maxPathDepth`       | 10      | Upper bound for `[*]` and `[*n..]`. An explicit upper bound above it is rejected.                  |
| `maxRowsPerStep`     | 100,000 | Each step runs with `LIMIT maxRowsPerStep + 1`; getting the extra row means the limit is exceeded. |
| `maxResultRows`      | 10,000  | Final records. The hint suggests adding `LIMIT`.                                                   |
| `maxFrontierSize`    | 100,000 | Ids carried from one breadth-first search step to the next.                                        |
| `maxSteps`           | 32      | SQL steps in one read plan, including breadth-first search depths.                                 |
| `timeoutMs`          | 30,000  | Total wall-clock time, checked between steps. Timeouts for single statements belong to the caller. |
| `maxCreatedEntities` | 100,000 | Nodes plus relationships created by one query, checked against all source rows before any insert.  |

The defaults are starting values, not measured ones (#16).

## Translation rules

| Cypher                                                      | SQL                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Node pattern `(a:Label {k: v})`                             | Scan of the node table with label and property filters                                                                          |
| Fixed relationship `-[r:T]->`                               | Join to the edge table on start and end ids                                                                                     |
| Undirected `-[r]-`                                          | Join on either direction with `OR`. As in Cypher, a relationship matches once per orientation that fits (a self-loop once)      |
| Several relationship patterns in one `MATCH`                | `r1.id <> r2.id` for each pair (relationship uniqueness), including anonymous ones and ones bound by an earlier clause          |
| Inline property map `{k: v}` in `MATCH`                     | `n.k = v` per entry with Cypher equality: a missing property or a null never matches. A parameter map is an error               |
| `WHERE`                                                     | The expression compiler (see "Expressions"), with Cypher null semantics                                                         |
| `RETURN`, `SKIP`, `LIMIT`                                   | Direct equivalents; `SKIP`/`LIMIT` are bound values checked to be non-negative integers                                         |
| `ORDER BY`                                                  | Sort keys from `ExprCompiler.sortKeys`: aliases are substituted, then a JSON value sorts by type rank and then value            |
| `DISTINCT` with `ORDER BY`                                  | `SELECT * FROM (SELECT DISTINCT ..., <sort keys>) AS d ORDER BY d.k0, ...`; the keys may use only projected values              |
| Aggregates (`count`, `sum`, `avg`, `min`, `max`, `collect`) | SQL aggregates; non-aggregated return items form the `GROUP BY`. `collect` is a JSON array aggregate with nulls removed.        |
| Variable length `[*1..n]`                                   | Recursive CTE with visited-id arrays and a required upper bound, or iterative steps                                             |
| `shortestPath` / `allShortestPaths`                         | Iterative breadth-first search steps, or a recursive CTE stopped at the first depth that reaches the target                     |
| `nodes(p)`, `relationships(p)`, `length(p)`                 | Path id arrays, hydrated by the assembler                                                                                       |
| `OPTIONAL MATCH`                                            | PostgreSQL: `LEFT JOIN LATERAL`. SQLite: `LEFT JOIN` with correlated conditions, or a separate step.                            |
| `WITH`                                                      | CTE or subquery per stage, or a separate step for large stages                                                                  |
| `UNWIND`                                                    | A FROM item over the list: SQLite `json_each`, PostgreSQL `jsonb_array_elements ... WITH ORDINALITY`. Ordered by list position. |
| Pattern predicates, `EXISTS { }`                            | `EXISTS (SELECT ...)`                                                                                                           |
| `CREATE` (write mode)                                       | `INSERT` per entity, in pattern order; once per source row after `MATCH`/`UNWIND`                                               |

## Dialect differences

| Topic                 | PostgreSQL                                             | SQLite                                                                                |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Correlated joins      | `LATERAL`                                              | No `LATERAL`. Use correlated subqueries, table-valued `json_each`, or separate steps. |
| Arrays                | Native arrays and `jsonb`                              | JSON text only                                                                        |
| Path cycle check      | Array containment on the path                          | `instr` or `json_each` on a JSON path string                                          |
| Typing                | Strict; a failed cast raises an error                  | Type affinity; values can change type silently                                        |
| `LIKE`                | Case sensitive                                         | Case-insensitive for ASCII. Use `instr` / `substr` for `CONTAINS` and `STARTS WITH`.  |
| Read-only enforcement | `READ ONLY` transaction plus a role with only `SELECT` | Read-only connection or `PRAGMA query_only`                                           |
| Integer size          | `bigint`, with overflow errors                         | 64-bit integers; overflow silently becomes a float                                    |

## Semantics that need care

- **Nulls.** Cypher and SQL mostly agree on three-valued logic. Lists, maps, and `IN` with nulls do not always agree. Test each case.
- **Failed casts** return null in Cypher. Use safe-cast helpers in both dialects.
- **Numbers.** Integer division truncates, and integer overflow is an error. Map both exactly in each dialect.
- **Mixed-type comparisons** return null in Cypher; SQL raises an error or converts.
- **Sort order.** Cypher defines a global order across types: map < node < relationship < list < string < boolean < number < null, ascending. Typed values use `NULLS LAST` (ascending) or `NULLS FIRST` (descending) explicitly; JSON values sort by a type rank first, with null ranked last. Within lists and maps the sort is by JSON text, not element-wise (#32). Within ORDER BY ties, UNWIND order is kept.
- **Strings.** Comparison is case sensitive and by code point: `COLLATE "C"` on PostgreSQL, the default BINARY collation on SQLite. `STARTS WITH`, `ENDS WITH`, and `CONTAINS` never use `LIKE` (case-insensitive on SQLite, and `%`/`_` are wildcards).
- **NaN.** SQLite has no NaN (`0.0 / 0.0` is null there), and PostgreSQL treats `NaN = NaN` as true and NaN as larger than every number. NaN comparisons do not match Cypher on either dialect.
- **Integer errors on SQLite.** Integer overflow becomes a float and integer division by zero gives null, where Cypher raises an error (#30). PostgreSQL raises its own errors for both.
- **Unbounded paths.** `[*]` without an upper bound is capped by `maxPathDepth`.
- **Row order.** `MATCH` order is undefined, but `UNWIND` order is defined, so plans with `UNWIND` order by every FROM item in clause order (nested-loop order).

## Testing

- **openCypher TCK** (`vendor/openCypher`, pinned submodule). `test/tck` parses the Gherkin features with `@cucumber/gherkin` and generates one vitest test per scenario and dialect. Setup runs on a write graph; the query runs on a read-only graph, which also tests the gate on every scenario. A scenario that hits an unsupported feature is skipped with that reason. `test/tck/allow-list.json` lists the scenarios that must pass, by dialect.
- **Unit tests** for each stage, and emitted-SQL snapshots per dialect (#4).
- **Differential tests** against a reference engine such as Neo4j (#20). When results differ, the TCK decides which side is wrong.
- **Benchmarks** on reference graphs, focused on variable-length and shortest-path queries (#15).
- Treat a difference between the two dialects on the same scenario as a failure.

## Risks

- **Path search performance** on dense or large graphs. Mitigated by required depth bounds, row caps, multi-step search, indexes on start and end ids, and benchmarks.
- **Semantic drift** from a graph database (nulls, ordering, duplicate rows). Mitigated by the TCK and differential tests.
- **Dialect divergence** from SQLite's loose typing and missing `LATERAL`. Mitigated by running every TCK scenario on both dialects.
- **Consistency across steps** depends on the caller's executor running every step in one transaction. The executor interface requires a transaction, and the example executors show the isolation level.
- **Scope growth toward full Cypher.** Mitigated by the feature gate and the non-goals.
