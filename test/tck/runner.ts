import type { PickleStep } from '@cucumber/messages';
import {
  assertReadOnly,
  CypherArgumentError,
  CypherSyntaxError,
  CypherConstraintError,
  CypherTypeError,
  createGraph,
  ReadOnlyViolationError,
  SemanticError,
  UnsupportedFeatureError,
  type CypherValue,
  type Graph,
} from '../../src/index.js';
import { parseCypherJson, stringifyCypherJson } from '../../src/json.js';
import type { TestBackend, TestDatabase } from '../support/backends.js';
import type { TckScenario } from './features.js';
import { canonical, fromCypher, parseTckValue, toCypher } from './values.js';

export type Outcome = { status: 'passed' } | { status: 'skipped'; reason: string };

/** Graph contents as sets, for the TCK's side-effect counts. */
interface GraphState {
  nodes: Set<string>;
  relationships: Set<string>;
  labels: Set<string>;
  properties: Set<string>;
}

type QueryResult =
  | { kind: 'records'; columns: string[]; records: Record<string, CypherValue>[] }
  | { kind: 'error'; phase: 'compile' | 'runtime'; error: unknown };

class Skip extends Error {}

/**
 * Runs one scenario. Setup (`having executed`) runs on a graph with
 * `readOnly: false`. The scenario's query runs on a graph with `readOnly: true`;
 * a query with write clauses must be rejected there (which tests the gate) and
 * then runs on the write graph. Unsupported features skip the scenario.
 */
export async function runScenario(scenario: TckScenario, backend: TestBackend): Promise<Outcome> {
  const db = await backend.open();
  try {
    await runSteps(scenario, db);
    return { status: 'passed' };
  } catch (error) {
    if (error instanceof Skip) {
      return { status: 'skipped', reason: error.message };
    }
    throw error;
  } finally {
    await db.close();
  }
}

async function runSteps(scenario: TckScenario, db: TestDatabase): Promise<void> {
  const options = { dialect: db.dialect, executor: db.executor };
  const writeGraph = createGraph({ ...options, readOnly: false });
  const readGraph = createGraph({ ...options, readOnly: true });
  let params: Record<string, CypherValue> = {};
  let result: QueryResult | undefined;
  let before: GraphState | undefined;
  let after: GraphState | undefined;

  for (const step of scenario.pickle.steps) {
    const text = step.text;
    let m: RegExpExecArray | null;

    if (text === 'an empty graph' || text === 'any graph') {
      continue;
    } else if (text.startsWith('there exists a procedure ')) {
      throw new Skip('Procedures (CALL) are a non-goal');
    } else if ((m = /^the (\S+) graph$/.exec(text))) {
      throw new Skip(`Named TCK graph "${m[1]}" is not supported by the harness yet`);
    } else if (text === 'having executed:') {
      await runSetup(writeGraph, docString(step));
    } else if (text === 'parameters are:') {
      params = parameters(step);
    } else if (text === 'executing query:' || text === 'executing control query:') {
      before = await snapshot(db);
      result = await executeQuery(readGraph, writeGraph, docString(step), params);
      after = await snapshot(db);
    } else if (
      (m =
        /^the result should be(, in any order|, in order)?( \(ignoring element order for lists\))?:$/.exec(
          text,
        ))
    ) {
      checkResult(requireResult(result), step, {
        ordered: m[1] === ', in order',
        unorderedLists: m[2] !== undefined,
      });
    } else if (text === 'the result should be empty') {
      const records = requireRecords(requireResult(result));
      if (records.records.length > 0) {
        throw new Error(`Expected no records, got ${records.records.length}`);
      }
    } else if (
      (m = /^an? (\w+) should be raised at (compile time|runtime|any time): (\S+)$/.exec(text))
    ) {
      checkError(requireResult(result), m[1]!, m[2]!, m[3]!);
    } else if (text === 'no side effects') {
      checkSideEffects(before, after, new Map());
    } else if (text === 'the side effects should be:') {
      checkSideEffects(before, after, sideEffectTable(step));
    } else {
      throw new Error(`Unsupported TCK step: ${text}`);
    }
  }
}

