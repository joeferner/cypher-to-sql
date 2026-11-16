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
  /**
   * The same step against the pattern's direction, from the end nodes: rows
   * `(f, r, t)` where `t` comes before `f` on a path. For an undirected
   * pattern it is `expand`.
   */
  expandBackward: (frontier: unknown[]) => Promise<Row[]>;
}

/**
 * At most this many pairs search from both ends. With more (one start node and
 * many targets, say), one search from each start node, which reaches all of its
 * targets at once, costs less than one search per pair.
 */
export const BIDIRECTIONAL_MAX_PAIRS = 64;

interface Parent {
  edge: unknown;
  from: string;
}

/** The search from one start node, towards all of its targets at once. */
interface Source extends Side {
  /** Targets not reached yet. */
  targets: Map<string, unknown>;
  /** Targets reached, by key. */
  found: string[];
}

/** Ids compare by their text: drivers return bigint, number, or string. */
function key(id: unknown): string {
  return String(id);
}

/**
 * Breadth-first search for the shortest paths between the pairs `(s, t)` of
 * `pairs`: from both ends for a few pairs (`bidirectional`), otherwise from the
 * start nodes (`forward`). Shortest paths never repeat a node, so relationship
 * uniqueness holds without a check.
 */
export async function shortestPaths(pairs: Row[], options: SearchOptions): Promise<FoundPath[]> {
  const valid = pairs.filter(
    ({ s, t }) => s !== null && s !== undefined && t !== null && t !== undefined,
  );
  const distinct = new Set(valid.map(({ s, t }) => `${key(s)}\u0000${key(t)}`));
  return distinct.size <= BIDIRECTIONAL_MAX_PAIRS
    ? bidirectional(valid, options)
    : forward(valid, options);
}

/** The search from one end of some pairs: the nodes reached, how, and the frontier. */
interface Side {
  key: string;
  /** Depth of every node reached from this end. */
  depth: Map<string, number>;
  /** How each node was first reached (every way, for allShortestPaths). */
  parents: Map<string, Parent[]>;
  frontier: string[];
}

function side(start: string): Side {
  return { key: start, depth: new Map([[start, 0]]), parents: new Map(), frontier: [start] };
}

/** A pair being searched, and once the sides meet, where. */
interface Pair {
  s: string;
  t: string;
  meeting?: string[];
}

/**
 * Searches from both ends of each pair, a whole level at a time, always
 * expanding the side (all forward searches, or all backward ones) whose
 * frontiers are smaller. The first time a pair's forward and backward searches
 * share nodes, at forward depth `df` and backward depth `db`, its shortest
 * length is `df + db`: before that level the sides shared nothing, so no path
 * of `df - 1 + db` or fewer existed. Every shortest path crosses one of the
 * shared nodes, so the paths are the forward halves to a shared node joined
 * with the backward halves from it.
 *
 * On the reference graph (100,000 nodes, about 9 relationships each) this
 * reads about 1,100 edges for a pair 6 apart, where one search from the start
 * reads about 127,000.
 */
