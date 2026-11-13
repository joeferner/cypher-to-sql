// Benchmarks: runs the query corpus (queries.ts) on reference graphs
// (graphs.ts) in SQLite and PostgreSQL, and prints the median time of each.
//
//   npm run bench                                 # small, medium, dense; both dialects
//   npm run bench -- --graphs large --dialects postgres
//   npm run bench -- --filter shortest            # queries whose name contains "shortest"
//   npm run bench -- --save bench/baseline.json   # record results
//   npm run bench -- --compare bench/baseline.json
//
// PostgreSQL: BENCH_POSTGRES_URL or TEST_POSTGRES_URL (default: the compose
// database). Each graph is loaded into the schema bench_<graph>, which stays
// after the run for EXPLAIN by hand.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { parseArgs } from 'node:util';
import { createGraph, CypherError, type Graph as CypherGraph } from '../src/index.js';
import { DEFAULT_GRAPHS, GRAPHS, generateGraph, type Graph } from './graphs.js';
import { DECLARED, loadPostgres, loadSqlite, type LoadedGraph } from './load.js';
import { QUERIES } from './queries.js';

interface Result {
  graph: string;
  dialect: string;
  query: string;
  /** Median of the timed runs, in milliseconds. */
  medianMs: number | null;
  minMs: number | null;
  runs: number;
  /** Rows the query returned. */
  rows: number | null;
  error?: string;
}

interface Report {
  meta: Record<string, string>;
  load: { graph: string; dialect: string; ms: number; nodes: number; edges: number }[];
  results: Result[];
}

const { values: args } = parseArgs({
  options: {
    graphs: { type: 'string', default: DEFAULT_GRAPHS.join(',') },
    dialects: { type: 'string', default: 'sqlite,postgres' },
    filter: { type: 'string' },
    runs: { type: 'string', default: '5' },
    budget: { type: 'string', default: '3000' },
    save: { type: 'string' },
    compare: { type: 'string' },
  },
});

const POSTGRES_URL =
  process.env['BENCH_POSTGRES_URL'] ??
  process.env['TEST_POSTGRES_URL'] ??
  'postgres://cypher:cypher@localhost:55432/cypher';
const RUNS = Number(args.runs);
const BUDGET_MS = Number(args.budget);

const write = (text: string): void => void process.stdout.write(`${text}\n`);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One warm-up run (which also counts the rows), then timed runs within the budget. */
async function measure(
  graph: CypherGraph,
  cypher: string,
  params: Parameters<CypherGraph['query']>[1],
): Promise<Pick<Result, 'medianMs' | 'minMs' | 'runs' | 'rows' | 'error'>> {
  let rows: number;
  const warmStart = performance.now();
  try {
    rows = (await graph.query(cypher, params)).length;
  } catch (error) {
    const message =
      error instanceof CypherError ? `${error.name}: ${error.message}` : String(error);
    return { medianMs: null, minMs: null, runs: 0, rows: null, error: message };
  }
  const warmMs = performance.now() - warmStart;
  const times: number[] = [];
  const deadline = performance.now() + BUDGET_MS;
  // A query slower than the budget is timed by its warm-up run alone.
  if (warmMs > BUDGET_MS) {
    times.push(warmMs);
  }
  while (times.length < RUNS && (times.length === 0 || performance.now() < deadline)) {
    const start = performance.now();
    await graph.query(cypher, params);
    times.push(performance.now() - start);
  }
  return { medianMs: median(times), minMs: Math.min(...times), runs: times.length, rows };
}

function meta(): Record<string, string> {
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // Not a git checkout.
  }
  return {
    date: new Date().toISOString(),
    commit,
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpu: `${cpus()[0]?.model ?? 'unknown'} (${cpus().length} cores)`,
  };
}

const ms = (value: number | null): string => (value === null ? '-' : value.toFixed(1));

function key(r: { graph: string; dialect: string; query: string }): string {
  return `${r.graph}|${r.dialect}|${r.query}`;
}

async function main(): Promise<void> {
  const graphNames = args.graphs.split(',');
  const dialects = args.dialects.split(',');
  const queries = QUERIES.filter((q) => !args.filter || q.name.includes(args.filter));
  const report: Report = { meta: meta(), load: [], results: [] };
  const baseline = args.compare
    ? new Map(
        (JSON.parse(readFileSync(args.compare, 'utf8')) as Report).results.map((r) => [key(r), r]),
      )
    : undefined;

  for (const name of graphNames) {
    const spec = GRAPHS.find((g) => g.name === name);
    if (!spec) {
      throw new Error(`Unknown graph ${name}; known: ${GRAPHS.map((g) => g.name).join(', ')}`);
    }
    const graph: Graph = generateGraph(spec);
    write(
      `\n## ${spec.name}: ${graph.nodes.length} nodes, ${graph.edges.length} relationships (KNOWS degree ${spec.degree})`,
    );
    for (const dialect of dialects) {
      const start = performance.now();
      const loaded: LoadedGraph =
        dialect === 'sqlite' ? await loadSqlite(graph) : await loadPostgres(graph, POSTGRES_URL);
      const loadMs = performance.now() - start;
      report.load.push({
        graph: spec.name,
        dialect,
        ms: loadMs,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
      });
      write(`\n### ${dialect} (loaded in ${(loadMs / 1000).toFixed(1)} s)\n`);
      write(
        `| query | median ms | min ms | runs | rows |${baseline ? ' baseline ms | ratio |' : ''}`,
      );
      write(`| --- | ---: | ---: | ---: | ---: |${baseline ? ' ---: | ---: |' : ''}`);
      const plain = createGraph({ dialect: loaded.dialect, executor: loaded.executor });
      const declared = createGraph({
        dialect: loaded.dialect,
        executor: loaded.executor,
        mapping: DECLARED,
      });
      try {
        for (const q of queries) {
          if (q.skip?.includes(spec.name)) {
            continue;
          }
          const measured = await measure(q.declared ? declared : plain, q.cypher, q.params(graph));
          const result: Result = { graph: spec.name, dialect, query: q.name, ...measured };
          report.results.push(result);
          let compared = '';
          if (baseline) {
            const before = baseline.get(key(result));
            const ratio =
              before?.medianMs && result.medianMs !== null
                ? result.medianMs / before.medianMs
                : null;
            const slower =
              ratio !== null && ratio > 1.5 && result.medianMs! - before!.medianMs! > 2 ? ' ⚠' : '';
            compared = ` ${ms(before?.medianMs ?? null)} | ${ratio === null ? '-' : ratio.toFixed(2)}${slower} |`;
          }
          const status = result.error ? ` ${result.error.slice(0, 80)}` : '';
          write(
            `| ${q.name} | ${ms(result.medianMs)} | ${ms(result.minMs)} | ${result.runs} | ${result.rows ?? '-'}${status} |${compared}`,
          );
        }
      } finally {
        await loaded.close();
      }
    }
  }

  if (args.save) {
    writeFileSync(args.save, `${JSON.stringify(report, null, 2)}\n`);
    write(`\nSaved to ${args.save}`);
  }
}

await main();
