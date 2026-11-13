# Benchmarks

`npm run bench` runs a corpus of Cypher queries on generated reference graphs, in SQLite (`better-sqlite3`, in memory) and PostgreSQL, and prints the median time of each query.

```sh
npm run db:up                                   # PostgreSQL for the postgres runs
npm run bench                                   # graphs small, medium, dense; both dialects
npm run bench -- --graphs large --dialects postgres
npm run bench -- --filter shortest              # only queries whose name contains "shortest"
npm run bench -- --compare bench/baseline.json  # ratio to the baseline; ⚠ marks > 1.5x slower
npm run bench -- --save bench/baseline.json     # record a new baseline
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
| lookup by name (declared, indexed)      |      9 |         11 |
| range filter count (declared)           |    0.9 |        2.3 |
| one hop                                 |     20 |         17 |
| aggregate by company                    | 28,585 |         31 |
| pattern predicate (no incoming)         | 21,237 |         18 |
| `WITH` stages                           | 27,360 |         30 |
| var-length `*1..3` from one node        |  1,740 |        833 |
| var-length `*1..3` between two nodes    | 12,211 |      9,823 |
| `shortestPath` (multi-step search)      |     38 |         29 |
| shortest path as one statement (`*..3`) | 15,692 |     11,969 |

1. **SQLite joins in a fixed order.** The planner joins the tables of a pattern with `CROSS JOIN`, which SQLite (unlike PostgreSQL) treats as a fixed join order. `(:Person)-[:WORKS_AT]->(c:Company)` therefore pairs every person with every company before it looks at a relationship. Queries with more than one node scan take seconds on SQLite and milliseconds on PostgreSQL. Plain inner joins would let SQLite choose the order.
2. **Variable-length patterns explore from every node.** The recursive CTE cannot start at a bound node (see DESIGN.md), so its cost grows with the whole graph, not the neighborhood: `*1..3` between two given nodes takes 10 seconds on 10,000 nodes. This is #14 (seeding the search from bound nodes in a separate step).
3. **Multi-step search wins for shortest paths.** The breadth-first search takes 30–40 ms where the single statement (every path up to length 3, the shortest kept) takes 12–16 seconds, and it reaches 10 hops instead of 3.
4. **A parameter in a property map does not use the index.** `(p:Person {name: $a})` on a declared, indexed `name` takes 9–11 ms, while a declared range filter takes 1–2 ms: the parameter's type is known only at run time, so the comparison checks it in SQL, which no index can serve.
5. **Undeclared properties are scanned.** Lookups and filters on undeclared keys read every candidate row; declare the keys that queries filter on (see [Schema](../docs/schema.md#properties)).