async function runSetup(graph: Graph, cypher: string): Promise<void> {
  try {
    await graph.query(cypher);
  } catch (error) {
    if (error instanceof UnsupportedFeatureError) {
      throw new Skip(`Setup query uses an unsupported feature: ${error.message}`);
    }
    throw error;
  }
}

async function executeQuery(
  readGraph: Graph,
  writeGraph: Graph,
  cypher: string,
  params: Record<string, CypherValue>,
): Promise<QueryResult> {
  let graph = readGraph;
  try {
    assertReadOnly(cypher);
  } catch (error) {
    if (error instanceof ReadOnlyViolationError) {
      // The read-only graph must refuse the query before anything runs.
      let refused = false;
      try {
        readGraph.compile(cypher);
      } catch (gateError) {
        refused = gateError instanceof ReadOnlyViolationError;
      }
      if (!refused) {
        throw new Error('The read-only graph did not reject a write query', { cause: error });
      }
      graph = writeGraph;
    }
    // Other errors (syntax errors) are reported by compile() below.
  }

  let columns: string[];
  try {
    columns = graph.compile(cypher).columns.map((c) => c.name);
  } catch (error) {
    return { kind: 'error', phase: 'compile', error };
  }
  try {
    return { kind: 'records', columns, records: await graph.query(cypher, params) };
  } catch (error) {
    return { kind: 'error', phase: 'runtime', error };
  }
}

function requireResult(result: QueryResult | undefined): QueryResult {
  if (!result) {
    throw new Error('Scenario checks a result before executing a query');
  }
  return result;
}

function requireRecords(result: QueryResult): Extract<QueryResult, { kind: 'records' }> {
  if (result.kind === 'error') {
    if (result.error instanceof UnsupportedFeatureError) {
      throw new Skip(`Query uses an unsupported feature: ${result.error.message}`);
    }
    throw result.error;
  }
  return result;
}

function checkResult(
  result: QueryResult,
  step: PickleStep,
  options: { ordered: boolean; unorderedLists: boolean },
): void {
  const { columns, records } = requireRecords(result);
  const [header, ...rows] = table(step);
  if (!header) {
    throw new Error('Result table has no header');
  }
  if (JSON.stringify(header) !== JSON.stringify(columns)) {
    throw new Error(`Expected columns ${JSON.stringify(header)}, got ${JSON.stringify(columns)}`);
  }
  const format = { unorderedLists: options.unorderedLists };
  const expected = rows.map((row) =>
    row.map((cell) => canonical(parseTckValue(cell), format)).join(' | '),
  );
  const actual = records.map((record) =>
    columns.map((c) => canonical(fromCypher(record[c] ?? null), format)).join(' | '),
  );
  if (!options.ordered) {
    expected.sort();
    actual.sort();
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `Result mismatch (${options.ordered ? 'in order' : 'in any order'})\n` +
        `expected:\n  ${expected.join('\n  ') || '(no rows)'}\n` +
        `actual:\n  ${actual.join('\n  ') || '(no rows)'}`,
    );
  }
}

/** Which of our error classes satisfy each TCK error type. */
const ERROR_TYPES: Record<string, (new (...args: never[]) => Error)[]> = {
  SyntaxError: [CypherSyntaxError, SemanticError],
  SemanticError: [SemanticError],
  TypeError: [SemanticError, CypherTypeError],
  ArgumentError: [SemanticError, CypherArgumentError],
  ParameterMissing: [SemanticError],
  ConstraintVerificationFailed: [CypherConstraintError],
};

