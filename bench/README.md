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
```

Options: `--runs` (timed runs per query, default 5) and `--budget` (milliseconds of timed runs per query, default 3000; a query slower than that runs twice). PostgreSQL comes from `BENCH_POSTGRES_URL` or `TEST_POSTGRES_URL`. Each graph is loaded into the schema `bench_<graph>`, which stays after the run so that plans can be inspected with `EXPLAIN` (`graph.compile(cypher).explain()` prints the SQL).

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
