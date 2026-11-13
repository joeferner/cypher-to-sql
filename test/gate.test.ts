import { describe, expect, it } from 'vitest';
import {
  assertReadOnly,
  createGraph,
  ReadOnlyViolationError,
  SemanticError,
  sqlite,
  UnsupportedFeatureError,
  type CypherError,
  type Graph,
  type SqlExecutor,
} from '../src/index.js';

/** Compiling never touches the database. */
const executor: SqlExecutor = {
  transaction: () => Promise.reject(new Error('compile only')),
};
const readGraph = createGraph({ dialect: sqlite(), executor });
const writeGraph = createGraph({ dialect: sqlite(), executor, readOnly: false });

function errorOf(fn: () => unknown): CypherError {
  try {
    fn();
  } catch (error) {
    return error as CypherError;
  }
  throw new Error('Expected an error');
}

describe('read-only gate', () => {
  it('is the default', () => {
    expect(readGraph.readOnly).toBe(true);
    expect(writeGraph.readOnly).toBe(false);
  });

  it.each([
    ['CREATE ()', 'CREATE', { line: 1, column: 0 }],
    ['MATCH (n)\nDELETE n', 'DELETE', { line: 2, column: 0 }],
    ['MATCH (n) DETACH DELETE n', 'DETACH DELETE', { line: 1, column: 10 }],
    ['MERGE (n)', 'MERGE', { line: 1, column: 0 }],
    ['MATCH (n) SET n.x = 1', 'SET', { line: 1, column: 10 }],
    ['MATCH (n) REMOVE n.x', 'REMOVE', { line: 1, column: 10 }],
    ['UNWIND [1] AS x CREATE ()', 'CREATE', { line: 1, column: 16 }],
  ])('rejects %j with a position and a hint', (cypher, clause, position) => {
    for (const error of [
      errorOf(() => readGraph.compile(cypher)),
      errorOf(() => assertReadOnly(cypher)),
    ]) {
      expect(error).toBeInstanceOf(ReadOnlyViolationError);
      expect(error.message).toContain(`${clause} is not allowed on a read-only graph`);
      expect(error.position).toMatchObject(position);
      expect(error.hint).toMatch(/readOnly: false/);
    }
  });

  it('rejects writes before checking for unsupported features', () => {
    // MERGE is unsupported, but a read-only graph reports the write first.
    expect(errorOf(() => readGraph.compile('MERGE (n) RETURN 1 + 1'))).toBeInstanceOf(
      ReadOnlyViolationError,
    );
  });

  it('accepts read queries', () => {
    expect(() => assertReadOnly('MATCH (n) RETURN n')).not.toThrow();
    expect(readGraph.compile('MATCH (n) RETURN n').readOnly).toBe(true);
  });

  it('marks plans by what they do, not by the graph', () => {
    expect(writeGraph.compile('MATCH (n) RETURN n').readOnly).toBe(true);
    expect(writeGraph.compile('CREATE ()').readOnly).toBe(false);
    expect(writeGraph.compile('MATCH (n) CREATE (n)-[:T]->()').readOnly).toBe(false);
  });

  it('never emits anything but SELECT on a read-only graph', () => {
    const plan = readGraph.compile('UNWIND [1] AS x MATCH (n:A) RETURN n, x LIMIT 3');
    for (const step of plan.steps) {
      expect(step.sql).toMatch(/^SELECT /);
    }
  });
});

describe('feature gate', () => {
  it('rejects unsupported write clauses on a write graph', () => {
    const error = errorOf(() => writeGraph.compile('MATCH (n) DELETE n'));
    expect(error).toBeInstanceOf(UnsupportedFeatureError);
    expect(error.message).toMatch(/^DELETE is not supported yet/);
    expect(error.position).toMatchObject({ line: 1, column: 10 });
  });

  it('rejects misplaced constructs anywhere in the query, at their position', () => {
    const pattern = 'A pattern can be used as a condition only in WHERE';
    const aggregate = 'Aggregate functions cannot be used inside';
    const cases: [string, string, number, Graph?][] = [
      ['MATCH (n) RETURN (n)-->()', pattern, 17],
      ['RETURN 1 ORDER BY [1][CASE 0 WHEN 1 THEN (a)-->() END]', pattern, 41],
      ['MATCH (n) RETURN 1 + size([(n)-->(m) | count(m)])', aggregate, 39],
      ['MATCH (n {k: [x IN [1] | sum(x)]}) RETURN n', aggregate, 25],
      [
        'MATCH (n) WHERE EXISTS { MATCH (n) CREATE (:X) RETURN n } RETURN n',
        'An EXISTS subquery cannot modify the graph',
        35,
        writeGraph,
      ],
    ];
    for (const [cypher, message, column, graph] of cases) {
      const error = errorOf(() => (graph ?? readGraph).compile(cypher));
      expect(error, cypher).toBeInstanceOf(SemanticError);
      expect(error.message, cypher).toContain(message);
      expect(error.position, cypher).toMatchObject({ line: 1, column });
    }
  });

  it('allows patterns as conditions in any WHERE, also nested', () => {
    for (const cypher of [
      'MATCH (n) WHERE (n)-->() RETURN n',
      'MATCH (n) WITH n WHERE NOT (n)-->() RETURN n',
      'MATCH (n) RETURN [x IN [n] WHERE (x)-->()] AS l',
      'MATCH (n) RETURN EXISTS { (n)-->(m) WHERE (m)-->() } AS e',
    ]) {
      expect(() => readGraph.compile(cypher), cypher).not.toThrow();
    }
  });
});
