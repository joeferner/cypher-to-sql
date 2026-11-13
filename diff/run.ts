// Differential tests (#20): runs the corpus on this library (SQLite and
// PostgreSQL) and on the reference engines Neo4j and ArcadeDB, and compares the
// results.
//
//   npm run db:up:reference
//   npm run test:diff
//   npm run test:diff -- --filter shortest --graph social --verbose
//
// A result where Neo4j and ArcadeDB agree and this library differs is very
// likely a bug here, and fails the run (unless the query is marked `known`).
// Where the references disagree with each other, the TCK decides; those are
// listed for review.

import { parseArgs } from 'node:util';
import { DECLARED } from '../bench/load.js';
import { CORPUS, type DiffQuery } from './corpus.js';
import { arcadeEngine, neo4jEngine, ours, type Engine, type Outcome } from './engines.js';

const { values: options } = parseArgs({
  options: {
    filter: { type: 'string' },
    graph: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
});

const POSTGRES_URL =
  process.env['TEST_POSTGRES_URL'] ?? 'postgres://cypher:cypher@localhost:55432/cypher';
const NEO4J_URL = process.env['NEO4J_URL'] ?? 'bolt://localhost:57687';
const ARCADEDB_URL = process.env['ARCADEDB_URL'] ?? 'http://localhost:52480';

const write = (text = ''): void => void process.stdout.write(`${text}\n`);

/** How one configuration of this library compares with the references on one query. */
type Verdict =
  | 'agree' // with both references
  | 'differs' // the references agree with each other, this library does not
  | 'arcadedb differs' // this library agrees with Neo4j only
  | 'neo4j differs' // this library agrees with ArcadeDB only
  | 'all differ'
  | 'known' // differs, and the corpus says why
  | 'unsupported'; // UnsupportedFeatureError here

/** Results compare in order when the final RETURN sorts. */
function ordered(cypher: string): boolean {
  const ret = cypher.slice(cypher.toUpperCase().lastIndexOf('RETURN'));
  return /\bORDER\s+BY\b/i.test(ret);
}

function same(a: Outcome, b: Outcome, inOrder: boolean): boolean {
  if ('error' in a || 'error' in b) {
    return 'error' in a && 'error' in b;
  }
  const rows = (o: { rows: string[] }): string =>
    JSON.stringify(inOrder ? o.rows : [...o.rows].sort());
  return rows(a) === rows(b);
}

function verdict(o: Outcome, neo: Outcome, arc: Outcome, inOrder: boolean): Verdict {
  if ('error' in o && o.unsupported) {
    return 'unsupported';
  }
  const withNeo = same(o, neo, inOrder);
  const withArc = same(o, arc, inOrder);
  if (withNeo && withArc) {
    return 'agree';
  }
  if (same(neo, arc, inOrder)) {
    return 'differs';
  }
  return withNeo ? 'arcadedb differs' : withArc ? 'neo4j differs' : 'all differ';
}

function show(outcome: Outcome): string {
  if ('error' in outcome) {
    return `${outcome.unsupported ? 'unsupported' : 'error'}: ${outcome.error}`;
  }
  const MAX = 8;
  const rows = outcome.rows.slice(0, MAX).join('\n      ');
  const more = outcome.rows.length > MAX ? `\n      ... ${outcome.rows.length} rows` : '';
  return outcome.rows.length === 0 ? '(no rows)' : `\n      ${rows}${more}`;
}

async function main(): Promise<number> {
  const references = { neo4j: neo4jEngine(NEO4J_URL), arcadedb: arcadeEngine(ARCADEDB_URL) };
  const counts = new Map<string, Map<Verdict, number>>();
  const count = (engine: string, v: Verdict): void => {
    const m = counts.get(engine) ?? new Map<Verdict, number>();
    m.set(v, (m.get(v) ?? 0) + 1);
    counts.set(engine, m);
  };
  let failures = 0;

  for (const group of CORPUS) {
    if (options.graph && group.graph !== options.graph) {
      continue;
    }
    const queries = group.queries.filter(
      (query: DiffQuery) => !options.filter || query.cypher.includes(options.filter),
    );
    if (queries.length === 0) {
      continue;
    }
    const sqlite = ours('sqlite', POSTGRES_URL);
    const postgres = ours('postgres', POSTGRES_URL);
    const engines: Engine[] = [sqlite, postgres];
    if (group.declared) {
      // The same databases, queried with declared property types.
      engines.push(
        sqlite.as('sqlite declared', DECLARED),
        postgres.as('postgres declared', DECLARED),
      );
    }
    write(`## Graph ${group.graph}\n`);
    process.stdout.write('Loading...');
    const start = performance.now();
    for (const engine of [sqlite, postgres, references.neo4j, references.arcadedb]) {
      await engine.load(group.graph, group.source);
    }
    write(` ${((performance.now() - start) / 1000).toFixed(1)} s\n`);

    for (const query of queries) {
      const params = query.params ?? {};
      const neo = await references.neo4j.run(query.cypher, params);
      const arc = await references.arcadedb.run(query.cypher, params);
      const inOrder = ordered(query.cypher);
      const results = [];
      for (const engine of engines) {
        const outcome = await engine.run(query.cypher, params);
        const found = verdict(outcome, neo, arc, inOrder);
        const v = found !== 'agree' && query.known ? 'known' : found;
        count(engine.name, v);
        results.push({ engine: engine.name, outcome, v });
      }
      const failed = results.some((r) => r.v === 'differs');
      failures += failed ? 1 : 0;
      if (!options.verbose && results.every((r) => r.v === 'agree')) {
        continue;
      }
      const verdicts = [...new Set(results.map((r) => `${r.engine}: ${r.v}`))].join(', ');
      write(`${failed ? '✗' : results.every((r) => r.v === 'agree') ? '✓' : '·'} ${query.cypher}`);
      if (query.params) {
        write(
          `    params ${JSON.stringify(query.params, (_, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))}`,
        );
      }
      write(`    ${verdicts}${query.known ? ` (known: ${query.known})` : ''}`);
      write(`    neo4j: ${show(neo)}`);
      write(`    arcadedb: ${show(arc)}`);
      // One result per distinct outcome of this library.
      const shown = new Set<string>();
      for (const r of results) {
        const text = show(r.outcome);
        if (!shown.has(text)) {
          shown.add(text);
          const names = results.filter((x) => show(x.outcome) === text).map((x) => x.engine);
          write(`    ${names.join(', ')}: ${text}`);
        }
      }
      write();
    }
    for (const engine of [sqlite, postgres]) {
      await engine.close();
    }
  }
  for (const engine of Object.values(references)) {
    await engine.close();
  }

  write('## Summary\n');
  const VERDICTS: Verdict[] = [
    'agree',
    'differs',
    'arcadedb differs',
    'neo4j differs',
    'all differ',
    'known',
    'unsupported',
  ];
  write(`| engine | ${VERDICTS.join(' | ')} |`);
  write(`| --- | ${VERDICTS.map(() => '---:').join(' | ')} |`);
  for (const [engine, m] of counts) {
    write(`| ${engine} | ${VERDICTS.map((v) => m.get(v) ?? 0).join(' | ')} |`);
  }
  write(
    failures === 0
      ? '\nNo unexplained differences where Neo4j and ArcadeDB agree.'
      : `\n${failures} queries differ where Neo4j and ArcadeDB agree.`,
  );
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
