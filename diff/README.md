# Differential tests

`npm run test:diff` runs a query corpus on this library (SQLite and PostgreSQL) and on two reference engines, Neo4j and ArcadeDB, and compares the results. ArcadeDB runs Cypher through its own engine, so it is an independent second reference: a result where Neo4j and ArcadeDB agree and this library differs is very likely a bug here.

```sh
npm run db:up:reference                       # PostgreSQL, Neo4j, and ArcadeDB (compose.yaml)
npm run test:diff                             # the whole corpus
npm run test:diff -- --graph social           # one graph
npm run test:diff -- --filter shortestPath    # queries whose text contains "shortestPath"
npm run test:diff -- --verbose                # also print the queries where all agree
```

The engines are reached at `TEST_POSTGRES_URL`, `NEO4J_URL` (default `bolt://localhost:57687`), and `ARCADEDB_URL` (default `http://localhost:52480`). The compose file pins the versions; set `NEO4J_VERSION` or `ARCADEDB_VERSION` to try others.

## Verdicts

Each query gets a verdict for each configuration of this library (each dialect, and on the social graph each dialect again with declared property types):

| Verdict            | Meaning                                                     | Fails the run |
| ------------------ | ----------------------------------------------------------- | ------------- |
| `agree`            | Same result as both references                              | no            |
| `differs`          | The references agree with each other, this library does not | yes           |
| `known`            | Differs, and the corpus says why (`known` on the query)     | no            |
| `arcadedb differs` | Same result as Neo4j only                                   | no            |
| `neo4j differs`    | Same result as ArcadeDB only                                | no            |
| `all differ`       | No two engines agree                                        | no            |
| `unsupported`      | This library raised `UnsupportedFeatureError`               | no            |

When the references disagree with each other, the TCK decides which side is right. Any error counts as the same result as any other error: the tests compare whether a query fails, not the message.

## How results compare

Every engine's values become one text form ([values.ts](values.ts)): integers and floats stay apart (`1` and `1.0` differ), map keys and labels are sorted, floats are rounded to 12 significant digits (engines sum in different orders), and entity ids are left out. Rows compare as a multiset, or in order when the final `RETURN` has `ORDER BY`, so the corpus keeps results deterministic: full sort keys, and no `collect()` over rows in undefined order.

## Files

- [corpus.ts](corpus.ts): the queries, grouped by graph. `edge_cases` is built by one `CREATE` (nulls, mixed types, several labels, a self-loop, parallel relationships); `social` is the `small` reference graph of the [benchmarks](../bench/README.md) (1,000 nodes, 4,500 relationships), with each node's id as its `gid` property.
- [engines.ts](engines.ts): loads a graph into each engine and runs queries. This library loads graphs with the [benchmark loader](../bench/load.ts) or its own write mode; the references get the same nodes and relationships through Cypher. Neo4j is reached with `neo4j-driver` over Bolt, ArcadeDB over its HTTP API with the `opencypher` language.
- [run.ts](run.ts): runs the corpus and prints the differences and a summary.

## Known differences

The corpus marks these with `known`:

- `EXISTS { MATCH ... }` without `RETURN` and map projections (`n {.name}`) are outside the openCypher 9 grammar, so they fail to parse here.

Two results where only ArcadeDB differs: it returns `false` for an invalid regular expression (Neo4j and this library raise an error) and for `=~` on a value that is not a string (null in Neo4j and here).
