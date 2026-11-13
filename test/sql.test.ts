// Emitted SQL for each dialect. A change in the snapshot is a change in the SQL
// every caller runs: review it like code (`vitest run -u` to accept).

import { describe, expect, it } from 'vitest';
import { createGraph, postgres, sqlite, type Graph, type SqlExecutor } from '../src/index.js';

const executor: SqlExecutor = {
  transaction: () => Promise.reject(new Error('compile only')),
};

const readQueries = [
  'MATCH (n) RETURN n LIMIT 10',
  'MATCH (n:Person:Admin) RETURN n.name AS name, n',
  'MATCH (a:A), (b) RETURN *',
  "RETURN 1 AS i, 1.5 AS f, 'x' AS s, [1, null] AS l, {k: true} AS m, $p AS p",
  'UNWIND [1, 2] AS x RETURN x',
  'UNWIND $lists AS l UNWIND l AS x MATCH (n:N) RETURN n.k, x LIMIT $max',
  'UNWIND [{a: {b: 1}}] AS m RETURN m.a.b',
  'MATCH (a:A {k: 1})-[r:T {w: $w}]->(b) RETURN a, r, b',
  'MATCH (a)<-[:T|U]-(b)-[r]-(c) RETURN r.w',
  'MATCH (a)-[r]->(b) MATCH (b)-[r2]->(c), (c)-[r]->(a) RETURN r2',
  'MATCH (n) WHERE n.age > 30 AND n.name STARTS WITH $p RETURN n.name, n.age + 1 AS next',
  'MATCH (n) RETURN n.name AS name ORDER BY name DESC, n.age SKIP $s LIMIT 10',
  'MATCH (n) RETURN DISTINCT n.name AS name ORDER BY name',
  "MATCH (n) WHERE toLower(n.name) STARTS WITH 'a' RETURN size(labels(n)), coalesce(n.x, 0), range(1, $n)",
  'MATCH (n) RETURN n.team AS team, count(*) AS c, max(n.age) - min(n.age) AS spread ORDER BY c DESC',
  'MATCH (n)-->(m) RETURN n, collect(DISTINCT m.name), avg(m.age)',
  'MATCH (n) WITH n, count(*) AS c WHERE c > 1 MATCH (n)-->(m) RETURN m.name ORDER BY m.name',
  'UNWIND $xs AS x WITH x ORDER BY x DESC LIMIT 3 RETURN x',
  'MATCH (p) OPTIONAL MATCH (p)-[r:R]->(q) WHERE r.w > 1 RETURN p, q',
  'OPTIONAL MATCH (x:Missing) RETURN x',
  'MATCH (a:A)-[r:T*1..3 {k: 1}]->(b)-[s]-(c) RETURN r, b',
  'MATCH (a)-[*]-(b), (b)<-[*0..2]-(c) RETURN count(*)',
  'MATCH p = (a)-[r]->(b)-[*1..2]->(c) RETURN p, length(p), nodes(p)',
  'MATCH (a:A {k: 1}), (b:B) MATCH p = shortestPath((a)-[:T* {w: 1}]->(b)) RETURN p',
  'MATCH (n) WHERE any(t IN n.tags WHERE t STARTS WITH $p) RETURN [t IN n.tags WHERE t <> $p | toUpper(t)]',
  'MATCH (n) RETURN n.list[0], n.list[1..-1], n[$key], all(x IN [1, 2] WHERE x < n.max)',
  "MATCH (n) RETURN CASE n.k WHEN 1 THEN 'one' ELSE 'other' END, CASE WHEN n.k > 1 THEN n.k END",
  'MATCH (n) WHERE (n)-[:T]->() AND NOT EXISTS { (n)<-[r]-(m) WHERE r.w > m.w } RETURN [(n)-->(x) | x.k]',
  'MATCH (n) WHERE EXISTS { MATCH (n)-->(m) WITH n, count(*) AS c WHERE c > 2 RETURN c } RETURN n',
  'MATCH (a), (b) WHERE a.k < b.k MATCH p = allShortestPaths((a)-[*..4]-(b)) RETURN length(p)',
];

const writeQueries = [
  'CREATE ()',
  "CREATE (a:A {name: 'x', n: null})-[:T {w: 1.5}]->(b:B $props)<-[:U]-(a)",
  'UNWIND $rows AS row CREATE (:N {v: row.v})',
  'MATCH (a:A), (b:B) CREATE (a)-[:T {k: a.k}]->(b), (b)-[:BACK]->(:New)',
  'CREATE (a {v: 1 + 2})-[r:T]->(b {w: a.v}) WITH a, r, b WHERE a.v > 1 RETURN a, r, b.w',
];

for (const dialect of [sqlite(), postgres()]) {
  describe(dialect.name, () => {
    const read = createGraph({ dialect, executor });
    const write = createGraph({ dialect, executor, readOnly: false });
    let next = 1;
    const generated = createGraph({
      dialect,
      executor,
      readOnly: false,
      idStrategy: { kind: 'generator', generate: () => next++ },
    });

    const snapshot = (graph: Graph, cypher: string): void => {
      expect(`${cypher}\n${graph.compile(cypher).explain()}`).toMatchSnapshot();
    };

    it.each(readQueries)('read: %s', (cypher) => snapshot(read, cypher));
    it.each(writeQueries)('create with database ids: %s', (cypher) => snapshot(write, cypher));
    it.each(writeQueries)('create with generated ids: %s', (cypher) => snapshot(generated, cypher));
  });
}
