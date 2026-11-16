// The shortest path search of src/search.ts on random graphs, without a
// database: searching from both ends must find what searching from the start
// finds (every path for allShortestPaths, a path of the same length otherwise).

import { describe, expect, it } from 'vitest';
import type { Row } from '../src/index.js';
import { bidirectional, forward, type FoundPath, type SearchOptions } from '../src/search.js';

interface Edge {
  id: number;
  from: number;
  to: number;
}

/** A seeded random graph: `nodes` nodes and `edges` directed edges, self-loops and parallel edges included. */
function randomGraph(seed: number, nodes: number, edges: number): Edge[] {
  let state = seed;
  const random = (n: number): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state % n;
  };
  return Array.from({ length: edges }, (_, i) => ({
    id: i + 1,
    from: random(nodes),
    to: random(nodes),
  }));
}

/** The expand steps over the edges, as the SQL steps return them: ordered by edge id. */
function steps(
  edges: Edge[],
  direction: 'right' | 'both',
): Pick<SearchOptions, 'expand' | 'expandBackward'> {
  const rows = (frontier: unknown[], forwards: boolean): Promise<Row[]> => {
    const ids = new Set(frontier.map(Number));
    const out: Row[] = [];
    for (const e of edges) {
      if ((direction === 'both' || forwards) && ids.has(e.from)) {
        out.push({ f: e.from, r: e.id, t: e.to });
      }
      if ((direction === 'both' || !forwards) && ids.has(e.to)) {
        out.push({ f: e.to, r: e.id, t: e.from });
      }
    }
    return Promise.resolve(
      out.sort((a, b) => Number(a['r']) - Number(b['r']) || Number(a['f']) - Number(b['f'])),
    );
  };
  return { expand: (f) => rows(f, true), expandBackward: (f) => rows(f, false) };
}

/** A path as text, for comparing sets of paths. */
const text = (p: FoundPath): string =>
  `${String(p.start)}:${p.relationships.join(',')}:${p.nodes.join(',')}`;

/** Checks that a path is a walk from its start to its end over the graph's edges. */
function checkWalk(p: FoundPath, edges: Edge[], direction: 'right' | 'both'): void {
  let at = Number(p.start);
  p.relationships.forEach((r, i) => {
    const e = edges.find((x) => x.id === r)!;
    const next = Number(p.nodes[i]);
    const ok =
      (e.from === at && e.to === next) || (direction === 'both' && e.to === at && e.from === next);
    expect(ok, `${text(p)} step ${i}`).toBe(true);
    at = next;
  });
  expect(at).toBe(p.relationships.length === 0 ? Number(p.start) : Number(p.end));
}

describe('shortest path search from both ends', () => {
  for (const direction of ['right', 'both'] as const) {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      it(`agrees with the search from the start (${direction}, seed ${seed})`, async () => {
        const edges = randomGraph(seed, 40, 70);
        const pairs: Row[] = [];
        for (let i = 0; i < 12; i++) {
          pairs.push({ s: (seed * 7 + i * 3) % 40, t: (seed * 11 + i * 5) % 40 });
        }
        for (const all of [true, false]) {
          for (const min of [0, 1]) {
            for (const maxDepth of [3, 10]) {
              const options: SearchOptions = {
                all,
                min,
                maxDepth,
                maxFrontierSize: 1_000_000,
                maxPaths: 1_000_000,
                ...steps(edges, direction),
              };
              const both = await bidirectional(pairs, options);
              const one = await forward(pairs, options);
              const label = `all=${all} min=${min} max=${maxDepth}`;
              for (const p of both) {
                checkWalk(p, edges, direction);
                expect(p.relationships.length, label).toBeLessThanOrEqual(maxDepth);
                // Shortest paths never repeat a node.
                expect(new Set([String(p.start), ...p.nodes.map(String)]).size, label).toBe(
                  p.nodes.length + 1,
                );
              }
              if (all) {
                expect(both.map(text).sort(), label).toEqual(one.map(text).sort());
              } else {
                // One path per pair, of the same length (which one may differ).
                const lengths = (found: FoundPath[]): string[] =>
                  found
                    .map((p) => `${String(p.start)}>${String(p.end)}=${p.relationships.length}`)
                    .sort();
                expect(lengths(both), label).toEqual(lengths(one));
              }
            }
          }
        }
      });
    }
  }

  it('reads far fewer edges than the search from the start on a large sparse graph', async () => {
    const edges = randomGraph(42, 20_000, 45_000);
    let read = { both: 0, one: 0 };
    const counted = (which: 'both' | 'one'): Pick<SearchOptions, 'expand' | 'expandBackward'> => {
      const s = steps(edges, 'both');
      const count = async (rows: Promise<Row[]>): Promise<Row[]> => {
        const list = await rows;
        read = { ...read, [which]: read[which] + list.length };
        return list;
      };
      return {
        expand: (f) => count(s.expand(f)),
        expandBackward: (f) => count(s.expandBackward(f)),
      };
    };
    // The target: the node farthest from node 1 in its component.
    const neighbours = new Map<number, number[]>();
    for (const e of edges) {
      for (const [a, b] of [
        [e.from, e.to],
        [e.to, e.from],
      ] as const) {
        neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
      }
    }
    const distance = new Map([[1, 0]]);
    let level = [1];
    let far = 1;
    while (level.length > 0) {
      const next: number[] = [];
      for (const n of level) {
        for (const m of neighbours.get(n) ?? []) {
          if (!distance.has(m)) {
            distance.set(m, distance.get(n)! + 1);
            next.push(m);
            far = m;
          }
        }
      }
      level = next;
    }
    expect(distance.get(far)).toBeGreaterThanOrEqual(6);

    const base = { all: false, min: 1, maxDepth: 30, maxFrontierSize: 1_000_000, maxPaths: 10 };
    const pairs = [{ s: 1, t: far }];
    const both = await bidirectional(pairs, { ...base, ...counted('both') });
    const one = await forward(pairs, { ...base, ...counted('one') });
    expect(both.map((p) => p.relationships.length)).toEqual([distance.get(far)]);
    expect(one.map((p) => p.relationships.length)).toEqual([distance.get(far)]);
    expect(read.both * 10).toBeLessThan(read.one);
  });
});
