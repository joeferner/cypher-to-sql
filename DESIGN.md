# Design

How cypher-to-sql works and the rules it keeps. For the roadmap and progress, see the [GitHub issues and milestones](https://github.com/joeferner/cypher-to-sql/milestones).

## Scope

Version 1 runs openCypher 9 on PostgreSQL (including managed PostgreSQL such as RDS and Aurora, where graph extensions are not available), SQLite, and MySQL 8 (see [MySQL](#mysql)). Graphs are read-only by default; `CREATE`, `MERGE`, `SET`, `REMOVE`, `DELETE`, and `FOREACH` are available behind an explicit write mode. Every unsupported construct fails with a clear error; the [README](README.md#limitations) lists them.

**Non-goals:** built-in procedures (Neo4j's `db.*`, APOC, GDS), vendor-specific functions, and `LOAD CSV`. `CALL` works only with procedures the caller registers (see [Procedures](#procedures)). Managing application schemas: the library reads a mapping and never creates application tables. Database drivers, connections, and pooling: the caller runs the SQL with their own driver, and the library has no runtime dependency on any driver.

Generated queries (for example, from an LLM) are a main use case. Error messages therefore say what is unsupported and, where possible, give a `hint` with a rewrite, so that an automated retry loop can fix the query.

## Architecture

```
Cypher text
  → Parser (official openCypher ANTLR4 grammar, antlr4ng runtime)
  → AST (typed, positions kept; unsupported constructs stay as explicit nodes)
  → Mode and feature gate (read mode rejects writes; unsupported constructs are rejected)
  → Planner (read planner; write planner only on write graphs)
  → Dialect (PostgreSQL, SQLite, MySQL)
  → Executor (one transaction) → Result assembler → Cypher values
```

- Never parse Cypher with regular expressions. The grammar is pinned in `grammar/Cypher.g4` and regenerated on purpose. It has implementation extensions from Neo4j, each marked in the file: `shortestPath(...)` and `allShortestPaths(...)` around a pattern part (their names are symbolic names checked by the parser, so neither word becomes reserved), `=~`, map projections, `EXISTS { }` without `RETURN`, `FOREACH`, reserved words as parameter names (`$limit`), and `CALL`, `YIELD`, and `FOREACH` as names where a reserved word may be one (property keys, labels, map keys). The grammar is Apache 2.0; [NOTICE](NOTICE) carries its notice into the package, with the generated parser.
- The planner never writes database-specific SQL. All dialect-specific syntax goes through the `Dialect` interface. Supporting two dialects from the start keeps that boundary honest.
- One package. The TCK harness and the test executors live under `test/` and are not published.

## Security model

- Every literal and parameter becomes a bind value. Identifiers come only from the mapping, and `validateMapping` requires each one to be a plain SQL identifier. Query text never becomes SQL text.
- `readOnly` (the default is true) is enforced twice. The gate rejects write clauses in the AST, and a graph made with `readOnly: true` has no write planner at all, so even a bug in the gate cannot produce an `INSERT`.
- The executor's transaction mode comes from the plan, not from the flag. A query without write clauses runs in a `'read'` transaction even on a write graph.

### Guidance for callers

[docs/safe-execution.md](docs/safe-execution.md) has the details. In short: keep `readOnly: true` for any graph that runs untrusted queries, with a database role or connection that can only read; use a separate graph and executor for writes; set a statement timeout and turn PostgreSQL JIT off in the executor ([docs/executors.md](docs/executors.md)); keep the limits at or below the defaults. The library's read-only gate is one layer of defense, not the only one.

## Execution model

A query compiles to a plan of one or more SQL steps (`graph.compile(cypher).explain()` shows them). One statement is the default. The planner uses more than one step when that is faster or simpler:

- **Shortest path:** breadth-first search with one step per depth, which stops as soon as it reaches the target. A recursive CTE cannot stop early in the same way.
- **Entity hydration:** first find matching ids, then fetch full nodes and relationships in one batched step.
- **Large `WITH` stages:** materialize an intermediate result once instead of repeating it.
- **Writes after reading clauses:** a source `SELECT` runs first, then the `CREATE` inserts run once per source row (`perRow` steps). The source is fully read before any insert, so new entities are never matched by the same query. A `CREATE` with no reading clauses gets a one-row source `SELECT` when a property value must be computed in SQL (or for RETURN); constant values need none. In a property value, `a.key` of an entity created earlier in the query is the expression `a` was given for `key` (null if none), so `rand()` there is evaluated again.
- **RETURN after CREATE:** for each source row the runner collects its variables (ids of matched and created entities, other values as JSON text) into a JSON object. A last step (`written`) reads the bound array of them in source order, joins the entities back by id, and runs the clauses after CREATE (`MATCH`, `UNWIND`, `WITH`, which see the new entities) and the RETURN, so filtering and aggregation there change the result but not what was created. A value that is a node or relationship (from `UNWIND` or a list) is joined back by its id too, so it shows later writes; a list of them keeps the values it had.
- **Writes after WITH** (`... CREATE ... WITH ... CREATE ...`): the query is split into parts, each of reading clauses then write clauses. A part after the first starts the same way as RETURN after CREATE: its source `SELECT` (`written`) reads the rows the part before it wrote, as a bound JSON array, and runs that part's reading clauses (`WITH`, `MATCH`, `UNWIND`, `CALL`) over them. Then its per-row steps run for each row of that source. Every step carries its part (`segment`), and the runner runs the parts in order, so each part sees everything the earlier parts wrote. Entity numbers restart in each part, because the rows carry the ids. In a pattern, a variable that holds a node as a value (`WITH list[0] AS n CREATE (n)-->()`) is used by the node's id, which is checked when the query runs. `WITH *` with no variables in scope keeps the rows; `RETURN *` with none is still a `SemanticError`.
- **Clause by clause.** The per-row steps run one write clause at a time: a clause runs for every row before the next one starts, as Cypher defines it (Neo4j gets the same results by planning "eager" barriers where clauses interfere). Within a clause the rows run in order, so a row sees what earlier rows wrote. Each row carries its entity ids and computed rows from clause to clause.
- **MERGE:** per row, a `SELECT` over the row as stored now finds the pattern's matches (`MATCH pattern RETURN <its new variables>`, with the bound variables from the row). With none, the create branch runs: the pattern's INSERTs (an undirected relationship is created left to right), then ON CREATE. With some, the row becomes one row per match, each with ON MATCH run on it. The new variables are entities like CREATE's, whose ids come from the match or the INSERT, so the later clauses see them alike; and as MERGE runs row by row, `UNWIND [1, 1] AS x MERGE (:N {x: x})` creates one node. A null property value is a `SemanticError` (it could never match); a parameter as the property map, a bound variable with new labels or properties, and relationships without exactly one type or with a length are rejected when compiling. A named path (`MERGE p = (a)-[:R]->(b)`) is rewritten before planning to `MERGE (a)-[r]->(b) WITH * MATCH p = (a)-[r]->(b)` (`expandMergePaths`): after the MERGE every element is bound, so the MATCH finds exactly the path it matched or created, one per match. Elements without a variable get a hidden one (its name starts with a space); `WITH *` carries hidden variables and `RETURN *` leaves them out. A named path in MERGE inside FOREACH is not supported yet.
- **FOREACH** (a Neo4j extension to openCypher): per row, a `SELECT` over the row as stored now computes the list (null runs nothing; any other non-list is a `CypherTypeError`). For each element the inner updating clauses run, clause by clause, with the variable bound to the element's SQL JSON (nodes and relationships stay tagged objects, so `FOREACH (n IN nodes(p) | SET n.x = 1)` works). Values that use the variable are computed per element by a `SELECT` over the current row. Variables bound inside FOREACH are not visible after it, and the row goes on unchanged. FOREACH can nest.
- **DELETE and DETACH DELETE:** per source row, a `SELECT` over the current row computes each value (a node, relationship, or path, also from a list or map; null deletes nothing), then its relationships are deleted, and with DETACH every relationship of its nodes. The nodes are collected; after the clause ran for every row, those without relationships are deleted (so that later clauses, such as MERGE, no longer see them), and after the last clause (`afterRows` steps) a check raises `CypherConstraintError` (`DeleteConnectedNode`) when one still has relationships, as Neo4j checks at the end of the query, so `MATCH (n)-[r]-() DELETE n, r` works over several rows. After a DELETE, the steps over the written rows (RETURN, and the parts after a WITH) know a deleted entity by its id: the written row has it, but the join back to its table finds nothing. Reading its properties or labels then raises `EntityNotFoundError` (`DeletedEntityAccess`), as in Neo4j, through `SqlBuilder.entityColumn`, which every property, label, and type read goes through. `type()` and `id()` still answer from the written row, which keeps each matched relationship's type (`~type:<name>`). The checks are only planned for a query that deletes. Projected by a WITH after the DELETE, a deleted entity reads as null instead.
- **SET and REMOVE:** they run per source row, among the CREATE steps in clause order. Each item is two steps: a `SELECT` over the current row in written-row form (`currentRow`, as for RETURN after CREATE), which computes the target entity and the value from the entities as stored now, so it sees earlier writes, earlier items, and earlier rows (`computes`); then an `UPDATE ... WHERE id = ?` per table the target can be in. The runner checks the computed value as CREATE checks properties (declared types, no maps or nested lists) and binds a JSON patch: `n.key = v` and `n += map` merge it (`Dialect.mergeProperties`: SQLite's `json_patch`, PostgreSQL's `jsonb_strip_nulls(old || patch)`; a null removes the key), `n = map` replaces the properties; a node or relationship as the map stands for its properties. `REMOVE n.key` is `SET n.key = null`. Labels change with `Dialect.appendLabel` (when absent) and `removeLabel`. A null target changes nothing. RETURN reads the entities after every row's writes, so a value read per row in Neo4j (`SET n.c = n.c + 1 RETURN n.c` over several rows) is the final one here.

Rules:

- All steps of a query run in **one transaction**, so every step sees the same data. PostgreSQL uses `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` for reads. SQLite uses one read transaction on a read-only connection (or with `PRAGMA query_only`).
- Intermediate results pass to the next step as **bound JSON arrays**, never temp tables, because PostgreSQL does not allow `CREATE TEMP TABLE` in a read-only transaction. SQLite uses `IN (SELECT value FROM json_each(?))`. PostgreSQL uses `= ANY(ARRAY(SELECT ... FROM jsonb_array_elements($1)))`; the planner does not know the id column's type, so each JSON id becomes that type through `jsonb_populate_record(NULL::<table>, ...)`. JSON keeps the binding the same for every driver.
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

`mapping.nodes.propertyTypes` and `mapping.edges.propertyTypes` declare a type for a property key: `string`, `integer`, `float`, `boolean`, `date`, or `datetime`. A `date` or `datetime` is stored as the temporal value's tagged JSON (see Temporal values), so it reads, compares, and returns as one on every dialect; writes also take its ISO 8601 text (`YYYY-MM-DD`, or a date-time with a time zone) and convert it, except in MERGE, whose pattern would never match a stored date with a string. Its member read carries the sort key `~k` with the key written into the SQL (`Expr.temporalKey`), so a comparison with a temporal value known before the query runs (`Expr.parameter`, or `Expr.knownTemporal` for a temporal function of literals and parameters) compares sort keys as plain SQL, which an expression index serves (`compareKnownTemporal`; for datetimes only orderings, since equal instants in different offsets are different values). A type applies to the key across every label (or relationship type), which matches the generic layout: one expression index on a key covers the whole table, and a node with several labels cannot get conflicting types.

- **Writes:** `CREATE`, `MERGE`, and `SET` reject a non-null value that does not have the declared type, with a `SemanticError` and a hint. Two conversions: to `integer`, from a float with an integral value in JavaScript's safe range (integers from JSON and most JavaScript data are `number`s, and the declaration settles that they are integers), and to `date` or `datetime`, from its ISO 8601 text (`declaredValue`). Otherwise there is none (`1` is not a float, `30.5` is not an integer). Values are checked at run time, so literals, parameters, and values from `MATCH`/`UNWIND` rows are all covered. Undeclared keys accept any property value.
- **Reads:** a declared property is read as a native SQL value without a type check (`Dialect.typedMember`), so comparisons against it are plain SQL and can use an expression index. The key comes from the mapping and is written into the SQL as a literal, so the index expression must match it exactly:

  ```sql
  -- PostgreSQL, for nodes.propertyTypes = { age: 'integer', name: 'string' }
  CREATE INDEX nodes_age ON nodes (((properties ->> 'age')::bigint));
  CREATE INDEX nodes_name ON nodes ((properties ->> 'name'));
  -- SQLite
  CREATE INDEX nodes_age ON nodes (properties ->> '$."age"');
  ```

  Undeclared properties are JSON values whose type is checked at run time (see "Expressions"); they cannot use these indexes.

- **Parameters:** a parameter's type is known only when the plan runs, so a comparison with a declared property (`n.age > $min`, `(n {name: $name})`) would need a type check in SQL, which no index can serve. Instead it compiles to `typed op ?value AND (?fits = 1 OR (typed IS NULL AND NULL))`, and the plan runner binds `?value` as the parameter converted to the property's type and `?fits` as whether its type fits (`parameterAs`, `parameterFits`). The first conjunct is plain and indexable; the second keeps Cypher's result for a parameter of another type (false for `=`, null when the property is null or for an ordering). A float compared with an integer property becomes the integer bound with the same result (`> 30.5` is `> 30`; `= 30.5` never matches). SQLite's `likelihood` hint (#36) is left off such comparisons, so that SQLite still sees the indexable term.

- Data written to the tables by something other than this library is not checked. Add `CHECK` constraints if other writers exist, because a value of the wrong type makes the PostgreSQL cast fail.

## Expressions

`src/planner/expr.ts` compiles expressions (in `WHERE`, `RETURN`, `UNWIND`, and property maps) with a static type for each one: a native SQL value (boolean, integer, float, string), a JSON value whose Cypher type is known only at run time, null, or an entity.

- **Both types known** (literals, declared properties, results of typed operations): plain SQL, for example `(properties ->> 'age')::bigint > $1`.
- **A JSON operand:** the SQL checks its run-time type (`Dialect.jsonType`): a comparison with a value of a different type is false or null, as in Cypher, and an operation that cannot take the type raises a type error (see "Run-time errors"). Operands used more than once are computed once in a scalar subquery with an optimization fence (`Dialect.noFlatten`); without the fence, the planners copy the expression into every use, which grows exponentially with nesting.
- **Lists and maps:** `=` walks both values with a recursive CTE (`Dialect.jsonDeepEquals`), so nesting depth does not change the SQL size. List ordering is lexicographic at the top level; ordering nested lists or maps is null.
- **Sorting lists** (ORDER BY, `min`, `max`): a list sorts by a text key that compares in byte order like the list does in Cypher: per element a type letter and an order-preserving value (`Dialect.sortableNumber`, `sortableString`), then an end letter below every type letter, so a prefix comes first. Only list values compute it (it is one branch of the sort key's CASE). Numbers in it compare as floats, and nested lists, maps, and entities by their JSON text.
- **Results:** a native value is selected in its SQL type and converted by the assembler, so floats stay exact. Floats converted to JSON keep a fraction (`2.0`); on SQLite this goes through the shortest of 15 to 17 significant digits, because `json_quote` rounds to 15.
- **Type errors:** a type error the compiler can see (`1 AND true`, `'a' - 1`, `[] OR x`) is a `SemanticError` at compile time. A type error that depends on data is a `CypherTypeError` at run time (see "Run-time errors").

### Run-time errors

A plain SELECT cannot raise a custom error, and the library cannot register functions on the caller's connection. So the SQL fails on purpose: `SqlBuilder.raise` records the error (kind, openCypher code, message, source position) on the step and emits `Dialect.raise`, an expression whose own error message quotes a marker `!cypher:<n>`. On PostgreSQL that is a failed cast of text to integer; on SQLite an invalid JSON path. The plan runner turns a driver error with a marker into the recorded `CypherTypeError` or `CypherArgumentError`.

- `Dialect.raise` mixes in `random()`, so that neither database evaluates it early: PostgreSQL folds constant expressions even in CASE branches that never run.
- Each check sits in a CASE after the null arm, so null stays null: `WHERE n.name` raises for a string and gives null for a missing property.
- `CypherTypeError`: a boolean condition that is not a boolean, arithmetic or negation on values that do not support it, label predicates on values that are not nodes or relationships, indexing and slicing with wrong types (`MapElementAccessByNonString` for a map indexed by a non-string), comprehensions, quantifiers, and `IN` over a non-list, and function arguments of the wrong type (the `...OrNull` conversions give null instead).
- `CypherArgumentError`: integer overflow (`NumberOutOfRange`; checked with `Dialect.checkedInteger` on SQLite, where it becomes a float, and mapped from PostgreSQL's own error), integer division or modulo by zero (`DivisionByZero`), and `range()` with step 0.
- Comparisons of values of different types are not errors (they are false or null, as in Cypher). Property access on a value that is not a map, node, or relationship gives null, not an error.
- **PostgreSQL constant folding:** PostgreSQL may evaluate a CASE branch early when its input is a constant (a bound parameter), even if the branch is not taken. Casts out of JSON are therefore guarded so that they never fail.

### Entities as values

A node or relationship bound by MATCH is a table alias. Inside a JSON value (a list, a map, a path, `collect()`, a WITH column holding those) it is its properties plus reserved keys, tagged with `~cypher`:

```json
{"~cypher": "node", "~id": 1, "~labels": ["N"], "name": "a"}
{"~cypher": "relationship", "~id": 7, "~type": "R", "~start": 1, "~end": 2, "w": 1}
{"~cypher": "path", "~nodes": [<node>, ...], "~relationships": [<relationship>, ...]}
```

- `Dialect.jsonType` reports these as `node`, `relationship`, and `path`, so comparisons, sorting (map < node < relationship < list < path < string ...), and `IS NULL` treat them as Cypher does. Equality compares the whole object; within one query, equal ids have equal objects.
- Properties are at the top level, so `x.name` on an entity in JSON is a plain member access. `id()`, `labels()`, `type()`, `keys()`, `properties()`, and label predicates read the reserved keys at run time.
- `MATCH (x)` where `x` holds a node in JSON (for example after `UNWIND collect(n) AS x`) joins the node table on its `~id` and binds `x` to that row.
- The assembler turns tagged objects in any JSON result back into `CypherNode`, `CypherRelationship`, and `CypherPath`.
- The reserved keys (`~cypher`, `~id`, `~labels`, `~type`, `~start`, `~end`, `~nodes`, `~relationships`) cannot be property keys, and `~cypher` cannot be a key of a map in a query or parameter: both are a `SemanticError`.

### Named paths

`p = (a)-[r]->(b)-[*]->(c)` binds `p` to a path value built from the pattern's aliases: the tagged nodes and relationships of each fixed hop, and for each variable-length hop its relationships and the nodes after its start, loaded from the CTE's id lists (`Dialect.entityList`, in path order). A path is null when any of its parts is (OPTIONAL MATCH). Its static shape is `path`, so `p.x`, `labels(p)`, or `size(p)` are compile-time type errors. `nodes(p)`, `relationships(p)`, and `length(p)` read the path's lists. A path variable may not also name a node or relationship of the same MATCH.

### Aggregation

`count(*)`, `count`, `sum`, `avg`, `min`, `max`, `collect`, `percentileDisc`, and `percentileCont` (each with `DISTINCT`) are in `src/planner/aggregates.ts`. They skip nulls. `sum` of integers is an integer and becomes a float when any value is a float; no values sum to `0`. `avg` is always a float. `min`/`max` of JSON values of different types use Cypher's order across types. `collect` gives a list in no particular order; of nodes or relationships, a list of them as entity values (see "Entities as values"). `stDev` and `min`/`max` of nodes or relationships are not supported yet.

The percentiles have no portable SQL aggregate (SQLite has none), so each one aggregates the group's numbers into a sorted JSON list (other values are skipped, as in `sum`) and picks from it with Neo4j's rules. `percentileDisc(x, p)` takes the element at `max(ceil(p * n) - 1, 0)`, keeping its type. `percentileCont(x, p)` interpolates linearly between the elements at `floor(p * (n - 1))` and `ceil(p * (n - 1))`, as a float. The percentile `p` is not aggregated. It may use the grouping keys, so it's checked per group: outside 0.0 to 1.0 raises `CypherArgumentError` (`NumberOutOfRange`) when the query runs. No values, or a null `p`, gives null.

A RETURN with an aggregate is planned as two levels:

```sql
SELECT <items, ORDER BY> FROM (
  SELECT <grouping keys>, <aggregates>, <properties of key variables> FROM ... WHERE ... GROUP BY <grouping keys>
) AS g
```

The items without aggregates are the grouping keys. Next to an aggregate, an item may use only constants and grouping keys written as a variable, a property of one, or a returned name (as in Cypher; `n.x + n.y` next to `count(*)` is an error even when it is returned). The inner level therefore holds only the keys, the aggregate calls, and key properties, which keeps PostgreSQL's grouping rules (it matches GROUP BY expressions only at the same query level, not inside subqueries); the outer level computes the items. Equal expressions compile to equal SQL text, and on PostgreSQL a repeated bind value reuses its `$n`, so a key's SELECT and GROUP BY expressions match.

Aggregates in WHERE, nested aggregates, and `rand()` inside an aggregate are a `SemanticError`.

### WITH stages

Each `WITH` ends a stage. `ReadScope.of` plans the clauses so far, projects them with the same code as RETURN (DISTINCT, aggregation, ORDER BY, SKIP, LIMIT), and starts a new scope on the result as the derived table `w0`:

```sql
SELECT ... FROM (SELECT <projected columns> FROM ... WHERE ...) AS w0
  LEFT JOIN "nodes" AS n1 ON n1."id" = w0.c0 ... WHERE ...
```

- Values are columns of the stage in their SQL type (JSON stays JSON). Nodes and relationships are carried as ids and joined back to their tables, so that everything that works on entities keeps working; the join is by primary key.
- Only projected names are visible after WITH (`WITH *` keeps them all). An expression must have an alias.
- A stage's LIMIT is only the query's LIMIT: the row limit applies to the final SELECT of a step, so intermediate rows are never cut short silently.
- A stage with an order (its ORDER BY, or UNWIND before it) numbers its rows (`row_number() OVER ()` over the ordered stage) in column `o`, and later stages order by it, so `WITH ... ORDER BY ... RETURN collect(...)` keeps the order.
- `WITH ... WHERE` filters the projected rows. When it uses a variable that WITH does not project (Cypher allows that), a stage without aggregation or DISTINCT applies it before projecting (each row projects to one row); with SKIP or LIMIT that is not supported yet. An expression equal to a projected one refers to the projected value.
- After aggregation, ORDER BY may use only aggregates that are projected.

### OPTIONAL MATCH

The tables an OPTIONAL MATCH adds are grouped and left-joined, with all of its conditions (the pattern's, and its WHERE) in the ON clause:

```sql
FROM "nodes" AS n0 LEFT JOIN ("nodes" AS n1 JOIN "edges" AS e2 ON TRUE)
  ON e2."start_id" = n0."id" AND e2."end_id" = n1."id" AND <WHERE>
```

- The ON clause may refer to earlier tables, which both databases allow for a parenthesized join, so SQLite's missing `LATERAL` does not matter. A single table is not parenthesized (both databases reject that).
- WHERE decides what matches: when it rejects every match, the row stays with the new variables null. The whole pattern matches or none of it does.
- An OPTIONAL MATCH that comes first joins to `(SELECT 1)`, so it gives one row of nulls when nothing matches. One whose variables are all bound already adds nothing.
- Null entities propagate: properties, `labels()`, `type()`, and label predicates are null, `IS NULL` is true, aggregates skip them, WITH carries them (entities are joined back with a LEFT JOIN), and a later MATCH from a null node matches nothing.

### Variable-length patterns

`(a)-[r:T*min..max {k: v}]->(b)` is a derived table over a recursive CTE that starts a zero-length path at each node `a` can be and adds one edge per step:

```sql
(WITH RECURSIVE vp(s, t, d, path) AS (
   SELECT n.id, n.id, 0, <empty id list> FROM nodes AS n WHERE n.id IN (<start nodes>)
   UNION ALL
   SELECT vp.s, e.end_id, vp.d + 1, <path + e.id> FROM vp JOIN edges AS e ON e.start_id = vp.t
   WHERE vp.d < <max> AND <e.id not in path> AND <type and property filters>
 ) SELECT s, t, path FROM vp WHERE d >= <min>) AS v
```

joined with `v.s = a.id AND v.t = b.id`.

- The path is a list of edge ids: an array of the id column's type on PostgreSQL (`||`, `= ANY`, `&&`), JSON text on SQLite (`json_insert`, `json_each`). It enforces relationship uniqueness along the path, which also ends cycles, and against the MATCH's other relationship patterns.
- `<max>` is bound at run time: the explicit upper bound, or `maxPathDepth` when there is none. A bound (or a lower bound with no upper bound) above `maxPathDepth` raises `LimitExceededError`. The default lower bound is 1.
- At most `maxRowsPerStep` paths: the CTE's rows go through `LIMIT maxRowsPerStep + 1`, which stops the recursion, and `row_number()` past the cap raises `LimitExceededError` (through `Dialect.raise`). The check is in the start-node column and in the SELECT with the window function, because neither database pushes a join condition into such a SELECT; otherwise SQLite filters the paths by the end node first and the LIMIT would cut the rest silently. It costs up to a few milliseconds on large path sets.
- Undirected patterns follow an edge from either end (`CASE` picks the other end); a self-loop is followed once.
- The CTE cannot refer to the outer query (SQLite has no `LATERAL`), and inline property values must not use variables. `<start nodes>` makes up for it: `SELECT a.id FROM ... WHERE ...` over the scope's tables and conditions before `b` joins, a self-contained query of every node `a` can be (`ReadScope.startNodes`). It covers a filtered start node and one bound by earlier clauses, so the search grows with the start's neighborhood, not the graph (benchmarks: `*1..3` between two given nodes from 10 seconds to 30–40 ms on 10,000 nodes).
- The search still starts at every node when nothing restricts `a` (a filter only on `b` does not), inside a subquery (EXISTS, pattern comprehensions), and when the rows so far already include a search that starts at every node, which the start-node query would repeat. Starting from the end node instead, or seeding with ids found in a separate step, would cover more of these.
- `r` in `[r*]` binds the id list. WITH carries the list itself; `count(r)`, `size(r)`, and `r IS NULL` use it directly; any other use loads it as a JSON list of tagged relationships, in path order (see "Entities as values"). A pattern whose variable is already bound to a list of relationships (`WITH [r1, r2] AS rs MATCH (a)-[rs*]->(b)`) matches that exact chain instead of searching (`ReadScope.matchBoundList`). The elements must be relationships (of the pattern's types, if any) and the length must be within the range. Each element must end where the next starts, in the arrow's direction, and the chain must go from `a` to `b`. An empty list matches `a` = `b` for a range from 0. Named paths, undirected patterns, and inline properties over a bound list, and a list still bound from an earlier `[r*]` in its id-list form, are not supported yet.
- For a named path, the CTE also keeps the ids of the nodes it reaches.

### Shortest paths

`MATCH p = shortestPath((a)-[r:T*min..max]-(b))` (or `allShortestPaths`) is a breadth-first search that runs as steps before the main statement (`src/search.ts`):

1. **Node pairs:** `SELECT DISTINCT a.id AS s, b.id AS t` over the FROM and WHERE of the scope at that point, which include both nodes' filters and every earlier clause. Later parts of the MATCH can only remove pairs, so this is a superset of the pairs the statement joins.
2. **One step per depth:** the edges next to the frontier (`f`, `r`, `t`: from node, edge, to node), with the type and property filters, ordered by edge id. All start nodes search together: a step expands the union of their frontiers, each start node keeps its own visited nodes and parents in TypeScript, and a start node stops once it has reached all of its targets. The search ends at the first depth that reaches every target, or when no frontier is left, or at the upper bound (`maxPathDepth` when there is none).
3. **The statement** reads the paths found from a bound JSON array (`Dialect.boundPaths`) as a derived table with the same columns as a variable-length pattern's CTE (`s`, `t`, `path`, `nodes`), so named paths, `r`, path functions, WITH, and OPTIONAL MATCH work the same.

- `shortestPath` keeps one path per pair: the one through the lowest edge ids at each depth. `allShortestPaths` keeps every path of the shortest length.
- Shortest paths never repeat a node, so relationship uniqueness holds without a check.
- The pattern must have exactly one relationship, variable-length, with a lower bound of 0 or 1. With 0, a node's shortest path to itself has length 0; with 1, there is none.
- A condition in the MATCH's WHERE on the path or its relationships applies during the search in Cypher. That is not supported (`UnsupportedFeatureError`); a later `WITH ... WHERE` filters the paths found instead.
- Each search depth counts against `maxSteps`, as it runs. The nodes carried to the next depth, summed over start nodes, count against `maxFrontierSize`. `allShortestPaths` may return at most `maxRowsPerStep` paths.
- The node-pair query and the statement both evaluate the earlier clauses, in the same transaction. Not done yet: searching from both ends, and comparing against a recursive CTE that stops at the first depth (#15).

### Functions

`src/planner/functions.ts` compiles function calls (names are case-insensitive). Arguments of a known wrong type are a `SemanticError` at compile time; JSON arguments of the wrong type are a `CypherTypeError` at run time (null for the `...OrNull` conversions); a null argument gives null.

| Group      | Functions                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Entities   | `id`, `labels`, `type`, `keys`, `properties`, `startNode`, `endNode`                                                                            |
| Conversion | `coalesce`, `toString`, `toInteger`, `toFloat`, `toBoolean`, and their `...OrNull` forms                                                        |
| Lists      | `size`, `head`, `last`, `tail`, `reverse`, `range`                                                                                              |
| Strings    | `size`, `substring`, `left`, `right`, `toUpper`/`upper`, `toLower`/`lower`, `trim`, `ltrim`, `rtrim`, `replace`, `split`, `reverse`             |
| Numbers    | `abs`, `sign`, `round`, `ceil`, `floor`, `sqrt`, `exp`, `log`, `log10`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `pi`, `e`, `rand` |

`toString` of a float writes it as Neo4j does (Java's `Double.toString`): the shortest digits that read back as the same double, as a decimal from 10^-3 up to 10^7 and in scientific notation otherwise (`0.001`, `1.0E7`, `1.5E-10`), with `Dialect.floatToString`. `+` with a string and a number or boolean concatenates them, written as `toString` would (`'a' + 1.5` is `'a1.5'`).

A function of openCypher or Neo4j that isn't implemented (`degrees`, `point`, ...), or a namespaced one (`apoc.coll.sum`), is an `UnsupportedFeatureError`. A name that isn't a Cypher function at all is a `SemanticError` (Cypher's UnknownFunction). Both hints list the supported functions. Path functions (`nodes`, `relationships`, `length`) are described in "Named paths". `startNode(r)` and `endNode(r)` read the node from the node table by the relationship's end id (or its tagged `~start`/`~end`) as a tagged node. `coalesce()` of nodes or relationships compares them as their tagged objects, so `WITH coalesce(b, c) AS x MATCH (x)-->()` works. A label predicate on a relationship (`r:T`) is true when `T` is its type, case-sensitively; a relationship has one type, so `r:A:B` needs both to be it. `round` with a precision is not supported yet. Known differences: string parsing in `toInteger`/`toFloat` accepts JSON number syntax on SQLite (so not `+1` or `.5`) and a slightly wider syntax on PostgreSQL; `toUpper`/`toLower` follow the database (see "SQLite functions"); `trim` removes spaces only.

### SQLite functions

SQLite's `upper()` and `lower()` change ASCII letters only, unless the ICU extension is loaded, and plain SQL has no Unicode case mapping. `sqlite({ functions: true })` uses `cypher_upper()` and `cypher_lower()` instead, which `registerSqliteFunctions(db)` defines on a better-sqlite3 or `node:sqlite` connection with JavaScript's `toUpperCase`/`toLowerCase` (Unicode, including `ß` to `SS`, as in Neo4j). The option is off by default, so that a connection that does not register them keeps working; the functions are deterministic, so they can also serve expression indexes. PostgreSQL's `upper()` and `lower()` follow the database's locale (a `C` locale changes ASCII letters only; per-character mapping, so `ß` stays). The same option enables `=~` through `cypher_regex()` (see "Regular expressions" under the SQL differences); without it, `=~` is an `UnsupportedFeatureError` whose hint names the option.

### Patterns in expressions

Pattern predicates (`WHERE (a)-[:T]->()`), `EXISTS { pattern WHERE c }`, `EXISTS { MATCH ... RETURN ... }`, and pattern comprehensions (`[p = (a)-->(b) WHERE c | e]`) are correlated subqueries. A new `ReadScope` (the subquery's) matches the pattern or runs the query; it resolves variables it does not bind through the enclosing scope (including list comprehension elements), so a bound node is the outer alias and only new variables add tables.

- A pattern predicate is `EXISTS (SELECT 1 FROM <new tables> WHERE <pattern conditions>)`. It may not introduce variables, and may be used only in a WHERE (of MATCH, WITH, a list comprehension, or EXISTS), as in Cypher; elsewhere `EXISTS { }` does the same.
- `EXISTS { query }` is `EXISTS (<query>)` and may use MATCH, UNWIND, and WITH, but not write clauses. The query may also end without RETURN (`EXISTS { MATCH (n)-->(m) }`, a Neo4j extension to the openCypher 9 grammar); the parser then adds `RETURN 1`. A grouping key that uses only the enclosing query's variables is left out of GROUP BY (SQLite cannot group by an outer column; it is constant there), with `HAVING COUNT(*) > 0` when no key is left.
- A pattern comprehension is the JSON list (`jsonAggregate`) of its projection over the matches.
- Aliases of a subquery's scope and expression compiler start with `q<n>_`, so that none hides an alias of the enclosing query. Relationship uniqueness applies within the subquery's pattern only. `shortestPath` inside one is not supported (its node-pair step runs on its own), nor are patterns in expressions after aggregation.

### Temporal values

`date`, `localtime`, `time`, `localdatetime`, and `datetime` values are `CypherTemporal` in results and parameters (`kind` and `text`, the Cypher form `toString()` returns: `2015-07-21T21:40:32.142+02:00[Europe/Stockholm]`). The calendar rules live in one TypeScript module (`src/temporal.ts`): ISO strings in all the forms Neo4j accepts, maps in calendar, week, ordinal, and quarter forms with a value to start from (`{date: d, week: 2}`), time zones by offset or IANA name (offsets from `Intl`, including historical ones such as Stockholm's `+00:53:28` in 1818), conversion between zones, epoch forms, and rendering as Java's `java.time` writes it.

- **Evaluation.** A temporal call whose arguments are known before the query runs (literals, parameters, maps and lists of them, and other such temporal calls) is a bind value evaluated in TypeScript when its step is bound (`temporal`). Other calls run in the database (`Dialect.temporalCall`): on SQLite through `cypher_temporal()`, which `registerSqliteFunctions` defines with the same TypeScript code (so `sqlite({ functions: true })`); on PostgreSQL as SQL (`src/dialect/postgres-temporal.ts`), a port of the same rules for years 1 to 9999. There every input becomes a map of fields (a string through regular expressions, a temporal value as `{date: x, time: x}`), and a chain of `LATERAL (... OFFSET 0)` stages computes the bases, the local date (a PostgreSQL `date`) and time (nanoseconds of the day), the zone (named zones through `AT TIME ZONE`), and the tagged JSON, each column once: without the `OFFSET 0` fences the planner pulls the stages up and copies expressions until it runs out of memory. Invalid values raise PostgreSQL's errors (`make_date`, unknown time zones), which become `CypherArgumentError`; out-of-range times are not checked there.
- **In SQL** a temporal value is a tagged JSON object: the kind as `~cypher`, the text as `~s`, a sort key as `~k`, and its components (`year`, `week`, `ordinalDay`, `hour`, `nanosecond`, `offsetSeconds`, `epochMillis`, ...). So `d.year` is a member lookup, `toString(d)` reads `~s`, and comparisons and ORDER BY compare `~k`, which orders values of one kind by instant (times and datetimes in UTC). Values of different temporal kinds are not comparable. Stored as a property, the object keeps the value's type.
- **Ordering across types:** after paths and before strings: datetime, localdatetime, date, time, localtime.
- **Durations** (`src/duration.ts`) are `CypherDuration` (`text`, Cypher's `P1Y2M3DT4H5M6.7S`): months, days, seconds, and nanoseconds kept apart, as in Neo4j. Construction from maps and ISO strings cascades fractions down (a month is 2,629,746 seconds, a day 86,400); the components (`d.days`, `d.minutesOfHour`, ...) use Java's truncating division, and the text gives each part its own sign (`PT-1M-0.001S`). Durations compare for equality only. In SQL a duration is tagged JSON like a temporal value (`~cypher: 'duration'`, `~s`, the components), and PostgreSQL computes with them in exact `numeric` (`src/dialect/postgres-duration.ts`).
- **Temporal arithmetic.** `temporal ± duration` adds months (the day clamped to the month), then days, then the time, on the local value (a named zone's offset is taken at the new local time); a date takes whole days of the time, toward zero, and a time only the time. `duration ± duration` adds the parts, `duration * n` and `/ n` scale them with the same cascade. Arithmetic on values known before the query runs is evaluated in TypeScript; otherwise `Dialect.temporalArithmetic` runs it (SQLite's `cypher_temporal_op`, or PostgreSQL SQL that builds the result with the temporal pipeline).
- **`duration.between(a, b)`** and `inMonths`, `inDays`, `inSeconds` follow java.time: a value without a zone is read in the other's zone, `b` is moved into `a`'s offset, and with dates on both sides the result is whole months (by packed month and day), then days, then the rest of the time; otherwise only the time between the times of day.
- **Truncation.** `<kind>.truncate(unit, value, map)` builds a local value from the fields of `value` cut to `unit` (millennium to microsecond; `week` and `weekYear` go to a Monday), then the result from `{date: local, time: local}` with the map's fields over it, so it is construction again on both sides. A `timezone` in the map replaces the zone (the local time stays); without one the value keeps its zone. Over a base, `millisecond`, `microsecond`, and `nanosecond` each replace their own three digits of the fraction (`.645` with `{nanosecond: 2}` is `.645000002`).

### Map projections

`n {.a, b: expr, c, .*}` (a Neo4j extension to the openCypher 9 grammar) is rewritten by the parser: `CASE WHEN n IS NULL THEN NULL ELSE {a: n.a, b: expr, c: c} END`. With `.*` the map starts from `properties(n)` and each entry is set over it in order (`MapProjection`, `Dialect.jsonSetKey`), so explicit entries win and keep null values. A later entry for a key replaces an earlier one. The subject may be a node, a relationship, or a map.

### CASE

`CASE` is SQL `CASE`. The generic form (`CASE WHEN c THEN r ... END`) takes the first branch whose condition is true; a null condition is not. The simple form (`CASE x WHEN v THEN r ... END`) compares with Cypher `=`, so a null `x` or `v` matches nothing and values of different types never match. No ELSE means null. When every branch that is not the null literal has one native type, the result has that type; otherwise each branch becomes JSON (so `CASE WHEN c THEN 1 ELSE 'a' END` keeps both types).

### List expressions

- **Indexing** `l[i]`: an integer index into a list (negative counts from the end; out of range is null), or a string key into a map, node, or relationship (`n['name']`, `n[$key]`). A constant key is a plain member access. A computed key is compared as data (`Dialect.jsonMemberAt`), never built into a SQLite JSON path.
- **Slicing** `l[from..to]`: elements from position `from` up to `to`; negative bounds count from the end, bounds out of range are clamped, a missing bound is open, and a null bound gives null.
- **List comprehensions** `[x IN l WHERE c | e]` and **quantifiers** `all`, `any`, `none`, `single` (`(x IN l WHERE c)`) are correlated subqueries over `Dialect.unwind(l)`: a comprehension aggregates the projected elements with `jsonAggregate` in list order, filtered by `c`; a quantifier aggregates `c` with three-valued logic (a null condition makes the result null unless the other elements decide it). `x` hides an outer variable of the same name, in the expression compiler and in every walk over the AST (`src/planner/walk.ts`).
- `x` is a JSON value, except over a list literal of literals of one type, where it has that type, so that `none(x IN ['a'] WHERE x % 2 = 0)` is a compile-time type error.
- Aggregates inside a comprehension's WHERE or projection are a `SemanticError`; a quantifier needs WHERE. `[x IN l]` without WHERE or `|` is a list literal holding `x IN l`, as the grammar reads it.
- Known types that do not fit (`true[0]`, `[1][1.5]`, `[x IN 5 | x]`) are compile-time type errors; values known only at run time raise a `CypherTypeError`.

### UNION

`q1 UNION q2 ...` and `q1 UNION ALL q2 ...` compile each query to its own plan (`createUnionPlan`). The runner runs them in order in one transaction and puts their records together, in the first query's column order. Each query may return different kinds of values in a column (nodes in one, JSON in another), so the records are combined in TypeScript, not with SQL `UNION`. `UNION` keeps the first of each set of equivalent records, as Cypher compares them for DISTINCT: `1` and `1.0` are the same, entities compare by id, and null equals null. (SQL `DISTINCT` in a RETURN still compares JSON text, so it keeps `1` and `1.0` apart.) Every query must return the same column names, in any order, and `UNION` and `UNION ALL` cannot be mixed; both are `SemanticError`s. The read-only gate checks every query. UNION inside `EXISTS { }` is not supported yet.

### Procedures

`createGraph({ procedures })` registers read-only procedures by name (`my.proc`, case-sensitive): typed inputs and outputs, and a TypeScript `call(args)` that returns rows. There are no built-in procedures. The graph resolves each `CALL` before planning (`resolveCalls` in `src/graph.ts`): an unknown name or a wrong number of arguments is a `SemanticError`, and an implicit call (`CALL my.proc`, standalone only) takes the parameters named like the inputs.

- **In-query** `CALL my.proc(args) YIELD out AS x WHERE c` is planned like UNWIND over the procedure's rows (`ReadScope.addCall`): a `procedure` bind calls it when its step is bound and gives a JSON array with one list of output values per row, and each yielded variable is an element of the row. So each row of the query is joined with every row of the procedure, and none means no rows. A void procedure (no outputs) leaves the rows as they are.
- **Standalone** `CALL my.proc(args)` becomes the CALL plus a RETURN of what it yields: every output in declared order without YIELD or with `YIELD *`. A void procedure gives no columns and no rows.
- **Arguments** must be known before the query runs (literals, parameters, lists and maps of them, as for temporal functions), so the procedure runs once per query; arguments from the rows are an `UnsupportedFeatureError` for now. A literal of the wrong type is a `SemanticError` when compiling; a parameter of the wrong type is a `CypherTypeError` when the query runs. An integer for a FLOAT input arrives as a float; null fits every type.
- `CALL` is a reading clause, so it works on a read-only graph. Aggregates in arguments and yielding a variable that is already bound (or twice) are `SemanticError`s.

## Ids (write mode)

- `{ kind: 'database' }` (the default): the database generates ids. Each `INSERT` uses `RETURNING id` so that later parts of the pattern can refer to the new entity. PostgreSQL does not guarantee row order for a multi-row `RETURNING`, so this mode inserts one entity per statement. Speed is not a goal for `CREATE`.
- `{ kind: 'generator', generate }`: the library calls the caller's function before inserting, so it knows every id up front.
- Ids supplied as properties in a query are ordinary properties. They never replace the internal id.

## Limits

Set for each graph; a query can lower them but never raise them. Exceeding a limit raises `LimitExceededError`. Results are never silently truncated.

| Limit                | Default | Behavior                                                                                                                                                |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxPathDepth`       | 10      | Upper bound for `[*]` and `[*n..]`. An explicit upper bound above it is rejected.                                                                       |
| `maxRowsPerStep`     | 100,000 | Each step runs with `LIMIT maxRowsPerStep + 1`; getting the extra row means the limit is exceeded. Also the paths one variable-length pattern may find. |
| `maxResultRows`      | 10,000  | Final records. The hint suggests adding `LIMIT`.                                                                                                        |
| `maxFrontierSize`    | 100,000 | Nodes carried from one breadth-first search depth to the next, summed over the start nodes.                                                             |
| `maxSteps`           | 32      | SQL steps in one read plan, including breadth-first search depths (counted as they run).                                                                |
| `timeoutMs`          | 30,000  | Total wall-clock time, checked between steps. Timeouts for single statements belong to the caller.                                                      |
| `maxCreatedEntities` | 100,000 | Nodes plus relationships created by one query, checked against all source rows before any insert.                                                       |

The defaults were checked against the reference graphs (#16, `npm run bench:limits`, [bench/README.md](bench/README.md#limits)):

- `maxPathDepth` 10: a shortest path search reaches every node of the 100,000-node graph within 6 hops, in about 450 ms. A depth cannot bound a variable-length pattern, though: its cost is the number of paths, about degree to the power of the depth (on a graph with 16 relationships per node, 1 million paths at depth 5 and 18 million, 47–94 seconds, at depth 6; on one with 4, 1.4 million at depth 10). So `maxRowsPerStep` also caps the paths of a pattern, which stops such a query in well under a second on PostgreSQL and in about 2 seconds on SQLite.
- `maxRowsPerStep` 100,000 and `maxResultRows` 10,000: returning 10,000 full nodes takes about 85 ms and 10 MB of heap, 90,000 about 670 ms and 65 MB. 100,000 paths take about 300 ms.
- `maxFrontierSize` 100,000: the largest frontier from one node on the 100,000-node graph is 46,000 nodes.
- `maxSteps` 32: a shortest path search to depth 10 needs 12 steps.
- `timeoutMs` 30 seconds: no measured query that stays within the other limits takes more than a few seconds. It cannot stop a single statement; the executor's statement timeout does that.

## Translation rules

| Cypher                                                            | SQL                                                                                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Node pattern `(a:Label {k: v})`                                   | Scan of the node table with label and property filters                                                                           |
| Fixed relationship `-[r:T]->`                                     | Join to the edge table on start and end ids                                                                                      |
| Undirected `-[r]-`                                                | Join on either direction with `OR`. As in Cypher, a relationship matches once per orientation that fits (a self-loop once)       |
| Several relationship patterns in one `MATCH`                      | `r1.id <> r2.id` for each pair (relationship uniqueness), including anonymous ones and ones bound by an earlier clause           |
| Inline property map `{k: v}` in `MATCH`                           | `n.k = v` per entry with Cypher equality: a missing property or a null never matches. A parameter map is an error                |
| `WHERE`                                                           | The expression compiler (see "Expressions"), with Cypher null semantics                                                          |
| `RETURN`, `SKIP`, `LIMIT`                                         | Direct equivalents; see below for `SKIP`/`LIMIT`                                                                                 |
| `ORDER BY`                                                        | Sort keys from `ExprCompiler.sortKeys`: aliases are substituted, then a JSON value sorts by type rank and then value             |
| `DISTINCT` with `ORDER BY`                                        | `SELECT * FROM (SELECT DISTINCT ..., <sort keys>) AS d ORDER BY d.k0, ...`; the keys may use only projected values               |
| Aggregates (`count`, `sum`, `avg`, `min`, `max`, `collect`)       | Two levels: SQL aggregates grouped by the non-aggregated items, then the items over those columns (see "Aggregation")            |
| Variable length `[*1..n]`                                         | Recursive CTE with an edge-id list per path, capped by `maxPathDepth` (see "Variable-length patterns")                           |
| `shortestPath` / `allShortestPaths`                               | Breadth-first search, one step per depth, joined back as bound paths (see "Shortest paths")                                      |
| Named path `p = ...`, `nodes(p)`, `relationships(p)`, `length(p)` | A JSON path value of tagged entities (see "Named paths")                                                                         |
| `OPTIONAL MATCH`                                                  | `LEFT JOIN (<new tables>) ON <pattern conditions and WHERE>` on both dialects (see "OPTIONAL MATCH")                             |
| `WITH`                                                            | A derived table per stage (see "WITH stages"); a separate step for large stages later (#14)                                      |
| `UNWIND`                                                          | A FROM item over the list: SQLite `json_each`, PostgreSQL `jsonb_array_elements ... WITH ORDINALITY`. Ordered by list position.  |
| List comprehensions, `all`/`any`/`none`/`single`                  | Correlated subquery over the unwound list (see "List expressions")                                                               |
| Pattern predicates, `EXISTS { }`, pattern comprehensions          | Correlated `EXISTS (SELECT ...)` or list subquery (see "Patterns in expressions")                                                |
| `CREATE` (write mode)                                             | `INSERT` per entity, in pattern order; once per source row after `MATCH`/`UNWIND`; RETURN over the written rows                  |
| `SET`, `REMOVE` (write mode)                                      | Per source row and item: a `SELECT` of the target and value as stored now, then `UPDATE` with a JSON merge patch or label change |

`SKIP` and `LIMIT` that are an integer literal or a parameter are bound values, checked to be non-negative integers when they're bound. Any other expression, such as `toInteger(rand() * 9)` or `$n + 1`, must not use variables or aggregates: that's a `SemanticError`, like Cypher's NonConstantExpression. Its SQL goes into the `LIMIT` or `OFFSET` as a one-row subquery, so it's computed once (`rand()` is drawn once). A value that's null, negative, or not an integer raises `CypherArgumentError` when the query runs. The final step's `LIMIT` is still the smaller of the query's and `maxRowsPerStep + 1`.

## Dialect differences

| Topic                 | PostgreSQL                                             | SQLite                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correlated joins      | `LATERAL`                                              | No `LATERAL`. Use correlated subqueries, table-valued `json_each`, or separate steps.                                                                                       |
| Join order            | Chosen from statistics                                 | `CROSS JOIN` fixes the order, so pattern tables use `JOIN ... ON 1`; inline property filters are marked selective with `likelihood()` so that a pattern starts there (#36). |
| Arrays                | Native arrays and `jsonb`                              | JSON text only                                                                                                                                                              |
| Path cycle check      | `= ANY` on an array of edge ids                        | `json_each` on a JSON array of edge ids                                                                                                                                     |
| Typing                | Strict; a failed cast raises an error                  | Type affinity; values can change type silently                                                                                                                              |
| `LIKE`                | Case sensitive                                         | Case-insensitive for ASCII. Use `instr` / `substr` for `CONTAINS` and `STARTS WITH`.                                                                                        |
| Read-only enforcement | `READ ONLY` transaction plus a role with only `SELECT` | Read-only connection or `PRAGMA query_only`                                                                                                                                 |
| Integer size          | `bigint`, with overflow errors                         | 64-bit integers; overflow silently becomes a float                                                                                                                          |

### MySQL

`mysql()` (`src/dialect/mysql.ts`) targets MySQL 8.0.17 or newer, tested on 8.4. JSON values are MySQL's `JSON` type, lists are unwound with `JSON_TABLE ... FOR ORDINALITY`, variable-length patterns and `range()`/`split()` use recursive CTEs, and id lists are JSON arrays. What differs from the other dialects:

- **Session settings.** The executor sets `PIPES_AS_CONCAT` (so the planner's `||` concatenates), removes `ONLY_FULL_GROUP_BY` (it does not see that a node's properties depend on its grouped id across a derived table), sets `utf8mb4_bin` as the connection collation, a large `group_concat_max_len`, and a large `cte_max_recursion_depth`. See [docs/executors.md](docs/executors.md).
- **Strings.** `utf8mb4_bin` is PAD SPACE (`'a' = 'a '` is true), so comparisons, sort keys, and string predicates add `COLLATE utf8mb4_0900_bin`, which compares code points with NO PAD. The connection keeps `utf8mb4_bin` because `JSON_UNQUOTE` returns it, and mixing the two in one expression is an error.
- **No `RETURNING`** (`Dialect.returning`): the executor returns the insert id of an `INSERT`, and the deletions that DELETE must remember are a `SELECT` of the ids and then a `DELETE` of those ids (`forgottenNodes`).
- **No `NULLS FIRST/LAST`** (`Dialect.nullsOrder`): a sort key `(x IS NULL)` comes first. **`LIMIT`** takes only a literal or a parameter (`Dialect.limitExpressions`), so `SKIP`/`LIMIT` expressions are an `UnsupportedFeatureError`.
- **Ordered JSON lists** come from `GROUP_CONCAT(... ORDER BY ...)` of the values' JSON text (`JSON_ARRAYAGG` has no `ORDER BY`).
- **Run-time errors** are raised with `UUID_TO_BIN('<marker>')`, whose error message quotes its argument. The window function of the variable-length row cap is in its own derived table, because MySQL evaluates the other parts of an expression with a window function up front, the raise included.
- **`JSON_TABLE`** fails on a subquery argument or on a column of a derived table merged into the query, so its input comes from a `LATERAL` derived table with a `LIMIT` (neither merged nor a subquery).
- **No NaN or infinity**: a float division by zero is null (NaN is null on SQLite too). JSON numbers are compared as `DOUBLE`, so integers beyond 2^53 compared with a JSON value can be off.
- **Temporal functions and arithmetic on values from the query** are an `UnsupportedFeatureError` (`temporalCall` and `temporalArithmetic` are undefined; there is no SQL port yet). Calls with literal or parameter arguments run in the library and work.
- **Indexes.** A declared integer or float property is read with the same expression as a functional index on it (`CAST(JSON_EXTRACT(properties, '$."age"') AS SIGNED)`), which MySQL uses. MySQL does not use a functional index for the string form, so declared strings are scanned.
- **Undirected variable-length patterns** (`Dialect.recursiveBranches`). MySQL uses no index for the join `ON start_id = t OR end_id = t` and scans every edge for each path. So the recursive CTE has one recursive `SELECT` per direction, and the incoming one skips self-loops (`start_id <> t`), which the outgoing one already followed. PostgreSQL allows only one recursive `SELECT`, and SQLite uses both indexes for the `OR`.

## Semantics that need care

- **Nulls.** Cypher and SQL mostly agree on three-valued logic. Lists, maps, and `IN` with nulls do not always agree. Test each case.
- **Failed casts** return null in Cypher. Use safe-cast helpers in both dialects.
- **Numbers.** Integer division truncates, and integer overflow is an error. Map both exactly in each dialect.
- **Mixed-type comparisons** return null in Cypher; SQL raises an error or converts.
- **Sort order.** Cypher defines a global order across types: map < node < relationship < list < string < boolean < number < null, ascending. Typed values use `NULLS LAST` (ascending) or `NULLS FIRST` (descending) explicitly; JSON values sort by a type rank first, with null ranked last. Lists sort element by element; maps by their JSON text. Within ORDER BY ties, UNWIND order is kept.
- **Strings.** Comparison is case sensitive and by code point: `COLLATE "C"` on PostgreSQL, the default BINARY collation on SQLite. `STARTS WITH`, `ENDS WITH`, and `CONTAINS` never use `LIKE` (case-insensitive on SQLite, and `%`/`_` are wildcards).
- **Regular expressions.** `=~` (an extension to openCypher 9, as in Neo4j) matches a Java regular expression against the whole string; a value that is not a string gives null, and an invalid pattern is a `CypherArgumentError` (`InvalidRegex`). PostgreSQL runs it with `~` on `\A(?: ... )\Z`, with Java's leading flags `(?imsx)` turned into ARE's (`.` does not match a newline unless `s`). SQLite has no regular expressions, so `=~` needs `sqlite({ functions: true })` (see "SQLite functions"): `cypher_regex()` compiles the pattern as a JavaScript RegExp. Both engines share the common syntax (classes, `\d\w\s`, quantifiers, groups, alternation, lookahead); flags inside the pattern (`a(?i)b`), possessive quantifiers, and `\Q...\E` are invalid patterns here.
- **NaN.** PostgreSQL treats `NaN = NaN` as true and NaN as larger than every number. A comparison with a native float side therefore checks for NaN first (`Dialect.isNaN`): in Cypher NaN is equal to nothing, not even itself (so `<>` is true), and ordered against nothing. Integer comparisons stay plain SQL, so indexes still serve them. JSON has no NaN or infinity, so on PostgreSQL a float that is one becomes a tagged object in JSON (`{"~cypher": "float", "~s": "NaN"}`, also `"Infinity"` and `"-Infinity"`). `jsonType` reads it as a float, `fromJson` gives the number (numeric NaN and infinities sort above every number, as in Cypher), comparisons of JSON numbers get the NaN check too, and results turn it back into a JS number. So `[0.0 / 0.0]`, `UNWIND`, and `ORDER BY` across types keep NaN. (Lists that contain NaN still compare equal to each other; Cypher says they don't.) SQLite has no NaN at all (`0.0 / 0.0` is null there, and a REAL cannot hold NaN), so NaN comparisons are null on SQLite instead of following Cypher.
- **Integer errors.** SQLite turns integer overflow into a float and integer division by zero into null; the SQL checks for both and raises a `CypherArgumentError`, as PostgreSQL's own errors become (see "Run-time errors").
- **Unbounded paths.** `[*]` without an upper bound is capped by `maxPathDepth`.
- **Row order.** `MATCH` order is undefined, but `UNWIND` order is defined, so plans with `UNWIND` order by every FROM item in clause order (nested-loop order).

## Testing

- **openCypher TCK** (`vendor/openCypher`, pinned submodule). `test/tck` parses the Gherkin features with `@cucumber/gherkin` and generates one vitest test per scenario and dialect. Setup runs on a write graph; the query runs on a read-only graph, which also tests the gate on every scenario. A scenario that hits an unsupported feature is skipped with that reason. `test/tck/allow-list.json` lists the scenarios that must pass, by dialect.
- **Unit tests** for each stage, and emitted-SQL snapshots per dialect (#4).
- **Differential tests** (`npm run test:diff`, [diff/README.md](diff/README.md)): a query corpus on both dialects and on two reference engines, Neo4j and ArcadeDB, which runs Cypher through its own engine. A result where both references agree and this library differs fails the run, unless the corpus marks it as a known difference with the reason. Where the references disagree with each other, the TCK decides.
- **Benchmarks** (`npm run bench`, [bench/README.md](bench/README.md)): a query corpus on seeded reference graphs of different sizes and densities, on both dialects, with a recorded baseline to compare against. The differential tests use the same graphs.
- Treat a difference between the two dialects on the same scenario as a failure.

## Risks

- **Path search performance** on dense or large graphs. Mitigated by required depth bounds, row caps, multi-step search, indexes on start and end ids, and benchmarks.
- **Semantic drift** from a graph database (nulls, ordering, duplicate rows). Mitigated by the TCK and differential tests.
- **Dialect divergence** from SQLite's loose typing and missing `LATERAL`. Mitigated by running every TCK scenario on both dialects.
- **Consistency across steps** depends on the caller's executor running every step in one transaction. The executor interface requires a transaction, and the example executors show the isolation level.
- **Scope growth toward full Cypher.** Mitigated by the feature gate and the non-goals.
