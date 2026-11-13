// The benchmark query corpus. Each query runs on every graph and dialect.

import type { CypherValue } from '../src/index.js';
import type { Graph } from './graphs.js';

export interface BenchQuery {
  name: string;
  cypher: string;
  params: (graph: Graph) => Record<string, CypherValue>;
  /** Run on the graph whose mapping declares `name` and `age` (see load.ts). */
  declared?: boolean;
  /** Graphs to skip, for queries whose cost grows too fast to run there. */
  skip?: string[];
}

/** A person near the start of the id range, one in the middle, and one a few hops from the first. */
const people = (g: Graph): Record<string, CypherValue> => ({
  a: 'p1',
  near: 'p40',
  far: `p${Math.floor(g.persons / 2)}`,
});

export const QUERIES: BenchQuery[] = [
  // Lookups and filters, with undeclared (JSON) and declared (typed, indexed) properties.
  {
    name: 'lookup by name',
    cypher: 'MATCH (p:Person {name: $a}) RETURN p.age AS age',
    params: people,
  },
  {
    name: 'lookup by name (declared)',
    cypher: 'MATCH (p:Person {name: $a}) RETURN p.age AS age',
    params: people,
    declared: true,
  },
  {
    name: 'range filter count',
    cypher: 'MATCH (p:Person) WHERE p.age > 75 RETURN count(*) AS n',
    params: () => ({}),
  },
  {
    name: 'range filter count (declared)',
    cypher: 'MATCH (p:Person) WHERE p.age > 75 RETURN count(*) AS n',
    params: () => ({}),
    declared: true,
  },
  {
    name: 'order by limit',
    cypher: 'MATCH (p:Person) RETURN p.name AS name ORDER BY p.age DESC, p.name LIMIT 10',
    params: () => ({}),
  },

  // Fixed-length patterns.
  {
    name: 'one hop',
    cypher: 'MATCH (p:Person {name: $a})-[:KNOWS]->(f) RETURN f.name AS name',
    params: people,
    declared: true,
  },
  {
    name: 'two hops distinct',
    cypher: 'MATCH (p:Person {name: $a})-[:KNOWS]->()-[:KNOWS]->(f) RETURN count(DISTINCT f) AS n',
    params: people,
    declared: true,
  },
  {
    name: 'aggregate by company',
    cypher:
      'MATCH (:Person)-[:WORKS_AT]->(c:Company) RETURN c.name AS c, count(*) AS n ORDER BY n DESC, c LIMIT 10',
    params: () => ({}),
  },

  // Variable-length patterns (one recursive CTE from every node, see DESIGN.md).
  {
    name: 'var-length *1..2 from one node',
    cypher: 'MATCH (p:Person {name: $a})-[:KNOWS*1..2]->(f) RETURN count(DISTINCT f) AS n',
    params: people,
    declared: true,
  },
  {
    name: 'var-length *1..3 from one node',
    cypher: 'MATCH (p:Person {name: $a})-[:KNOWS*1..3]->(f) RETURN count(DISTINCT f) AS n',
    params: people,
    declared: true,
  },
  {
    name: 'var-length *1..3 between two nodes',
    cypher:
      'MATCH (a:Person {name: $a}), (b:Person {name: $near}) MATCH (a)-[:KNOWS*1..3]-(b) RETURN count(*) AS n',
    params: people,
    declared: true,
  },
  {
    // The filter is on the end node, so the search starts at every node.
    name: 'var-length *1..2 into one node',
    cypher: 'MATCH (f)-[:KNOWS*1..2]->(p:Person {name: $a}) RETURN count(DISTINCT f) AS n',
    params: people,
    declared: true,
    skip: ['dense', 'large'],
  },

  // Shortest paths: the multi-step breadth-first search, and the single-statement
  // alternative (every path up to a bound, the shortest kept).
  {
    name: 'shortestPath near (multi-step)',
    cypher:
      'MATCH (a:Person {name: $a}), (b:Person {name: $near}) MATCH p = shortestPath((a)-[:KNOWS*..10]-(b)) RETURN length(p) AS l',
    params: people,
    declared: true,
  },
  {
    name: 'shortestPath far (multi-step)',
    cypher:
      'MATCH (a:Person {name: $a}), (b:Person {name: $far}) MATCH p = shortestPath((a)-[:KNOWS*..10]-(b)) RETURN length(p) AS l',
    params: people,
    declared: true,
  },
  {
    name: 'allShortestPaths near (multi-step)',
    cypher:
      'MATCH (a:Person {name: $a}), (b:Person {name: $near}) MATCH p = allShortestPaths((a)-[:KNOWS*..10]-(b)) RETURN count(p) AS n',
    params: people,
    declared: true,
  },
  {
    name: 'shortest near (single statement, *..3)',
    cypher:
      'MATCH (a:Person {name: $a}), (b:Person {name: $near}) MATCH p = (a)-[:KNOWS*..3]-(b) RETURN length(p) AS l ORDER BY l LIMIT 1',
    params: people,
    declared: true,
  },

  // Other composition features.
  {
    name: 'optional match count',
    cypher:
      'MATCH (c:Company) OPTIONAL MATCH (c)<-[:WORKS_AT]-(p:Person {city: $city}) RETURN count(p) AS n',
    params: () => ({ city: 'city3' }),
  },
  {
    name: 'pattern predicate (no incoming)',
    cypher: 'MATCH (p:Person) WHERE NOT (p)<-[:KNOWS]-() RETURN count(*) AS n',
    params: () => ({}),
  },
  {
    name: 'pattern comprehension degree',
    cypher: 'MATCH (p:Person) WHERE p.age = 30 RETURN sum(size([(p)-[:KNOWS]->(f) | f])) AS n',
    params: () => ({}),
    declared: true,
  },
  {
    name: 'collect, comprehension, slice',
    cypher:
      'MATCH (p:Person {name: $a})-[:KNOWS]->(f) WITH collect(f.age) AS ages RETURN [x IN ages WHERE x > 40 | x * 2] AS l, ages[0..2] AS s',
    params: people,
    declared: true,
  },
  {
    name: 'with stages and order',
    cypher:
      'MATCH (p:Person)-[:WORKS_AT]->(c) WITH c, avg(p.age) AS a WHERE a > 49 RETURN count(*) AS n',
    params: () => ({}),
  },
];
