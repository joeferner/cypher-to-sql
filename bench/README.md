# Benchmarks

`npm run bench` runs a corpus of Cypher queries on generated reference graphs, in SQLite (`better-sqlite3`, in memory) and PostgreSQL, and prints the median time of each query.

```sh
npm run db:up                                   # PostgreSQL for the postgres runs
npm run bench                                   # graphs small, medium, dense; both dialects
npm run bench -- --graphs large --dialects postgres
npm run bench -- --filter shortest              # only queries whose name contains "shortest"
npm run bench -- --compare bench/baseline.json  # ratio to the baseline; ⚠ marks > 1.5x slower
npm run bench -- --save bench/baseline.json     # record a new baseline
npm run bench:limits                            # the measurements behind the default limits
npm run bench:writes                            # batched writes (see "Writes" below)

npm run db:up:reference                         # also Neo4j and ArcadeDB
npm run bench -- --graphs medium,dense,large --dialects sqlite,postgres,neo4j,arcadedb
```

Options: `--runs` (timed runs per query, default 5) and `--budget` (milliseconds of timed runs per query, default 3000; a query slower than that runs twice). PostgreSQL comes from `BENCH_POSTGRES_URL` or `TEST_POSTGRES_URL`, Neo4j from `NEO4J_URL`, and ArcadeDB from `ARCADEDB_URL` (the compose defaults otherwise). Each graph is loaded into the schema `bench_<graph>`, which stays after the run so that plans can be inspected with `EXPLAIN` (`graph.compile(cypher).explain()` prints the SQL).

## Files

- [graphs.ts](graphs.ts): the reference graphs. Seeded, so every database gets the same graph. 90% `Person` nodes (name, age, city, score) and 10% `Company` nodes; each person `KNOWS` `degree` others (70% near it in id order, which makes clusters and long paths) and `WORKS_AT` one company.

  | Graph    | Nodes   | Relationships | KNOWS degree           |
  | -------- | ------- | ------------- | ---------------------- |
  | `small`  | 1,000   | 4,500         | 4                      |
  | `medium` | 10,000  | 45,000        | 4                      |
  | `dense`  | 10,000  | 153,000       | 16                     |
  | `large`  | 100,000 | 450,000       | 4 (not run by default) |

- [load.ts](load.ts): loads a graph with the [example schema](../examples/schema) and its indexes, plus expression indexes for `name` and `age`, which the `declared` queries declare in the mapping.
- [queries.ts](queries.ts): the corpus. Queries whose cost grows too fast skip the bigger graphs.
- [baseline.json](baseline.json): the last recorded results, with the commit, Node.js version, and CPU. Timings depend on the machine; compare runs on the same one.
- [engines.ts](engines.ts): Neo4j and ArcadeDB as benchmark targets. They load the same graph with the differential tests' statements ([diff/engines.ts](../diff/engines.ts)) and indexes comparable to load.ts: `Person(name)`, `Person(age)`, and the `gid` key the loader matches relationships by. A query is timed until its rows arrive; they are counted, not converted.
- [comparison.json](comparison.json): the results of the four-engine run below.

## Compared with Neo4j and ArcadeDB (#47)

The whole corpus, unchanged, on all four engines. Median milliseconds of 5 runs after a warm-up, on the large graph (100,000 nodes, 450,000 relationships). The medium and dense graphs are in [comparison.json](comparison.json). Every engine returned the same number of rows for every query.

| Query                                   | SQLite | PostgreSQL |  MySQL | Neo4j | ArcadeDB |
| --------------------------------------- | -----: | ---------: | -----: | ----: | -------: |
| lookup by name (undeclared)             |    102 |        115 |    320 |   2.3 |      1.3 |
| lookup by name (declared, indexed)      |    0.3 |        1.2 |  110\* |   2.6 |      1.3 |
| range filter count (undeclared)         |     84 |        263 |    217 |   3.1 |       23 |
| range filter count (declared)           |    4.1 |         10 |     31 |   2.8 |       20 |
| order by limit                          |    504 |        739 |    576 |    54 |      196 |
| one hop                                 |    0.4 |        2.0 |  989\* |   2.3 |      1.7 |
| two hops distinct                       |    0.6 |        4.3 |  991\* |   2.7 |      2.3 |
| aggregate by company                    |    147 |        115 |    699 |    42 |       81 |
| var-length `*1..2` from one node        |     54 |        2.1 |  280\* |   2.4 |      2.8 |
| var-length `*1..3` from one node        |     72 |        2.3 |  240\* |   2.2 |      3.1 |
| var-length `*1..3` between two nodes    |    4.5 |        5.7 | 238\*† |   3.8 |      5.1 |
| `shortestPath` near (multi-step)        |   4.9‡ |        11‡ | 246\*‡ |   2.7 |      2.3 |
| `shortestPath` far (multi-step)         |   6.5‡ |        15‡ | 293\*‡ |   3.2 |      3.2 |
| `allShortestPaths` near (multi-step)    |   3.9‡ |       9.8‡ | 236\*‡ |   3.0 |      8.8 |
| shortest path as one statement (`*..3`) |    5.1 |         10 | 321\*† |   2.5 |      4.4 |
| optional match count                    |    282 |        481 |    787 |    58 |      160 |
| pattern predicate (no incoming)         |    127 |         78 |  1,130 |    36 |      199 |
| pattern comprehension degree            |     20 |         43 |     95 |   4.4 |       19 |
| collect, comprehension, slice           |    2.0 |        6.6 |  907\* |   2.6 |      2.1 |
| `WITH` stages                           |    237 |        141 |    633 |   166 |      256 |

