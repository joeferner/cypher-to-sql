// Reference graphs for the benchmarks and the differential tests (diff/): the
// same seed gives the same graph on every database.

/** A graph to generate: `nodes` nodes, each person with `degree` outgoing KNOWS. */
export interface GraphSpec {
  name: string;
  nodes: number;
  degree: number;
  seed: number;
}

export const GRAPHS: GraphSpec[] = [
  { name: 'small', nodes: 1_000, degree: 4, seed: 1 },
  { name: 'medium', nodes: 10_000, degree: 4, seed: 2 },
  { name: 'dense', nodes: 10_000, degree: 16, seed: 3 },
  { name: 'large', nodes: 100_000, degree: 4, seed: 4 },
];

/** Graphs run when none are named. */
export const DEFAULT_GRAPHS = ['small', 'medium', 'dense'];

export interface GeneratedNode {
  id: number;
  labels: string[];
  properties: Record<string, string | number>;
}

export interface GeneratedEdge {
  id: number;
  start: number;
  end: number;
  type: string;
  properties: Record<string, number>;
}

export interface Graph {
  spec: GraphSpec;
  nodes: GeneratedNode[];
  edges: GeneratedEdge[];
  /** Number of persons; their ids are 1..persons, companies follow. */
  persons: number;
}

const CITIES = Array.from({ length: 20 }, (_, i) => `city${i}`);

/** mulberry32: a small seeded PRNG with uniform output in [0, 1). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A social graph: 90% `Person` nodes, 10% `Company` nodes. Each person KNOWS
 * `degree` other persons, mostly near it in id order (so that there are
 * clusters and long paths) and some anywhere, and WORKS_AT one company.
 */
export function generateGraph(spec: GraphSpec): Graph {
  const rand = random(spec.seed);
  const int = (n: number): number => Math.floor(rand() * n);
  const persons = Math.round(spec.nodes * 0.9);
  const companies = spec.nodes - persons;
  const nodes: GeneratedNode[] = [];
  for (let id = 1; id <= persons; id++) {
    nodes.push({
      id,
      labels: ['Person'],
      properties: {
        name: `p${id}`,
        age: 18 + int(63),
        city: CITIES[int(CITIES.length)]!,
        score: Math.round(rand() * 10_000) / 100,
      },
    });
  }
  for (let i = 1; i <= companies; i++) {
    nodes.push({
      id: persons + i,
      labels: ['Company'],
      properties: { name: `c${i}`, size: 1 + int(1000) },
    });
  }
  const edges: GeneratedEdge[] = [];
  for (let start = 1; start <= persons; start++) {
    const targets = new Set<number>();
    while (targets.size < Math.min(spec.degree, persons - 1)) {
      const near = rand() < 0.7;
      let end = near ? start + int(101) - 50 : 1 + int(persons);
      end = ((((end - 1) % persons) + persons) % persons) + 1;
      if (end !== start) {
        targets.add(end);
      }
    }
    for (const end of targets) {
      edges.push({
        id: edges.length + 1,
        start,
        end,
        type: 'KNOWS',
        properties: { since: 1990 + int(35) },
      });
    }
    edges.push({
      id: edges.length + 1,
      start,
      end: persons + 1 + int(companies),
      type: 'WORKS_AT',
      properties: { since: 1990 + int(35) },
    });
  }
  return { spec, nodes, edges, persons };
}
