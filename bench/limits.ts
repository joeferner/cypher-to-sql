// Measurements behind the default limits (#16): how the cost of a
// variable-length pattern grows with its depth, what returning many rows
// costs, and how large a shortest-path search frontier gets.
//
//   npm run bench:limits
//
// PostgreSQL as in run.ts. Prints markdown tables.

import { createGraph, type CypherValue, type Graph as CypherGraph } from '../src/index.js';
import { GRAPHS, generateGraph, type Graph } from './graphs.js';
import { DECLARED, loadPostgres, loadSqlite, type LoadedGraph } from './load.js';

const POSTGRES_URL =
  process.env['BENCH_POSTGRES_URL'] ??
  process.env['TEST_POSTGRES_URL'] ??
  'postgres://cypher:cypher@localhost:55432/cypher';
/** Stop raising a size once one run takes longer than this. */
const STOP_MS = 5_000;

const write = (text: string): void => void process.stdout.write(`${text}\n`);

/** Limits high enough not to interfere with the measurements. */
const OPEN_LIMITS = {
  maxPathDepth: 20,
  maxRowsPerStep: 10_000_000,
  maxResultRows: 10_000_000,
  maxFrontierSize: 10_000_000,
  maxSteps: 100,
  timeoutMs: 600_000,
};

/** A scalar result value as text; '-' for null. */
function show(value: CypherValue | undefined): string {
  return typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string'
    ? String(value)
    : '-';
}

async function time<T>(f: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const start = performance.now();
  const result = await f();
  return { ms: performance.now() - start, result };
}

/** Paths and time of `(p {name: 'p1'})-[:KNOWS*1..d]->(f)` for growing d. */
async function depths(graph: CypherGraph, name: string, dialect: string): Promise<void> {
  for (let d = 2; d <= 12; d++) {
    const { ms, result } = await time(() =>
      graph.query(
        `MATCH (p:Person {name: 'p1'})-[:KNOWS*1..${d}]->(f) RETURN count(*) AS paths, count(DISTINCT f) AS nodes`,
      ),
    );
    write(
      `| ${name} | ${dialect} | ${d} | ${show(result[0]!['paths'])} | ${show(result[0]!['nodes'])} | ${ms.toFixed(0)} |`,
    );
    if (ms > STOP_MS) {
      break;
    }
  }
}

/** Time and heap growth of returning n nodes. */
async function rows(graph: CypherGraph, name: string, dialect: string): Promise<void> {
  for (const n of [1_000, 10_000, 100_000]) {
    for (const what of ['p.name AS v', 'p AS v']) {
      globalThis.gc?.();
      const before = process.memoryUsage().heapUsed;
      const { ms, result } = await time(() =>
        graph.query(`MATCH (p:Person) RETURN ${what} LIMIT ${n}`),
      );
      const mb = (process.memoryUsage().heapUsed - before) / 1e6;
      write(
        `| ${name} | ${dialect} | ${what} | ${result.length} | ${ms.toFixed(0)} | ${mb.toFixed(0)} |`,
      );
    }
  }
}

/** Nodes at each depth of an undirected KNOWS search from p1 (in memory). */
function frontiers(graph: Graph): number[] {
  const neighbors = new Map<number, number[]>();
  for (const e of graph.edges) {
    if (e.type === 'KNOWS') {
      neighbors.set(e.start, [...(neighbors.get(e.start) ?? []), e.end]);
      neighbors.set(e.end, [...(neighbors.get(e.end) ?? []), e.start]);
    }
  }
  const seen = new Set([1]);
  let frontier = [1];
  const sizes: number[] = [];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const node of frontier) {
      for (const n of neighbors.get(node) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
    if (next.length > 0) {
      sizes.push(next.length);
    }
  }
  return sizes;
}

async function main(): Promise<void> {
  const loaded: { name: string; graph: Graph; dialect: string; db: LoadedGraph }[] = [];
  write('## Frontier sizes of a search from one node (undirected KNOWS)\n');
  write('| graph | nodes per depth | depths |');
  write('| --- | --- | ---: |');
  for (const name of ['medium', 'dense', 'large']) {
    const graph = generateGraph(GRAPHS.find((g) => g.name === name)!);
    const sizes = frontiers(graph);
    write(`| ${name} | ${sizes.join(', ')} | ${sizes.length} |`);
    for (const dialect of ['sqlite', 'postgres']) {
      const db =
        dialect === 'sqlite' ? await loadSqlite(graph) : await loadPostgres(graph, POSTGRES_URL);
      loaded.push({ name, graph, dialect, db });
    }
  }

  const open = (db: LoadedGraph): CypherGraph =>
    createGraph({
      dialect: db.dialect,
      executor: db.executor,
      mapping: DECLARED,
      limits: OPEN_LIMITS,
    });

  write('\n## Shortest path searches (multi-step) to a far node\n');
  write('| graph | dialect | hops | ms |');
  write('| --- | --- | ---: | ---: |');
  for (const { name, graph, dialect, db } of loaded) {
    const far = `p${Math.floor(graph.persons / 2)}`;
    const { ms, result } = await time(() =>
      open(db).query(
        `MATCH (a:Person {name: 'p1'}), (b:Person {name: $far})
         MATCH p = shortestPath((a)-[:KNOWS*..20]-(b)) RETURN length(p) AS l`,
        { far },
      ),
    );
    write(`| ${name} | ${dialect} | ${show(result[0]?.['l'] ?? null)} | ${ms.toFixed(0)} |`);
  }

  write('\n## Variable-length paths from one node, by depth\n');
  write('| graph | dialect | depth | paths | nodes | ms |');
  write('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const { name, dialect, db } of loaded) {
    if (name !== 'large') {
      await depths(open(db), name, dialect);
    }
  }

  write('\n## Returning many rows (large graph)\n');
  write('| graph | dialect | returns | rows | ms | heap MB |');
  write('| --- | --- | --- | ---: | ---: | ---: |');
  for (const { name, dialect, db } of loaded) {
    if (name === 'large') {
      await rows(open(db), name, dialect);
    }
  }

  for (const { db } of loaded) {
    await db.close();
  }
}

await main();