export async function bidirectional(pairs: Row[], options: SearchOptions): Promise<FoundPath[]> {
  const ids = new Map<string, unknown>();
  const forwards = new Map<string, Side>();
  const backwards = new Map<string, Side>();
  const searching: Pair[] = [];
  const done: Pair[] = [];
  const seen = new Set<string>();
  for (const { s, t } of pairs) {
    const sk = key(s);
    const tk = key(t);
    if (seen.has(`${sk}\u0000${tk}`)) {
      continue;
    }
    seen.add(`${sk}\u0000${tk}`);
    ids.set(sk, s);
    ids.set(tk, t);
    if (sk === tk) {
      // With a lower bound of 1 a node has no path to itself.
      if (options.min === 0) {
        done.push({ s: sk, t: tk, meeting: [sk] });
      }
      continue;
    }
    if (!forwards.has(sk)) {
      forwards.set(sk, side(sk));
    }
    if (!backwards.has(tk)) {
      backwards.set(tk, side(tk));
    }
    searching.push({ s: sk, t: tk });
  }

  let forwardDepth = 0;
  let backwardDepth = 0;
  let active = searching;
  while (active.length > 0 && forwardDepth + backwardDepth < options.maxDepth) {
    const used = (sides: Map<string, Side>, end: 's' | 't'): Side[] => [
      ...new Set(active.map((pair) => sides.get(pair[end])!)),
    ];
    const forwardSides = used(forwards, 's');
    const backwardSides = used(backwards, 't');
    const size = (list: Side[]): number => list.reduce((sum, s) => sum + s.frontier.length, 0);
    const ahead = size(forwardSides) <= size(backwardSides);
    const sides = ahead ? forwardSides : backwardSides;
    const carried = size(sides);
    if (carried > options.maxFrontierSize) {
      throw frontierError(options.maxFrontierSize);
    }
    const depth = (ahead ? forwardDepth : backwardDepth) + 1;
    const frontier = new Set(sides.flatMap((s) => s.frontier));
    const rows = await (ahead ? options.expand : options.expandBackward)(
      [...frontier].map((k) => ids.get(k)),
    );
    const next = edgesFrom(rows, ids);
    for (const s of sides) {
      advance(s, next, depth, options.all);
    }
    if (ahead) {
      forwardDepth = depth;
    } else {
      backwardDepth = depth;
    }

    const remaining: Pair[] = [];
    for (const pair of active) {
      const forwardSide = forwards.get(pair.s)!;
      const backwardSide = backwards.get(pair.t)!;
      // The nodes this level reached that the other side has reached at its level.
      const [reached, other] = ahead ? [forwardSide, backwardSide] : [backwardSide, forwardSide];
      const otherDepth = ahead ? backwardDepth : forwardDepth;
      const meeting = reached.frontier.filter((node) => other.depth.get(node) === otherDepth);
      if (meeting.length > 0) {
        done.push({ ...pair, meeting });
      } else if (forwardSide.frontier.length > 0 && backwardSide.frontier.length > 0) {
        remaining.push(pair);
      }
    }
    active = remaining;
  }

  const paths: FoundPath[] = [];
  for (const pair of done) {
    const forwardSide = forwards.get(pair.s);
    const backwardSide = backwards.get(pair.t);
    const halves = (node: string): [Step[][], Step[][]] =>
      forwardSide && backwardSide
        ? [chains(forwardSide, node), reversed(backwardSide, node)]
        : [[[]], [[]]];
    const meeting = options.all ? pair.meeting! : pair.meeting!.slice(0, 1);
    let count = 0;
    for (const node of meeting) {
      count +=
        forwardSide && backwardSide
          ? countPaths(forwardSide, node, new Map()) * countPaths(backwardSide, node, new Map())
          : 1;
    }
    if (!options.all) {
      count = Math.min(count, 1);
    }
    if (paths.length + count > options.maxPaths) {
      throw pathsError(options.maxPaths);
    }
    for (const node of meeting) {
      const [before, after] = halves(node);
      for (const first of options.all ? before : before.slice(0, 1)) {
        for (const second of options.all ? after : after.slice(0, 1)) {
          const chain = [...first, ...second];
          paths.push({
            start: ids.get(pair.s),
            end: ids.get(pair.t),
            relationships: chain.map((step) => step.edge),
            nodes: chain.map((step) => ids.get(step.node)),
          });
        }
      }
    }
  }
  return paths;
}

/** One step of a path: the edge taken and the node it reaches. */
interface Step {
  edge: unknown;
  node: string;
}

/**
 * The paths from `node` to the end of a backward search, as steps in path
 * order: a backward parent `{ edge, from }` of `n` means `n -edge-> from` on
 * the path.
 */
function reversed(back: Side, node: string): Step[][] {
  if (node === back.key) {
    return [[]];
  }
  return back.parents
    .get(node)!
    .flatMap((parent) =>
      reversed(back, parent.from).map((rest) => [
        { edge: parent.edge, node: parent.from },
        ...rest,
      ]),
    );
}

/** The rows of one expand step, by the node they leave from. */
function edgesFrom(
  rows: Row[],
  ids: Map<string, unknown>,
): Map<string, { edge: unknown; to: string }[]> {
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
  return next;
}

/** One level of a side's search: the nodes its frontier reaches first become the frontier. */
function advance(
  s: Side,
  next: Map<string, { edge: unknown; to: string }[]>,
  depth: number,
  all: boolean,
): void {
  const reached: string[] = [];
  for (const from of s.frontier) {
    for (const { edge, to } of next.get(from) ?? []) {
      const known = s.depth.get(to);
      if (known === undefined) {
        s.depth.set(to, depth);
        s.parents.set(to, [{ edge, from }]);
        reached.push(to);
      } else if (known === depth && all) {
        s.parents.get(to)!.push({ edge, from });
      }
    }
  }
  s.frontier = reached;
}

function frontierError(max: number): LimitExceededError {
  return new LimitExceededError(
    `A shortest path search carried more than ${max} nodes to the next step (maxFrontierSize)`,
    { hint: 'Give the pattern an upper bound, or match fewer start and end nodes.' },
  );
}

function pathsError(max: number): LimitExceededError {
  return new LimitExceededError(
    `A shortest path search found more than ${max} paths (maxRowsPerStep)`,
    { hint: 'Use shortestPath instead of allShortestPaths, or match fewer start and end nodes.' },
  );
}

/**
 * Searches from the start nodes only, for many pairs. All start nodes search
 * together: each depth is one `expand` step over the union of their
 * frontiers, and a start node stops once it has reached all of its targets.
 */
export async function forward(pairs: Row[], options: SearchOptions): Promise<FoundPath[]> {
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
      throw frontierError(options.maxFrontierSize);
    }
    const frontier = new Set(active.flatMap((s) => s.frontier));
    const rows = await options.expand([...frontier].map((k) => ids.get(k)));
    const next = edgesFrom(rows, ids);
    for (const source of active) {
      advance(source, next, depth, options.all);
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
        throw pathsError(options.maxPaths);
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

/** Number of shortest paths from the side's end to `node`. */
function countPaths(source: Side, node: string, memo: Map<string, number>): number {
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

/** Every shortest path from the side's end to `node`, as its steps (edge, node reached). */
function chains(source: Side, node: string): Step[][] {
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

export function idJson(id: unknown): string {
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
