import { LimitExceededError } from './errors.js';
import type { Row } from './executor.js';

/**
 * A shortest path found by a search. Ids are kept as the driver returned them, so
 * that they bind back exactly.
 */
export interface FoundPath {
  start: unknown;
  end: unknown;
  /** Relationship ids, in path order. */
  relationships: unknown[];
  /** Ids of the nodes after the start, in path order (the last is `end`). */
  nodes: unknown[];
}

export interface SearchOptions {
  /** Every path of the shortest length (allShortestPaths), or one per pair. */
  all: boolean;
  /** Lower bound of the pattern, 0 or 1. With 1 a node has no path to itself. */
  min: number;
  maxDepth: number;
  maxFrontierSize: number;
  /** Most paths the search may return. */
  maxPaths: number;
  /** One breadth-first step: rows `(f, r, t)` for the edges next to these node ids. */
  expand: (frontier: unknown[]) => Promise<Row[]>;
}

interface Parent {
  edge: unknown;
  from: string;
}

/** The search from one start node, towards all of its targets at once. */
interface Source {
  key: string;
  /** Targets not reached yet. */
  targets: Map<string, unknown>;
  /** Targets reached, by key. */
  found: string[];
  /** Depth of every node reached. */
  depth: Map<string, number>;
  /** How each node was first reached (every way, for allShortestPaths). */
  parents: Map<string, Parent[]>;
  frontier: string[];
}

/** Ids compare by their text: drivers return bigint, number, or string. */
function key(id: unknown): string {
  return String(id);
}

/**
 * Breadth-first search for the shortest paths between the pairs `(s, t)` of
 * `pairs`. All start nodes search together: each depth is one `expand` step over
 * the union of their frontiers, and a start node stops once it has reached all
 * of its targets. Shortest paths never repeat a node, so relationship uniqueness
 * holds without a check.
 */
export async function shortestPaths(pairs: Row[], options: SearchOptions): Promise<FoundPath[]> {
  const ids = new Map<string, unknown>();
  const sources = new Map<string, Source>();
  for (const pair of pairs) {
    const { s, t } = pair;
    if (s === null || s === undefined || t === null || t === undefined) {
      continue;
    }
    const sk = key(s);
    const tk = key(t);
    ids.set(sk, s);
    ids.set(tk, t);
    let source = sources.get(sk);
    if (!source) {
      source = {
        key: sk,
        targets: new Map(),
        found: [],
        depth: new Map([[sk, 0]]),
        parents: new Map(),
        frontier: [sk],
      };
      sources.set(sk, source);
    }
    if (tk !== sk) {
      source.targets.set(tk, t);
    } else if (options.min === 0 && !source.found.includes(sk)) {
      source.found.push(sk);
    }
  }

  for (let depth = 1; depth <= options.maxDepth; depth++) {
    const active = [...sources.values()].filter((s) => s.targets.size > 0 && s.frontier.length > 0);
    if (active.length === 0) {
      break;
    }
    const carried = active.reduce((sum, s) => sum + s.frontier.length, 0);
    if (carried > options.maxFrontierSize) {
      throw new LimitExceededError(
        `A shortest path search carried more than ${options.maxFrontierSize} nodes to the next step (maxFrontierSize)`,
        { hint: 'Give the pattern an upper bound, or match fewer start and end nodes.' },
      );
    }
    const frontier = new Set(active.flatMap((s) => s.frontier));
    const rows = await options.expand([...frontier].map((k) => ids.get(k)));
    const next = new Map<string, { edge: unknown; to: string }[]>();
    for (const row of rows) {
      const to = key(row['t']);
      ids.set(to, row['t']);
      const from = key(row['f']);
      let edges = next.get(from);
      if (!edges) {
        edges = [];
        next.set(from, edges);
      }
      edges.push({ edge: row['r'], to });
    }
    for (const source of active) {
      const reached: string[] = [];
      for (const from of source.frontier) {
        for (const { edge, to } of next.get(from) ?? []) {
          const known = source.depth.get(to);
          if (known === undefined) {
            source.depth.set(to, depth);
            source.parents.set(to, [{ edge, from }]);
            reached.push(to);
          } else if (known === depth && options.all) {
            source.parents.get(to)!.push({ edge, from });
          }
        }
      }
      source.frontier = reached;
      for (const target of source.targets.keys()) {
        if (source.depth.get(target) === depth) {
          source.found.push(target);
          source.targets.delete(target);
        }
      }
    }
  }

  const paths: FoundPath[] = [];
  for (const source of sources.values()) {
    for (const target of source.found) {
      const count = countPaths(source, target, new Map());
      if (paths.length + count > options.maxPaths) {
        throw new LimitExceededError(
          `A shortest path search found more than ${options.maxPaths} paths (maxRowsPerStep)`,
          {
            hint: 'Use shortestPath instead of allShortestPaths, or match fewer start and end nodes.',
          },
        );
      }
      for (const chain of chains(source, target)) {
        paths.push({
          start: ids.get(source.key),
          end: ids.get(target),
          relationships: chain.map((step) => step.edge),
          nodes: chain.map((step) => ids.get(step.node)),
        });
      }
    }
  }
  return paths;
}

/** Number of shortest paths from the source to `node`. */
function countPaths(source: Source, node: string, memo: Map<string, number>): number {
  if (node === source.key) {
    return 1;
  }
  let count = memo.get(node);
  if (count === undefined) {
    count = 0;
    for (const parent of source.parents.get(node)!) {
      count += countPaths(source, parent.from, memo);
    }
    memo.set(node, count);
  }
  return count;
}

/** Every shortest path from the source to `node`, as its steps (edge, node reached). */
function chains(source: Source, node: string): { edge: unknown; node: string }[][] {
  if (node === source.key) {
    return [[]];
  }
  return source.parents
    .get(node)!
    .flatMap((parent) =>
      chains(source, parent.from).map((chain) => [...chain, { edge: parent.edge, node }]),
    );
}

/** JSON text of ids as the driver returned them: numbers and bigints as numbers, strings as strings. */
export function idsJson(ids: unknown[]): string {
  return `[${ids.map(idJson).join(',')}]`;
}

function idJson(id: unknown): string {
  if (typeof id === 'bigint' || (typeof id === 'number' && Number.isFinite(id))) {
    return String(id);
  }
  if (typeof id === 'string') {
    return JSON.stringify(id);
  }
  throw new Error(`Internal error: unexpected id value of type ${typeof id} from the database`);
}

/** JSON text of found paths, for Dialect.boundPaths. */
export function pathsJson(paths: FoundPath[]): string {
  return `[${paths
    .map(
      (p) =>
        `{"s":${idJson(p.start)},"t":${idJson(p.end)},"r":${idsJson(p.relationships)},"n":${idsJson(p.nodes)}}`,
    )
    .join(',')}]`;
}