\* These start at a node by its declared `name`, which MySQL scans: it does not use a functional index for a declared string (see [DESIGN.md](../DESIGN.md#mysql)).
† After #62, which made undirected variable-length patterns on MySQL one recursive step per direction (before: 21,773 ms and 22.6 s). On the large graph, `p40` is 4 hops from `p1`, so `*..3` finds no path on any engine.
‡ After #67, which searches from both ends of a pair (before: SQLite 8.8, 12, and the limit; PostgreSQL 16, 17, and the limit; MySQL 259, 260, and the limit).

Setup: Intel i7-10510U laptop, commit `70eb8fa` (MySQL: the commit that added it, 3 runs per query). PostgreSQL 18, MySQL 8.4, Neo4j 2026.10 Community, and ArcadeDB 26.11 run in Docker with the compose settings: PostgreSQL's defaults, MySQL with a 256 MB buffer pool, Neo4j with a 1 GB heap and a 256 MB page cache, ArcadeDB with a 1 GB heap. SQLite runs in memory in the same process, so it pays no network round trip. Neo4j and ArcadeDB pay one over Bolt or HTTP, about 2 ms here, which is the floor of their numbers. Load times aren't compared: SQL is bulk-inserted, while the reference engines load through batched Cypher, not their bulk importers.

What it shows:

1. **Indexed lookups and short patterns from a known node are as fast or faster.** With declared properties, a lookup, one hop, or two hops take 0.3–4 ms. That's the same as the native engines' round trip, and SQLite has none.
2. **Undeclared properties are the big gap for filters.** Without a declared type, `name = $a` scans every node's JSON: 100 ms against 2 ms. Declaring the key closes it.
3. **Scans and aggregates over the whole graph are 2–9 times slower than Neo4j,** and often close to ArcadeDB: ORDER BY with LIMIT, OPTIONAL MATCH counts, aggregates, and pattern predicates. Each reads properties from JSON and filters labels in a JSON array.
4. **Path search is the other big gap, except for shortest paths.** From one node, PostgreSQL's recursive CTE is on par (about 2 ms), but SQLite's is 25–30 times slower on the large graph. On the dense graph, `*1..3` between two nodes takes 120–170 ms against 32–36 ms. Shortest paths search from both ends, as Neo4j and ArcadeDB do (#67): a pair 6 apart on the large graph reads about 1,100 edges instead of 127,000, so the far shortest path takes 6.5 ms on SQLite and 15 ms on PostgreSQL (it used to exceed `maxRowsPerStep`), and 9–11 ms on the dense graph (60–73 ms before). The rest of the gap is one SQL statement per depth, against pointer chasing in memory.
5. **Typed storage (#26) would help 2 and 3, but not 4.** Properties in real columns and a table per label would serve undeclared filters and whole-graph scans. Path search is bound by the SQL search itself (a recursive CTE or one breadth-first step per depth), which typed tables don't change.
6. **MySQL is the slowest of the SQL engines here.** Point 1 doesn't hold on MySQL, which scans for a declared string (`name`), so everything that starts at a named node takes 0.1–1 s on the large graph. Its JSON functions are slower on scans and aggregates (2–5 times PostgreSQL). Declared integers are indexed (31 ms for the range count). MySQL can't use an index for an `OR` join, so an undirected variable-length pattern follows each direction in its own recursive step (#62); with one `OR` step it scanned every edge per path, and `*1..3` between two nodes took 22 s.

## Writes (#69)

`npm run bench:writes` loads batches the way an application ingests files: one `UNWIND $rows AS row ...` query per batch, on a fresh graph whose node `key` is indexed: for this library declared as an integer (`migrate`), on Neo4j and ArcadeDB an index on `Item(key)` (`--dialects neo4j,arcadedb`, after `npm run db:up:reference`; it empties Neo4j's database, which `npm run bench` loads again). It counts the SQL statements each batch becomes, runs an untimed round of 100 rows first so that every engine is timed warm, and checks afterwards that the nodes, properties, and relationships are all there exactly once. Options: `--dialects`, `--sizes` (rows per batch, default `1000,2000`), `--ids` (`database,generator`), and `--save`.

| Workload                   | Query                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------- |
| CREATE, properties inline  | `CREATE (:Item {key: row.key, name: row.props.name, ...})`                            |
| CREATE, then SET +=        | `CREATE (n:Item {key: row.key}) SET n += row.props`                                   |
| MERGE, nodes new / exist   | `MERGE (n:Item {key: row.key}) SET n += row.props`, on an empty graph / the same rows |
| CREATE relationships       | `MATCH (a:Item {key: row.from}) MATCH (b:Item {key: row.to}) CREATE (a)-[:LINK]->(b)` |
| MERGE, relationships exist | the same with `MERGE (a)-[:LINK]->(b)`, after the CREATE                              |

Rows per second, batches of 1,000, on the laptop of the comparison above (this library with ids from the database; the statements per row are the same with generated ids):

| Workload                   | Statements per row | SQLite | PostgreSQL | MySQL |  Neo4j | ArcadeDB |
| -------------------------- | -----------------: | -----: | ---------: | ----: | -----: | -------: |
| CREATE, properties inline  |                  1 | 10,453 |      3,447 | 3,780 | 10,820 |   35,567 |
| CREATE, then SET +=        |                  3 |    718 |        390 | 1,014 |  9,566 |   17,360 |
| MERGE, nodes new           |                  4 |    317 |        173 |   292 | 23,282 |   13,144 |
| MERGE, nodes exist         |                  3 |    261 |        139 |   207 |  7,719 |   22,769 |
| CREATE relationships       |                  1 |    505 |        142 |   189 | 10,652 |   18,292 |
| MERGE, relationships exist |                  1 |    336 |         87 |   158 |  8,948 |   22,182 |

With the generator id strategy, CREATE with inline properties runs at 12,976 (SQLite), 5,729 (PostgreSQL), and 7,619 (MySQL) rows per second; the other workloads cost the same.

Batches of 1,000 against 2,000 (each on a graph of that size), rows per second:

| Workload                   | SQLite 1,000 | SQLite 2,000 | Neo4j 1,000 | Neo4j 2,000 | ArcadeDB 1,000 | ArcadeDB 2,000 |
| -------------------------- | -----------: | -----------: | ----------: | ----------: | -------------: | -------------: |
| CREATE, properties inline  |       10,453 |       12,638 |      10,820 |      36,817 |         35,567 |         41,802 |
| MERGE, nodes exist         |          261 |          188 |       7,719 |      18,145 |         22,769 |         22,938 |
| CREATE relationships       |          505 |          230 |      10,652 |      11,380 |         18,292 |         16,521 |
| MERGE, relationships exist |          336 |          199 |       8,948 |      13,286 |         22,182 |         28,039 |

What it shows:

1. **CREATE with the properties inline is the fast path:** one INSERT per row, linear in the batch, 3,400–13,000 rows per second; on SQLite as fast as Neo4j. `SET n += row.props` adds a SELECT and an UPDATE per row and is 4–15 times slower; Neo4j and ArcadeDB pay little for it.
2. **The generator id strategy speeds up plain CREATE** up to 2 times (no `RETURNING` and no id to read back per row); everything else costs the same. The statement count does not depend on it.
3. **Finding nodes by a value from the row does not use the index (#77),** so MERGE and MATCH by `row.key` are 20–160 times slower than in Neo4j and ArcadeDB, and get slower per row as the graph grows: doubling the batch (and the graph) roughly triples the time, where the native engines stay flat. The declared index serves a comparison with a parameter, but not with a row value, which scans the index once per row. Until #77, a batch costs about batch size × graph size, so smaller batches do not help.
4. **One query per row with parameters stays linear** (`MERGE (n:Item {key: $key}) SET n.name = $name`, one `graph.query` each): on SQLite, 830–1,150 MERGEs and 1,000–2,000 relationships per second at 1,000, 2,000, and 4,000 nodes, where the batched MERGE drops to 190 rows per second at 2,000.

## Findings (baseline, medium graph)

Median milliseconds on 10,000 nodes and 45,000 relationships (Intel i7-10510U, PostgreSQL 18 in Docker):

| Query                                   | SQLite | PostgreSQL |
| --------------------------------------- | -----: | ---------: |
| lookup by name (undeclared)             |     14 |         17 |
| lookup by name (declared, indexed)      |    0.4 |        1.2 |
| range filter count (declared)           |    0.7 |        2.2 |
| one hop                                 |    0.5 |        2.2 |
| two hops distinct                       |    0.8 |        3.6 |
| aggregate by company                    |     22 |         31 |
| pattern predicate (no incoming)         |     11 |         20 |
| `WITH` stages                           |     21 |         38 |
| var-length `*1..3` from one node        |    7.6 |        3.1 |
| var-length `*1..3` between two nodes    |    2.9 |        6.1 |
| var-length `*1..2` into one node        |  limit |      limit |
| `shortestPath` (multi-step search)      |    3.5 |        8.3 |
| shortest path as one statement (`*..3`) |    4.3 |        8.1 |

1. **SQLite joined in a fixed order (fixed, #36).** The planner joined the tables of a pattern with `CROSS JOIN`, which SQLite (unlike PostgreSQL) takes as a fixed join order, so `(:Person)-[:WORKS_AT]->(c:Company)` paired every person with every company: aggregation, pattern predicates, and `WITH` stages took 20–29 seconds on SQLite. Plain inner joins (`JOIN ... ON 1`) let SQLite choose; inline property filters are marked selective (`likelihood`), so a pattern starts at its filtered node even without an index.
2. **Variable-length patterns explored from every node (fixed for a known start, #14).** The recursive CTE cannot refer to the outer query, so it started at every node: `*1..3` between two given nodes took 10–12 seconds. It now starts at the nodes the rows so far allow, given by a self-contained subquery (see DESIGN.md, "Variable-length patterns"), and takes 30–40 ms. A pattern whose filter is on its end node (`(f)-[*1..2]->(p {name: $a})`) still starts everywhere: here it finds 180,000 paths, more than `maxRowsPerStep`, and raises `LimitExceededError` (it took 215–450 ms before that cap, #16).
3. **Multi-step search is the better shortest path.** Before #14 the single statement (every path up to length 3, the shortest kept) took 12–16 seconds against 30–40 ms for the breadth-first search. Seeded, the single statement is as fast here, but its cost still grows with the number of paths up to the bound (on the dense graph 130–200 ms for 3 hops), while the search stops at the first depth that reaches the target and goes to 10 hops.
4. **A parameter compared with a declared property did not use the index (fixed, #37).** `(p:Person {name: $a})` on a declared, indexed `name` took 9–11 ms: the parameter's type is known only at run time, so the comparison checked it in SQL, which no index can serve. The plan runner now binds the parameter as a value of the property's type, with a separate flag for whether its type fits (see DESIGN.md, "Declared property types"); the lookup takes 0.4–1.2 ms, and every query that starts at a named node got 3–20 times faster.
5. **Undeclared properties are scanned.** Lookups and filters on undeclared keys read every candidate row; declare the keys that queries filter on (see [Schema](../docs/schema.md#properties)).

## Limits

`npm run bench:limits` measures what the default limits guard against (#16), on the medium, dense, and large graphs. Results from the baseline machine:

| Measurement                                                            | Result                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Nodes per depth of a search from one node, large graph (100,000 nodes) | 9, 66, 376, 2,184, 12,549, 45,980, 28,633, 202: all within 8 hops |
| Shortest path to a far node, large graph                               | 6 hops, about 450 ms on both dialects                             |
| Paths of `*1..d` from one node, medium graph (4 per node)              | depth 8: 86,000 in 0.3 s; depth 10: 1.4 million in 4–6 s          |
| Paths of `*1..d` from one node, dense graph (16 per node)              | depth 4: 70,000 in 0.2 s; depth 6: 18 million in 47–94 s          |
| Returning 10,000 / 90,000 full nodes, large graph                      | 85 ms and 10 MB / 670 ms and 65 MB                                |

6. **The depth does not bound a variable-length pattern; the number of paths does (fixed, #16).** An unbounded `[*]` goes up to `maxPathDepth` (10), and on a dense graph depth 6 already means 18 million paths and minutes. `maxRowsPerStep` now also caps the paths of one pattern: the depth-6 query raises `LimitExceededError` after 0.3 s on PostgreSQL and 2.3 s on SQLite. The other defaults hold up (DESIGN.md, "Limits").