function checkError(result: QueryResult, type: string, phase: string, detail: string): void {
  if (result.kind === 'records') {
    throw new Error(`Expected ${type} (${detail}) at ${phase}, but the query succeeded`);
  }
  const error = result.error;
  if (error instanceof UnsupportedFeatureError) {
    throw new Skip(`Query uses an unsupported feature: ${error.message}`);
  }
  const accepted = ERROR_TYPES[type];
  if (!accepted) {
    throw new Error(`Harness does not know TCK error type ${type}`);
  }
  if (!accepted.some((cls) => error instanceof cls)) {
    throw new Error(`Expected ${type} (${detail}), got ${String(error)}`, { cause: error });
  }
  const expectedPhase =
    phase === 'compile time' ? 'compile' : phase === 'runtime' ? 'runtime' : undefined;
  if (expectedPhase && result.phase !== expectedPhase) {
    throw new Error(
      `Expected ${type} (${detail}) at ${phase}, but it was raised at ${result.phase}`,
    );
  }
}

// ---- side effects --------------------------------------------------------------

async function snapshot({ executor, dialect }: TestDatabase): Promise<GraphState> {
  const json = (column: string): string => `${dialect.jsonText(column)} AS ${column}`;
  return executor.transaction('read', async (tx) => {
    const state: GraphState = {
      nodes: new Set(),
      relationships: new Set(),
      labels: new Set(),
      properties: new Set(),
    };
    const addProperties = (entity: string, json: unknown): void => {
      const props = parseCypherJson(String(json)) as Record<string, CypherValue>;
      for (const [key, value] of Object.entries(props)) {
        state.properties.add(`${entity}.${key}=${stringifyCypherJson(value)}`);
      }
    };
    for (const row of await tx.query(
      `SELECT id, ${json('labels')}, ${json('properties')} FROM nodes`,
      [],
    )) {
      const id = `n${String(row['id'])}`;
      state.nodes.add(id);
      for (const label of parseCypherJson(String(row['labels'])) as string[]) {
        state.labels.add(label);
      }
      addProperties(id, row['properties']);
    }
    for (const row of await tx.query(`SELECT id, ${json('properties')} FROM edges`, [])) {
      const id = `r${String(row['id'])}`;
      state.relationships.add(id);
      addProperties(id, row['properties']);
    }
    return state;
  });
}

function checkSideEffects(
  before: GraphState | undefined,
  after: GraphState | undefined,
  expected: Map<string, number>,
): void {
  if (!before || !after) {
    throw new Error('Scenario checks side effects before executing a query');
  }
  const added = (a: Set<string>, b: Set<string>): number => [...b].filter((x) => !a.has(x)).length;
  const actual = new Map<string, number>([
    ['+nodes', added(before.nodes, after.nodes)],
    ['-nodes', added(after.nodes, before.nodes)],
    ['+relationships', added(before.relationships, after.relationships)],
    ['-relationships', added(after.relationships, before.relationships)],
    ['+labels', added(before.labels, after.labels)],
    ['-labels', added(after.labels, before.labels)],
    ['+properties', added(before.properties, after.properties)],
    ['-properties', added(after.properties, before.properties)],
  ]);
  for (const key of expected.keys()) {
    if (!actual.has(key)) {
      throw new Error(`Unknown side effect ${key}`);
    }
  }
  const diffs = [...actual]
    .filter(([key, count]) => count !== (expected.get(key) ?? 0))
    .map(([key, count]) => `${key}: expected ${expected.get(key) ?? 0}, got ${count}`);
  if (diffs.length > 0) {
    throw new Error(`Side effects differ: ${diffs.join('; ')}`);
  }
}

// ---- step arguments ------------------------------------------------------------

function docString(step: PickleStep): string {
  const content = step.argument?.docString?.content;
  if (content === undefined) {
    throw new Error(`Step "${step.text}" has no doc string`);
  }
  return content;
}

function table(step: PickleStep): string[][] {
  const rows = step.argument?.dataTable?.rows;
  if (!rows) {
    throw new Error(`Step "${step.text}" has no table`);
  }
  return rows.map((row) => row.cells.map((cell) => cell.value));
}

function parameters(step: PickleStep): Record<string, CypherValue> {
  return Object.fromEntries(
    table(step).map(([name, value]) => [name!, toCypher(parseTckValue(value!))]),
  );
}

function sideEffectTable(step: PickleStep): Map<string, number> {
  return new Map(table(step).map(([key, value]) => [key!, Number(value)]));
}
