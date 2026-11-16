import type { ScalarType } from './dialect/dialect.js';
import type { SourcePosition } from './errors.js';
import type { Row, SqlExecutor, SqlTx } from './executor.js';
import type { Limits } from './limits.js';
import {
  CypherArgumentError,
  CypherConstraintError,
  CypherTypeError,
  EntityNotFoundError,
  UnsupportedFeatureError,
  LimitExceededError,
  SemanticError,
  type CypherError,
} from './errors.js';
import { parseCypherJson, stringifyCypherJson, stringifySqlJson } from './json.js';
import { declaredValue, type PropertyTypes } from './property-types.js';
import { BIDIRECTIONAL_MAX_PAIRS, idsJson, pathsJson, shortestPaths } from './search.js';
import type { Expression } from './ast.js';
import { parseTemporal, sortKey, TemporalError } from './temporal.js';
import { evaluateKnown, TypeMismatch } from './temporal-functions.js';
import { runProcedure, type Procedure } from './procedures.js';
import { parameterValue } from './parameters.js';
import { ENTITY_TAG, RESERVED_KEYS } from './dialect/dialect.js';
import {
  CypherNode,
  CypherPath,
  CypherRelationship,
  CypherDuration,
  CypherTemporal,
  isCypherMap,
  type CypherMap,
  type CypherValue,
} from './values.js';

/**
 * A value bound to a SQL placeholder. Most are known when the query is compiled;
 * the rest are resolved just before a step runs (query parameters, ids created or
 * found by earlier steps, and limits that can be lowered per query).
 */
export type BindValue =
  /** A plain SQL value (string or number), for example a label or a property key. */
  | { kind: 'sql'; value: string | number | bigint }
  /** A Cypher value or query parameter, bound as JSON text. */
  | { kind: 'json'; value: ValueSource }
  /**
   * A property map for a new entity, bound as JSON text with null members removed.
   * Values of keys in `types` must have the declared type.
   */
  | {
      kind: 'properties';
      entries: { key: string; value: ValueSource }[];
      types: PropertyTypes | undefined;
      /** MERGE: a null value is an error (it could never be matched). */
      noNulls?: boolean;
      /** SET items folded into the INSERT (#85), applied to the map in order. */
      patches?: PropertyPatch[];
    }
  | {
      kind: 'propertiesParameter';
      name: string;
      position: SourcePosition;
      types: PropertyTypes | undefined;
      /** SET items folded into the INSERT (#85), applied to the map in order. */
      patches?: PropertyPatch[];
    }
  /** The id of an entity created earlier in the same plan (in the same source row). */
  | { kind: 'entityId'; entity: number }
  /** A column of the current source row, bound as is (for example the id of a matched node). */
  | { kind: 'rowId'; column: string }
  /** The SQL `LIMIT` of a step: `min(user limit, maxRowsPerStep + 1)`. */
  | { kind: 'rowLimit'; userLimit: ValueSource | undefined }
  /** `maxRowsPerStep` itself, as an integer (the paths a variable-length pattern may find). */
  | { kind: 'rowCap' }
  /** The SQL `OFFSET` of a step: the query's SKIP. */
  | { kind: 'rowOffset'; skip: ValueSource }
  /** The SQL `LIMIT` inside a WITH stage: the query's LIMIT exactly (no row cap). */
  | { kind: 'stageLimit'; limit: ValueSource }
  /**
   * The largest number of hops of a variable-length pattern: its upper bound, or
   * `maxPathDepth` when it has none. A bound above `maxPathDepth` is an error.
   */
  | PathDepthBind
  /** The node ids of the current breadth-first search frontier, as a JSON array. */
  | { kind: 'frontier' }
  /** The paths found by shortest path search `search`, as JSON (see Dialect.boundPaths). */
  | { kind: 'shortestPaths'; search: number }
  /** The rows a write query wrote, as a JSON array of objects (see `PlanStep.written`). */
  | { kind: 'writtenRows' }
  /**
   * The ids (a JSON array) of the nodes (`part: 'nodes'`) or relationships of
   * the value in column `column` of the row step `computes: index` returned: a
   * node, a relationship, a path, or null. Any other value is a type error.
   */
  | {
      kind: 'deleteIds';
      index: number;
      column: ColumnSpec;
      part: 'nodes' | 'relationships';
      position: SourcePosition;
    }
  /** The ids (a JSON array) of the nodes DELETE deleted, for the steps after the rows. */
  | { kind: 'deletedNodes' }
  /** The ids the last `forgetsDeleted` step returned, as a JSON array (to delete them without RETURNING). */
  | { kind: 'forgottenNodes' }
  /**
   * A temporal function call, or temporal arithmetic, whose arguments are known
   * before the query runs (see `isKnownBeforeRun`), evaluated when the step is
   * bound, as JSON.
   */
  | { kind: 'temporal'; expression: Expression }
  /**
   * A registered procedure's rows for arguments known before the query runs,
   * called when the step is bound: a JSON array with one list of the output
   * values per row.
   */
  | {
      kind: 'procedure';
      name: string;
      procedure: Procedure;
      args: Expression[];
      position: SourcePosition;
    }
  /**
   * The current source row of a write query as a one-element JSON array, in the
   * form of `writtenRows`: what SET reads its values from, after earlier writes.
   */
  | { kind: 'currentRow'; written: { name: string; value: WrittenValue }[] }
  /**
   * The id of the node or relationship in column `column` of the row that step
   * `computes: index` returned; null when the value is null or an entity of the
   * other kind. Any other value is a type error.
   */
  | {
      kind: 'computedId';
      index: number;
      column: ColumnSpec;
      entity: 'node' | 'relationship';
      position: SourcePosition;
    }
  /**
   * The JSON object a SET or REMOVE merges into (`property`, `merge`) or puts in
   * place of (`replace`) an entity's properties, from column `column` of the
   * row that step `computes: index` returned. The values are checked as CREATE
   * checks them.
   */
  | {
      kind: 'propertyPatch';
      index: number;
      column: ColumnSpec;
      mode: 'property' | 'merge' | 'replace';
      key: string | undefined;
      types: PropertyTypes | undefined;
      position: SourcePosition;
    }
  /**
   * The same JSON object, from a value known without reading the graph (a
   * parameter, a literal, a column of the source row): a SET on an entity this
   * query created or merged needs no SELECT first (#85).
   */
  | (PropertyPatch & { kind: 'valuePatch' })
  /**
   * A query parameter compared with a declared property (`n.age > $min`), as a
   * value of the property's type, so that the comparison is plain SQL that an
   * index can serve: the value, null when it has another type, and an integer
   * bound for a float compared with an integer property (`> 30.5` is `> 30`).
   * `op` is the comparison with the property on the left.
   */
  | ParameterComparison
  /**
   * Whether that parameter can be compared with the property: 1 when its type
   * fits, 0 when not (an `=` that is false), null when it is null or the
   * comparison is null (ordering values of different types).
   */
  | (Omit<ParameterComparison, 'kind'> & { kind: 'parameterFits' });

/**
 * One SET item whose value is known without reading the graph: `n.key = value`
 * (`property`), `n += value` (`merge`), or `n = value` (`replace`). A null
 * value (or a null in the map of `+=`) removes the key.
 */
export interface PropertyPatch {
  mode: 'property' | 'merge' | 'replace';
  key: string | undefined;
  value: ValueSource;
  types: PropertyTypes | undefined;
  position: SourcePosition;
}

export interface ParameterComparison {
  kind: 'parameterAs';
  name: string;
  position: SourcePosition;
  /**
   * The property's declared type. For `date` and `datetime` the value is the
   * sort key (`~k`) of a temporal value of that kind.
   */
  type: 'string' | 'integer' | 'float' | 'date' | 'datetime';
  op: '=' | '<' | '<=' | '>' | '>=';
  /** Instead of the parameter `name`: a temporal function of known arguments. */
  expression?: Expression;
}

/** Where the value of a variable in a written row comes from. */
export type WrittenValue =
  /** The id of an entity created for the row. */
  | { kind: 'entity'; entity: number }
  /** The JSON text the runner holds in entity slot `entity` (FOREACH's variable). */
  | { kind: 'slot'; entity: number }
  /** An id column of the source row (a matched node or relationship). */
  | { kind: 'rowId'; column: string }
  /** A JSON text column of the source row. */
  | { kind: 'rowJson'; column: string }
  /** A text column of the source row, as a JSON string (a relationship's type). */
  | { kind: 'rowString'; column: string };

/**
 * The largest number of hops of a variable-length pattern: its upper bound, or
 * `maxPathDepth` when it has none. A bound above `maxPathDepth` is an error.
 */
export interface PathDepthBind {
  kind: 'pathDepth';
  min: number;
  max: number | undefined;
  position: SourcePosition;
}

/**
 * A breadth-first search for the shortest paths between pairs of nodes. The step
 * that carries it selects the pairs (columns `s` and `t`); the search runs right
 * after that step, one `expand` step per depth, and stops at the depth where it
 * reaches every target.
 */
export interface ShortestPathSearch {
  /** Its number in the plan; `shortestPaths` binds refer to it. */
  index: number;
  /** True for allShortestPaths: every path of the shortest length, not one. */
  all: boolean;
  /** The lower bound of the pattern: 0 or 1. */
  min: number;
  maxDepth: PathDepthBind;
  /** The edges next to the `frontier` nodes, as rows `(f, r, t)`: from node, edge, to node. */
  expand: PlanStep;
  /**
   * The same against the pattern's direction, for the search from the end
   * nodes (`t` comes before `f` on a path). Undefined for an undirected
   * pattern, where it is `expand`.
   */
  expandBackward?: PlanStep | undefined;
}

/**
 * A Cypher value known at compile time, a query parameter, a JSON column of the
 * current source row, or a column of the row a `computes` step returned (a value
 * computed over the row as stored now, such as one that uses FOREACH's variable).
 */
export type ValueSource =
  | { kind: 'constant'; value: CypherValue }
  | { kind: 'parameter'; name: string; position: SourcePosition }
  | { kind: 'row'; column: string }
  | { kind: 'computed'; index: number; column: ColumnSpec };

export interface PlanStep {
  sql: string;
  values: BindValue[];
  /** When set, the step inserts entity `index`. With database ids it returns that id as column `id`. */
  creates?: { entity: number; kind: 'node' | 'relationship' } | undefined;
  /** The step changes the graph without creating an entity (SET, REMOVE). */
  updates?: boolean | undefined;
  /** When set, the step's first row is kept for `computedId` and `propertyPatch` binds. */
  computes?: number | undefined;
  /** When set, the step supplies a generated id for entity `entity` in this bind slot. */
  generatedId?: { entity: number; kind: 'node' | 'relationship' } | undefined;
  /**
   * Per-row steps run once for each row of the step before the first of them (the
   * source step), with `row` values bound from that row. Entity numbers restart for
   * each row. Steps after them do not exist yet.
   */
  perRow?: boolean | undefined;
  /** When set, the step selects the node pairs of this shortest path search, which runs next. */
  search?: ShortestPathSearch | undefined;
  /**
   * When set, the step runs once after the per-row steps (the RETURN of a write
   * query). For each source row, the runner collects these variables into a
   * JSON object, and the `writtenRows` bind gives the array of them.
   */
  written?: { name: string; value: WrittenValue }[] | undefined;
  /** The run-time errors the SQL can raise (see `SqlBuilder.raise`), by index. */
  errors?: RaisedError[] | undefined;
  /**
   * When set (on a `computes` step of DELETE), the nodes in this column of the
   * step's row are deleted after every row's steps ran (see `afterRows`).
   */
  deletesNodes?: ColumnSpec | undefined;
  /** The step runs once, after the per-row steps (the deferred node deletions of DELETE). */
  afterRows?: boolean | undefined;
  /**
   * The write clause the per-row step belongs to (in clause order). Each clause
   * runs for every row before the next one does, as Cypher defines it.
   */
  clause?: number | undefined;
  /** The step runs once after its clause ran for every row (DELETE's node deletions). */
  afterClause?: boolean | undefined;
  /**
   * The query part of a write query the step belongs to (0 when unset). A part
   * after the first starts from the rows the part before it wrote: its step
   * with `written` selects over them, and its per-row steps run for each row
   * that step returns (`... CREATE ... WITH ... CREATE ...`).
   */
  segment?: number | undefined;
  /** The step returns the ids (column `id`) of nodes it deleted; they leave `deletedNodes`. */
  forgetsDeleted?: boolean | undefined;
  /**
   * When set, the step is MERGE's match: it returns the matches of the
   * pattern. With none, `onCreate` runs (the INSERTs, then ON CREATE); with
   * some, the rest of the row runs once for each, after `onMatch`, with the
   * entities in `bind` set from the match's columns.
   */
  merge?:
    | {
        bind: { entity: number; column: ColumnSpec }[];
        onCreate: PlanStep[];
        onMatch: PlanStep[];
      }
    | undefined;
  /**
   * When set, the step is FOREACH's list (its row, column `column`): for each
   * element, the element's JSON goes into entity slot `slot` and `steps` run
   * (clause by clause, see `clause`); the row itself goes on unchanged.
   */
  foreach?:
    { slot: number; column: ColumnSpec; steps: PlanStep[]; position: SourcePosition } | undefined;
}

/** A Cypher error that a step's SQL raises at run time, through `Dialect.raise`. */
export interface RaisedError {
  /** `limit` raises a `LimitExceededError`, with `code` as its hint. */
  /** `unsupported` raises an `UnsupportedFeatureError` (a value the dialect cannot compute with). */
  kind: 'type' | 'argument' | 'limit' | 'constraint' | 'entityNotFound' | 'unsupported';
  /** openCypher's detail code, for example `InvalidArgumentType`. */
  code: string;
  message: string;
  position: SourcePosition | undefined;
}

/** How to build one result column from the SQL columns of the final step. */
export type ColumnSpec =
  | { name: string; kind: 'node'; id: string; labels: string; properties: string }
  | {
      name: string;
      kind: 'relationship';
      id: string;
      type: string;
      startId: string;
      endId: string;
      properties: string;
    }
  /** A JSON value; nodes, relationships, and paths in it are tagged objects (see ENTITY_TAG). */
  | { name: string; kind: 'json'; column: string }
  /** A native SQL value of a known type. */
  | { name: string; kind: 'scalar'; type: ScalarType; column: string };

export interface CompiledPlan {
  /** True when the plan has no write steps. It then runs in a `'read'` transaction. */
  readonly readOnly: boolean;
  readonly steps: readonly PlanStep[];
  /** Result columns, built from the rows of the last step. Empty for queries without `RETURN`. */
  readonly columns: readonly ColumnSpec[];
  /**
   * For `UNION [ALL]`: the plan of each query, run in order in one transaction
   * (`steps` holds all their steps, for reading). `distinct` for UNION.
   */
  readonly union?: { readonly parts: readonly CompiledPlan[]; readonly distinct: boolean };
  /** Readable form of the plan, for logging and tests. */
  explain(): string;
}

export type IdGenerator = (entity: 'node' | 'relationship') => string | number;

export interface ExecuteOptions {
  executor: SqlExecutor;
  params: Record<string, CypherValue>;
  limits: Limits;
  idGenerator: IdGenerator | undefined;
}

export function createPlan(steps: PlanStep[], columns: ColumnSpec[]): CompiledPlan {
  const readOnly = steps.every(
    (s) => s.creates === undefined && !s.updates && !s.merge && !s.foreach,
  );
  return {
    readOnly,
    steps,
    columns,
    explain: () =>
      steps
        .map((s, i) => {
          const note = s.perRow
            ? ' (for each source row)'
            : s.search
              ? ` (node pairs of shortest path search ${s.search.index + 1})`
              : s.written
                ? ` (after the writes, over the written rows: ${s.written.map((w) => w.name).join(', ')})`
                : '';
          let text = `-- step ${i + 1}${note}\n${describeStep(s)}`;
          if (s.search) {
            const { all, min, maxDepth, expandBackward } = s.search;
            text +=
              `\n-- search ${s.search.index + 1}: breadth-first, one step per depth ` +
              `(${all ? 'all shortest paths' : 'one shortest path'} per pair, depth ${min}..` +
              `${describeBind(maxDepth)}), from both ends for up to ${BIDIRECTIONAL_MAX_PAIRS} pairs\n` +
              describeStep(s.search.expand);
            if (expandBackward) {
              text += `\n-- search ${s.search.index + 1}, from the end nodes\n${describeStep(expandBackward)}`;
            }
          }
          return text;
        })
        .join('\n'),
  };
}

/** The plan of `q1 UNION [ALL] q2 ...`, from the plans of its queries. */
export function createUnionPlan(parts: CompiledPlan[], distinct: boolean): CompiledPlan {
  return {
    readOnly: parts.every((p) => p.readOnly),
    steps: parts.flatMap((p) => p.steps),
    columns: parts[0]!.columns,
    union: { parts, distinct },
    explain: () =>
      parts
        .map((p, i) => `-- query ${i + 1} of ${distinct ? 'UNION' : 'UNION ALL'}\n${p.explain()}`)
        .join('\n'),
  };
}

export async function executePlan(
  plan: CompiledPlan,
  options: ExecuteOptions,
): Promise<Record<string, CypherValue>[]> {
  const { executor, limits } = options;
  const deadline = Date.now() + limits.timeoutMs;
  const records = await executor.transaction(plan.readOnly ? 'read' : 'write', async (tx) => {
    const union = plan.union;
    if (!union) {
      return runPlan(tx, plan, options, deadline);
    }
    // Every query of the UNION in the same transaction, in order; their records
    // put together, and for UNION (not UNION ALL) each distinct record once.
    const all: Record<string, CypherValue>[] = [];
    const seen = new Set<string>();
    for (const part of union.parts) {
      for (const raw of await runPlan(tx, part, options, deadline)) {
        // In the column order of the first query.
        const record = Object.fromEntries(plan.columns.map((c) => [c.name, raw[c.name] ?? null]));
        if (union.distinct) {
          const key = plan.columns.map((c) => equivalenceKey(record[c.name] ?? null)).join('|');
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
        }
        all.push(record);
      }
    }
    return all;
  });
  if (records.length > limits.maxResultRows) {
    throw new LimitExceededError(
      `The query returned more than ${limits.maxResultRows} records (maxResultRows)`,
      { hint: 'Add LIMIT to the query.' },
    );
  }
  return records;
}

/**
 * A text that is the same for values that are equivalent in Cypher, as DISTINCT
 * and UNION compare them: `1` and `1.0` are, `null` is equivalent to `null`,
 * entities compare by id, and lists and maps by their elements.
 */
function equivalenceKey(value: CypherValue): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'bigint') {
    return `#${value}`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `#${BigInt(value)}` : `#${value}`;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(equivalenceKey).join(',')}]`;
  }
  if (value instanceof CypherNode) {
    return `node:${value.id}`;
  }
  if (value instanceof CypherRelationship) {
    return `relationship:${value.id}`;
  }
  if (value instanceof CypherPath) {
    return `path:${[...value.nodes, ...value.relationships].map(equivalenceKey).join(',')}`;
  }
  if (value instanceof CypherTemporal) {
    return `${value.kind}:${value.text}`;
  }
  if (value instanceof CypherDuration) {
    return `duration:${value.text}`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${equivalenceKey(value[k] ?? null)}`)
    .join(',')}}`;
}

/** Runs one plan (not a UNION) in `tx`, and assembles its records. */
async function runPlan(
  tx: SqlTx,
  plan: CompiledPlan,
  options: ExecuteOptions,
  deadline: number,
): Promise<Record<string, CypherValue>[]> {
  const { limits } = options;
  const state: RunState = {
    entityIds: new Map(),
    searches: new Map(),
    frontier: undefined,
    written: undefined,
    computed: new Map(),
    deletedNodes: new Map(),
    forgotten: '[]',
  };
  const entityIds = state.entityIds;
  let stepsRun = 0;

  const afterRows = plan.steps.filter((s) => s.afterRows);
  /** The query parts, in order: steps run once (searches, the source), then per-row steps. */
  const segments: { once: PlanStep[]; perRow: PlanStep[] }[] = [];
  for (const step of plan.steps.filter((s) => !s.afterRows)) {
    const segment = (segments[step.segment ?? 0] ??= { once: [], perRow: [] });
    (step.perRow ? segment.perRow : segment.once).push(step);
  }
  const parts = segments.filter((s) => s !== undefined);
  // A last part without per-row steps is the RETURN over the written rows; the
  // deferred node deletions (`afterRows`) run before it.
  const final = parts.at(-1)?.perRow.length === 0 ? parts.at(-1) : undefined;

  const rows = await (async (): Promise<Row[]> => {
    const run = async (step: PlanStep, row: Row | undefined): Promise<Row[]> => {
      if (Date.now() > deadline) {
        throw new LimitExceededError(`Query exceeded the time limit of ${limits.timeoutMs} ms`);
      }
      // Breadth-first searches add steps at run time; compile time checked the rest.
      if (plan.readOnly && ++stepsRun > limits.maxSteps) {
        throw new LimitExceededError(
          `The query needs more than ${limits.maxSteps} SQL steps (maxSteps)`,
          { hint: 'Give shortest path patterns a smaller upper bound.' },
        );
      }
      if (step.generatedId && options.idGenerator) {
        entityIds.set(step.generatedId.entity, options.idGenerator(step.generatedId.kind));
      }
      // Once per bind: with `?` placeholders a bind used twice is listed twice,
      // and a procedure bind must call its procedure once.
      const resolved = new Map<BindValue, unknown>();
      const values = step.values.map((v) => {
        if (!resolved.has(v)) {
          resolved.set(v, resolveBind(v, options, state, row));
        }
        return resolved.get(v);
      });
      let result: Row[];
      try {
        result = await tx.query(step.sql, values);
      } catch (error) {
        throw runtimeError(error, step) ?? error;
      }
      if (result.length > limits.maxRowsPerStep) {
        throw new LimitExceededError(
          `A SQL step returned more than ${limits.maxRowsPerStep} rows (maxRowsPerStep)`,
          { hint: 'Add LIMIT to the query or make the pattern more selective.' },
        );
      }
      if (step.creates && !step.generatedId) {
        entityIds.set(step.creates.entity, result[0]?.['id']);
      }
      if (step.forgetsDeleted) {
        for (const deleted of result) {
          state.deletedNodes.delete(String(deleted['id']));
        }
        state.forgotten = idsJson(result.map((r) => r['id']));
      }
      if (step.computes !== undefined) {
        state.computed.set(step.computes, result[0] ?? {});
        if (step.deletesNodes) {
          for (const id of deleteTargets(state, step.computes, step.deletesNodes, undefined)
            .nodes) {
            state.deletedNodes.set(String(id), id);
          }
        }
      }
      return result;
    };

    // Clause by clause: each write clause runs for every row before the next
    // one. A row carries its entity ids and computed rows; MERGE turns a row
    // into one per match.
    interface Context {
      row: Row | undefined;
      ids: Map<number, unknown>;
      computed: Map<number, Row>;
    }
    const load = (context: Context): void => {
      entityIds.clear();
      context.ids.forEach((v, k) => entityIds.set(k, v));
      state.computed.clear();
      context.computed.forEach((v, k) => state.computed.set(k, v));
    };
    const save = (row: Row | undefined): Context => ({
      row,
      ids: new Map(entityIds),
      computed: new Map(state.computed),
    });
    /** Runs `steps` clause by clause over `contexts`; returns the rows after them. */
    const runClauses = async (steps: PlanStep[], start: Context[]): Promise<Context[]> => {
      let contexts = start;
      const clauses = [...new Set(steps.map((s) => s.clause ?? 0))];
      for (const clause of clauses) {
        contexts = await runClause(
          steps.filter((s) => (s.clause ?? 0) === clause && !s.afterClause),
          contexts,
        );
        for (const step of steps.filter((s) => (s.clause ?? 0) === clause && s.afterClause)) {
          await run(step, undefined);
        }
      }
      return contexts;
    };
    /** One clause's steps for every row; MERGE turns a row into one per match. */
    const runClause = async (clauseSteps: PlanStep[], contexts: Context[]): Promise<Context[]> => {
      const next: Context[] = [];
      for (const context of contexts) {
        load(context);
        let expanded = false;
        for (const step of clauseSteps) {
          const matches = await run(step, context.row);
          const foreach = step.foreach;
          if (foreach) {
            // The inner clauses for each element; the row goes on as it was.
            const list = foreachList(state, step.computes!, foreach.column, foreach.position);
            const before = save(context.row);
            for (const element of list) {
              load(before);
              // SQL JSON: nodes and relationships stay tagged objects, as SQL made them.
              entityIds.set(foreach.slot, stringifySqlJson(element));
              await runClauses(foreach.steps, [save(context.row)]);
            }
            load(before);
            continue;
          }
          const merge = step.merge;
          if (!merge) {
            continue;
          }
          if (matches.length === 0) {
            for (const branch of merge.onCreate) {
              await run(branch, context.row);
            }
            continue;
          }
          const before = save(context.row);
          for (const match of matches) {
            load(before);
            for (const { entity, column } of merge.bind) {
              entityIds.set(
                entity,
                column.kind === 'node' || column.kind === 'relationship' ? match[column.id] : null,
              );
            }
            for (const branch of merge.onMatch) {
              await run(branch, context.row);
            }
            next.push(save(context.row));
          }
          expanded = true;
        }
        if (!expanded) {
          next.push(save(context.row));
        }
      }
      return next;
    };

    /**
     * One query part: its once steps (a step with `written` selects over the
     * rows of the part before), then its per-row steps for each source row.
     */
    let contexts: Context[] | undefined;
    let last: Row[] = [];
    const runPart = async (part: { once: PlanStep[]; perRow: PlanStep[] }): Promise<void> => {
      const writtenStep = part.once.find((s) => s.written);
      if (writtenStep?.written) {
        // One JSON object per row of the part before (one without rows: no source).
        const rows = (contexts ?? [save(undefined)]).map((context) => {
          load(context);
          return writtenRow(writtenStep.written!, entityIds, context.row);
        });
        state.written = `[${rows.join(',')}]`;
        entityIds.clear();
        state.computed.clear();
      }
      for (const step of part.once) {
        await runOnce(step);
      }
      if (part.perRow.length > 0) {
        const perRowEntities = part.perRow.filter((s) => s.creates).length;
        if (last.length * perRowEntities > limits.maxCreatedEntities) {
          throw new LimitExceededError(
            `The query creates more than ${limits.maxCreatedEntities} entities (maxCreatedEntities)`,
          );
        }
        contexts = await runClauses(
          part.perRow,
          last.map((row) => ({ row, ids: new Map(), computed: new Map() })),
        );
        last = [];
      } else {
        contexts = undefined;
      }
    };
    /** One step of a shortest path search, over the frontier's node ids. */
    const expand = async (step: PlanStep, frontier: unknown[]): Promise<Row[]> => {
      state.frontier = idsJson(frontier);
      try {
        return await run(step, undefined);
      } finally {
        state.frontier = undefined;
      }
    };
    const runOnce = async (step: PlanStep): Promise<void> => {
      last = await run(step, undefined);
      const search = step.search;
      if (search) {
        const found = await shortestPaths(last, {
          all: search.all,
          min: search.min,
          maxDepth: resolvePathDepth(search.maxDepth, limits),
          maxFrontierSize: limits.maxFrontierSize,
          maxPaths: limits.maxRowsPerStep,
          expand: (frontier) => expand(search.expand, frontier),
          expandBackward: (frontier) => expand(search.expandBackward ?? search.expand, frontier),
        });
        state.searches.set(search.index, pathsJson(found));
      }
    };

    for (const part of parts) {
      if (part !== final) {
        await runPart(part);
      }
    }
    for (const step of afterRows) {
      await run(step, undefined);
    }
    if (final) {
      await runPart(final);
    }
    return last;
  })();

  if (plan.columns.length === 0) {
    return [];
  }
  if (rows.length > limits.maxResultRows) {
    throw new LimitExceededError(
      `The query returned more than ${limits.maxResultRows} records (maxResultRows)`,
      { hint: 'Add LIMIT to the query.' },
    );
  }
  return rows.map((row) => assembleRecord(row, plan.columns));
}

/**
 * The Cypher error for a database error, or undefined for any other error: an
 * error the SQL raised on purpose (its marker names one of the step's
 * `errors`), or the database's own integer overflow or division by zero.
 */
/**
 * A violation of a unique index of the mapping (`indexes`): PostgreSQL's
 * unique_violation, SQLite's UNIQUE constraint, MySQL's duplicate entry.
 */
export function uniqueViolation(error: unknown, hint: string): CypherConstraintError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (
    code === '23505' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'ER_DUP_ENTRY' ||
    /^UNIQUE constraint failed/.test(message)
  ) {
    return new CypherConstraintError(
      `The write would store a key that a unique index already has: ${message.split('\n')[0]!}`,
      { code: 'ConstraintValidationFailed', hint },
    );
  }
  return undefined;
}

function runtimeError(error: unknown, step: PlanStep): CypherError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const marker = /!cypher:(\d+)/.exec(message);
  if (marker) {
    const raised = step.errors?.[Number(marker[1])];
    if (!raised) {
      return undefined;
    }
    const options = { code: raised.code, position: raised.position };
    if (raised.kind === 'limit') {
      return new LimitExceededError(raised.message, {
        position: raised.position,
        hint: raised.code,
      });
    }
    if (raised.kind === 'constraint') {
      return new CypherConstraintError(raised.message, options);
    }
    if (raised.kind === 'entityNotFound') {
      return new EntityNotFoundError(raised.message, options);
    }
    if (raised.kind === 'unsupported') {
      return new UnsupportedFeatureError(raised.message, { position: raised.position });
    }
    return raised.kind === 'type'
      ? new CypherTypeError(raised.message, options)
      : new CypherArgumentError(raised.message, options);
  }
  // PostgreSQL: numeric_value_out_of_range, division_by_zero. SQLite: integer overflow.
  // MySQL: BIGINT value is out of range.
  if (code === '22003' || /integer overflow|BIGINT value is out of range/.test(message)) {
    return new CypherArgumentError('Integer overflow: the result does not fit in 64 bits', {
      code: 'NumberOutOfRange',
    });
  }
  if (code === '22012') {
    return new CypherArgumentError('Division by zero', { code: 'DivisionByZero' });
  }
  const unique = uniqueViolation(
    error,
    'MERGE on the key instead of CREATE, or give the new entity a different key.',
  );
  if (unique) {
    return unique;
  }
  const temporalType = /cypher temporal type error: ([^"]*)/.exec(message);
  if (temporalType) {
    return new CypherTypeError(temporalType[1]!, { code: 'InvalidArgumentType' });
  }
  // An invalid argument to a temporal function: SQLite's cypher_temporal(), or
  // the PostgreSQL SQL (its own message, a date field out of range, or an
  // unknown time zone).
  const temporal = /cypher temporal error: ([^"]*)/.exec(message);
  if (temporal || code === '22008' || /time zone ".*" not recognized/.test(message)) {
    return new CypherArgumentError(temporal ? temporal[1]! : message, {
      code: 'InvalidArgumentValue',
    });
  }
  // PostgreSQL: invalid_regular_expression. SQLite: the RegExp of cypher_regex().
  // MySQL: the ER_REGEXP_* errors of ICU.
  if (
    code === '2201B' ||
    (typeof code === 'string' && code.startsWith('ER_REGEXP')) ||
    /^invalid regular expression/i.test(message)
  ) {
    return new CypherArgumentError(message, { code: 'InvalidRegex' });
  }
  return undefined;
}

/** Values that earlier steps of a running plan produced. */
interface RunState {
  /** Ids of created entities, by entity number. */
  entityIds: Map<number, unknown>;
  /** JSON text of the paths each shortest path search found. */
  searches: Map<number, string>;
  /** JSON text of the frontier while a search step runs. */
  frontier: string | undefined;
  /** JSON text of the rows a write query wrote, for its RETURN step. */
  written: string | undefined;
  /** The first row of each `computes` step, for the current source row. */
  computed: Map<number, Row>;
  /** The nodes DELETE deleted, by id text, deleted after the per-row steps. */
  deletedNodes: Map<string, unknown>;
  /** JSON array of the ids the last `forgetsDeleted` step returned. */
  forgotten: string;
}

/** One written row as a JSON object: ids of created and matched entities, and JSON values. */
function writtenRow(
  variables: { name: string; value: WrittenValue }[],
  entityIds: Map<number, unknown>,
  row: Row | undefined,
): string {
  const members = variables.map(({ name, value }) => {
    let json: string;
    if (value.kind === 'entity') {
      json = idJsonOrNull(entityIds.get(value.entity));
    } else if (value.kind === 'slot') {
      json = (entityIds.get(value.entity) as string | undefined) ?? 'null';
    } else if (value.kind === 'rowId') {
      json = idJsonOrNull(requireRow(row)[value.column]);
    } else if (value.kind === 'rowString') {
      const text = requireRow(row)[value.column];
      json = typeof text === 'string' ? JSON.stringify(text) : 'null';
    } else {
      const text = requireRow(row)[value.column];
      if (text !== null && text !== undefined && typeof text !== 'string') {
        throw new Error(`Internal error: expected JSON text from the database, got ${typeof text}`);
      }
      json = text ?? 'null';
    }
    return `${JSON.stringify(name)}:${json}`;
  });
  return `{${members.join(',')}}`;
}

function idJsonOrNull(id: unknown): string {
  return id === null || id === undefined ? 'null' : idsJson([id]).slice(1, -1);
}

function resolveBind(
  bind: BindValue,
  options: ExecuteOptions,
  state: RunState,
  row: Row | undefined,
): unknown {
  const { entityIds } = state;
  switch (bind.kind) {
    case 'sql':
      return bind.value;
    case 'json':
      return stringifyCypherJson(resolveValue(bind.value, options.params, row, state));
    case 'properties': {
      const map: CypherMap = {};
      for (const { key, value } of bind.entries) {
        const resolved = resolveValue(value, options.params, row, state);
        if (resolved !== null) {
          map[key] = checkPropertyValue(key, resolved, bind.types, bind.noNulls);
        } else if (bind.noNulls) {
          throw new SemanticError(
            `MERGE cannot use a null property value (for ${JSON.stringify(key)})`,
            { hint: 'A pattern with a null property never matches; leave the property out.' },
          );
        }
      }
      return stringifyCypherJson(applyPatches(map, bind.patches, options, row, state));
    }
    case 'propertiesParameter': {
      const value = resolveValue(
        { kind: 'parameter', name: bind.name, position: bind.position },
        options.params,
        row,
      );
      if (!isCypherMap(value)) {
        throw new SemanticError(`Parameter $${bind.name} must be a map of properties`, {
          position: bind.position,
        });
      }
      const map: CypherMap = {};
      for (const [key, v] of Object.entries(value)) {
        if (v !== null) {
          map[key] = checkPropertyValue(key, v, bind.types);
        }
      }
      return stringifyCypherJson(applyPatches(map, bind.patches, options, row, state));
    }
    case 'entityId': {
      if (!entityIds.has(bind.entity)) {
        throw new Error(`Internal error: entity ${bind.entity} has no id yet`);
      }
      return entityIds.get(bind.entity);
    }
    case 'rowId':
      return requireRow(row)[bind.column];
    case 'rowLimit': {
      const cap = BigInt(options.limits.maxRowsPerStep) + 1n;
      if (!bind.userLimit) {
        return cap;
      }
      const value = resolveValue(bind.userLimit, options.params, row);
      const limit = typeof value === 'number' && Number.isInteger(value) ? BigInt(value) : value;
      if (typeof limit !== 'bigint' || limit < 0n) {
        throw new SemanticError('LIMIT must be a non-negative integer', {
          position: bind.userLimit.kind === 'parameter' ? bind.userLimit.position : undefined,
        });
      }
      return limit < cap ? limit : cap;
    }
    case 'rowCap':
      return BigInt(options.limits.maxRowsPerStep);
    case 'rowOffset':
      return rowCount(bind.skip, 'SKIP', options, row);
    case 'stageLimit':
      return rowCount(bind.limit, 'LIMIT', options, row);
    case 'pathDepth':
      return resolvePathDepth(bind, options.limits);
    case 'frontier':
      if (state.frontier === undefined) {
        throw new Error('Internal error: a frontier is bound outside a search step');
      }
      return state.frontier;
    case 'shortestPaths': {
      const found = state.searches.get(bind.search);
      if (found === undefined) {
        throw new Error(`Internal error: shortest path search ${bind.search} has not run`);
      }
      return found;
    }
    case 'writtenRows':
      if (state.written === undefined) {
        throw new Error('Internal error: written rows are bound before the writes ran');
      }
      return state.written;
    case 'currentRow':
      return `[${writtenRow(bind.written, entityIds, row)}]`;
    case 'procedure': {
      const values = bind.args.map((arg) =>
        evaluateKnown(arg, (name, position) =>
          resolveValue({ kind: 'parameter', name, position }, options.params, row),
        ),
      );
      return stringifyCypherJson(runProcedure(bind.name, bind.procedure, values, bind.position));
    }
    case 'temporal':
      return stringifyCypherJson(knownTemporal(bind.expression, options, row));
    case 'computedId': {
      const computed = computedValue(state, bind.index, bind.column);
      if (computed.raw !== undefined) {
        // A node or relationship column: its id column, as the database returned it.
        return bind.column.kind === bind.entity ? computed.raw : null;
      }
      const value = computed.value;
      if (value === null) {
        return null;
      }
      if (value instanceof CypherNode || value instanceof CypherRelationship) {
        const kind = value instanceof CypherNode ? 'node' : 'relationship';
        return kind === bind.entity ? value.id : null;
      }
      throw new CypherTypeError('Type mismatch: expected a node or relationship', {
        code: 'InvalidArgumentType',
        position: bind.position,
      });
    }
    case 'propertyPatch':
      return stringifyCypherJson(
        patchEntries(bind, computedValue(state, bind.index, bind.column).value),
      );
    case 'valuePatch':
      return stringifyCypherJson(
        patchEntries(bind, resolveValue(bind.value, options.params, row, state)),
      );
    case 'deleteIds':
      return idsJson(deleteTargets(state, bind.index, bind.column, bind.position)[bind.part]);
    case 'deletedNodes':
      return idsJson([...state.deletedNodes.values()]);
    case 'forgottenNodes':
      return state.forgotten;
    case 'parameterAs':
    case 'parameterFits': {
      const value = bind.expression
        ? knownTemporal(bind.expression, options, row)
        : resolveValue(
            { kind: 'parameter', name: bind.name, position: bind.position },
            options.params,
            row,
          );
      const compared = compareParameter(value, bind);
      return bind.kind === 'parameterAs' ? compared.value : compared.fits;
    }
  }
}

/** A temporal function whose arguments are known before the query runs, evaluated. */
function knownTemporal(
  expression: Expression,
  options: ExecuteOptions,
  row: Row | undefined,
): CypherValue {
  try {
    return evaluateKnown(expression, (name, position) =>
      resolveValue({ kind: 'parameter', name, position }, options.params, row),
    );
  } catch (error) {
    if (error instanceof TypeMismatch) {
      throw new CypherTypeError(error.message, {
        code: 'InvalidArgumentType',
        position: expression.position,
      });
    }
    throw error instanceof TemporalError
      ? new CypherArgumentError(error.message, {
          code: 'InvalidArgumentValue',
          position: expression.position,
        })
      : error;
  }
}

/**
 * A parameter as a value of a declared property's type (see `parameterAs`),
 * and whether it fits (see `parameterFits`).
 */
function compareParameter(
  value: CypherValue,
  { type, op }: Omit<ParameterComparison, 'kind' | 'name' | 'position'>,
): { value: string | number | bigint | null; fits: number | null } {
  if (value === null) {
    return { value: null, fits: null };
  }
  /** A value of another type: `=` is false, an ordering is null. */
  const mismatch = { value: null, fits: op === '=' ? 0 : null };
  if (type === 'date' || type === 'datetime') {
    return value instanceof CypherTemporal && value.kind === type
      ? { value: sortKey(parseTemporal(type, value.text)), fits: 1 }
      : mismatch;
  }
  if (type === 'string') {
    return typeof value === 'string' ? { value, fits: 1 } : mismatch;
  }
  if (typeof value === 'bigint') {
    return { value: type === 'float' ? Number(value) : value, fits: 1 };
  }
  if (typeof value !== 'number') {
    return mismatch;
  }
  if (type === 'float') {
    return { value, fits: 1 };
  }
  // A float against an integer property.
  if (Number.isInteger(value)) {
    return { value: BigInt(value), fits: 1 };
  }
  if (!Number.isFinite(value) || op === '=') {
    // No integer equals a fraction. Infinity and NaN have no integer bound, so
    // an ordering with them gives null (Cypher gives true or false).
    return { value: null, fits: op === '=' ? 0 : null };
  }
  // `age > 30.5` is `age > 30`; `age < 30.5` is `age < 31`.
  const bound = op === '<' || op === '>=' ? Math.ceil(value) : Math.floor(value);
  return { value: BigInt(bound), fits: 1 };
}

function resolvePathDepth(bind: PathDepthBind, limits: Limits): number {
  const limit = limits.maxPathDepth;
  const bound = bind.max ?? bind.min;
  if (bound > limit) {
    throw new LimitExceededError(
      `Variable-length pattern bound ${bound} exceeds maxPathDepth (${limit})`,
      { position: bind.position, hint: 'Use a smaller bound, or raise maxPathDepth.' },
    );
  }
  return bind.max ?? limit;
}

/** A SKIP or LIMIT value, which must be a non-negative integer. */
function rowCount(
  source: ValueSource,
  clause: 'SKIP' | 'LIMIT',
  options: ExecuteOptions,
  row: Row | undefined,
): bigint {
  const value = resolveValue(source, options.params, row);
  if (typeof value !== 'bigint' || value < 0n) {
    throw new SemanticError(`${clause} must be a non-negative integer`, {
      position: source.kind === 'parameter' ? source.position : undefined,
    });
  }
  return value;
}

function resolveValue(
  source: ValueSource,
  params: Record<string, CypherValue>,
  row: Row | undefined,
  state?: RunState,
): CypherValue {
  if (source.kind === 'constant') {
    return source.value;
  }
  if (source.kind === 'row') {
    return parseJsonColumn(requireRow(row)[source.column]);
  }
  if (source.kind === 'computed') {
    if (!state) {
      throw new Error('Internal error: a computed value is bound outside a write step');
    }
    return computedValue(state, source.index, source.column).value;
  }
  if (!Object.hasOwn(params, source.name)) {
    throw new SemanticError(`Missing parameter $${source.name}`, { position: source.position });
  }
  return parameterValue(params, source.name, source.position);
}

function requireRow(row: Row | undefined): Row {
  if (!row) {
    throw new Error('Internal error: a row value is bound outside a per-row step');
  }
  return row;
}

/**
 * Property values are scalars or lists of scalars (Cypher has no map-valued
 * properties), and a declared property has its declared type.
 */
/**
 * Column `column` of the row a `computes` step returned, as a Cypher value; for
 * a node or relationship column also the raw id the database returned.
 */
function computedValue(
  state: RunState,
  index: number,
  column: ColumnSpec,
): { value: CypherValue; raw?: unknown } {
  const row = state.computed.get(index);
  if (!row) {
    throw new Error(`Internal error: computed row ${index} is bound before its step ran`);
  }
  const value = assembleRecord(row, [column])[column.name] ?? null;
  return column.kind === 'node' || column.kind === 'relationship'
    ? { value, raw: row[column.id] ?? null }
    : { value };
}

/**
 * The elements of FOREACH's list, as SQL JSON (nodes and relationships still
 * tagged objects); none for null.
 */
function foreachList(
  state: RunState,
  index: number,
  column: ColumnSpec,
  position: SourcePosition,
): CypherValue[] {
  const row = state.computed.get(index) ?? {};
  const list =
    column.kind === 'json'
      ? parseJsonColumn(row[column.column])
      : computedValue(state, index, column).value;
  if (list === null) {
    return [];
  }
  if (!Array.isArray(list)) {
    throw new CypherTypeError('Type mismatch: FOREACH needs a list', {
      code: 'InvalidArgumentType',
      position,
    });
  }
  return list;
}

/** The nodes and relationships (ids) a DELETE value stands for. */
function deleteTargets(
  state: RunState,
  index: number,
  column: ColumnSpec,
  position: SourcePosition | undefined,
): { nodes: unknown[]; relationships: unknown[] } {
  const { value, raw } = computedValue(state, index, column);
  if (raw !== undefined) {
    const ids = raw === null ? [] : [raw];
    return column.kind === 'node'
      ? { nodes: ids, relationships: [] }
      : { nodes: [], relationships: ids };
  }
  if (value === null) {
    return { nodes: [], relationships: [] };
  }
  if (value instanceof CypherNode) {
    return { nodes: [value.id], relationships: [] };
  }
  if (value instanceof CypherRelationship) {
    return { nodes: [], relationships: [value.id] };
  }
  if (value instanceof CypherPath) {
    return {
      nodes: value.nodes.map((n) => n.id),
      relationships: value.relationships.map((r) => r.id),
    };
  }
  throw new CypherTypeError('Type mismatch: DELETE needs a node, relationship, or path', {
    code: 'InvalidArgumentType',
    position,
  });
}

/** The JSON object of a `propertyPatch` bind, from the value SET computed. */
/**
 * The properties of a new entity after the SET items folded into its INSERT
 * (`patches`), applied in order as the UPDATEs would apply them: a null value
 * removes the key, `replace` starts over from the new map.
 */
function applyPatches(
  map: CypherMap,
  patches: PropertyPatch[] | undefined,
  options: ExecuteOptions,
  row: Row | undefined,
  state: RunState,
): CypherMap {
  let out = map;
  for (const patch of patches ?? []) {
    const entries = patchEntries(patch, resolveValue(patch.value, options.params, row, state));
    if (patch.mode === 'replace') {
      out = {};
    }
    for (const [key, value] of Object.entries(entries)) {
      if (value === null) {
        delete out[key];
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

/**
 * The JSON object a SET item merges into an entity's properties (`property`,
 * `merge`; a null value removes its key) or puts in their place (`replace`),
 * from the item's value, checked as CREATE checks property values.
 */
export function patchEntries(
  bind: Pick<PropertyPatch, 'mode' | 'key' | 'types' | 'position'>,
  value: CypherValue,
): CypherMap {
  const patch: CypherMap = {};
  if (bind.mode === 'property') {
    patch[bind.key!] = value === null ? null : checkPropertyValue(bind.key!, value, bind.types);
    return patch;
  }
  let entries: CypherMap;
  if (value === null) {
    entries = {};
  } else if (value instanceof CypherNode || value instanceof CypherRelationship) {
    entries = value.properties;
  } else if (isCypherMap(value)) {
    entries = value;
  } else {
    throw new CypherTypeError('Type mismatch: expected a map, node, or relationship', {
      code: 'InvalidArgumentType',
      position: bind.position,
    });
  }
  for (const [key, v] of Object.entries(entries)) {
    if (v !== null) {
      patch[key] = checkPropertyValue(key, v, bind.types);
    } else if (bind.mode === 'merge') {
      patch[key] = null;
    }
  }
  return patch;
}

/**
 * The value to store for the property `key`, checked (see `declaredValue`);
 * `merging` for the properties of a MERGE pattern.
 */
export function checkPropertyValue(
  key: string,
  value: CypherValue,
  types: PropertyTypes | undefined,
  merging = false,
): CypherValue {
  if (RESERVED_KEYS.has(key)) {
    throw new SemanticError(`The property key ${JSON.stringify(key)} is reserved`);
  }
  const declared = types && Object.hasOwn(types, key) ? types[key] : undefined;
  if (declared) {
    return declaredValue(key, value, declared, merging);
  }
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (
      item !== null &&
      typeof item === 'object' &&
      !(item instanceof CypherTemporal) &&
      !(item instanceof CypherDuration)
    ) {
      throw new SemanticError(
        `Property ${JSON.stringify(key)} cannot be set to a ${Array.isArray(item) ? 'nested list' : 'map, node, or relationship'}`,
        {
          hint: 'Property values must be strings, numbers, booleans, temporal values, durations, or lists of those.',
        },
      );
    }
  }
  return value;
}

function assembleRecord(row: Row, columns: readonly ColumnSpec[]): Record<string, CypherValue> {
  const record: Record<string, CypherValue> = {};
  for (const column of columns) {
    if (column.kind === 'node') {
      const id = row[column.id];
      record[column.name] =
        id === null || id === undefined
          ? null
          : new CypherNode(
              idToString(id),
              parseJsonColumn(row[column.labels]) as string[],
              parseJsonColumn(row[column.properties]) as CypherMap,
            );
    } else if (column.kind === 'relationship') {
      const id = row[column.id];
      record[column.name] =
        id === null || id === undefined
          ? null
          : new CypherRelationship(
              idToString(id),
              String(row[column.type]),
              idToString(row[column.startId]),
              idToString(row[column.endId]),
              parseJsonColumn(row[column.properties]) as CypherMap,
            );
    } else if (column.kind === 'scalar') {
      record[column.name] = scalarValue(row[column.column], column.type);
    } else {
      record[column.name] = decodeEntities(parseJsonColumn(row[column.column]));
    }
  }
  return record;
}

/**
 * A native SQL value as a Cypher value. Drivers differ: `pg` returns bigint as
 * text and booleans as booleans; SQLite returns booleans as 1 and 0.
 */
function scalarValue(raw: unknown, type: ScalarType): CypherValue {
  if (raw === null || raw === undefined) {
    return null;
  }
  switch (type) {
    case 'integer':
      return BigInt(raw as string | number | bigint);
    case 'float':
      return Number(raw);
    case 'boolean':
      return raw === true || raw === 1 || raw === 1n || raw === '1' || raw === 't';
    case 'string':
      if (typeof raw !== 'string') {
        throw new Error(`Internal error: expected a string from the database, got ${typeof raw}`);
      }
      return raw;
  }
}

/** Ids are whatever the driver returns for the id column: a string, number, or bigint. */
function idToString(id: unknown): string {
  if (typeof id === 'string' || typeof id === 'number' || typeof id === 'bigint') {
    return String(id);
  }
  throw new Error(`Internal error: unexpected id value of type ${typeof id} from the database`);
}

/** Turns the tagged objects in a JSON result value into nodes, relationships, and paths. */
function decodeEntities(value: CypherValue): CypherValue {
  if (Array.isArray(value)) {
    return value.map(decodeEntities);
  }
  if (!isCypherMap(value)) {
    return value;
  }
  const tag = value[ENTITY_TAG];
  if (tag === 'path') {
    return new CypherPath(
      (value['~nodes'] as CypherValue[]).map(decodeEntities) as CypherNode[],
      (value['~relationships'] as CypherValue[]).map(decodeEntities) as CypherRelationship[],
    );
  }
  const out: CypherMap = {};
  for (const [key, v] of Object.entries(value)) {
    if (tag === undefined || !RESERVED_KEYS.has(key)) {
      out[key] = decodeEntities(v);
    }
  }
  if (tag === 'node') {
    return new CypherNode(idToString(value['~id']), value['~labels'] as string[], out);
  }
  if (tag === 'relationship') {
    return new CypherRelationship(
      idToString(value['~id']),
      value['~type'] as string,
      idToString(value['~start']),
      idToString(value['~end']),
      out,
    );
  }
  return out;
}

function parseJsonColumn(raw: unknown): CypherValue {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new Error(`Internal error: expected JSON text from the database, got ${typeof raw}`);
  }
  return parseCypherJson(raw);
}

function describeStep(step: PlanStep): string {
  return `${step.sql}\n-- values: ${step.values.map(describeBind).join(', ')}`;
}

/** A SET item applied without reading the graph: `merge(row.props)`, `property p(...)`. */
function describePatch(patch: PropertyPatch): string {
  return `${patch.mode}${patch.key === undefined ? '' : ` ${patch.key}`}(${describeSource(patch.value)})`;
}

/** SET items folded into an INSERT's properties (#85). */
function describePatches(patches: PropertyPatch[] | undefined): string {
  return patches?.length ? ` then ${patches.map(describePatch).join(' then ')}` : '';
}

function describeBind(bind: BindValue): string {
  switch (bind.kind) {
    case 'sql':
      return JSON.stringify(typeof bind.value === 'bigint' ? bind.value.toString() : bind.value);
    case 'json':
      return describeSource(bind.value);
    case 'properties':
      return (
        `{${bind.entries.map((e) => `${e.key}: ${describeSource(e.value)}`).join(', ')}}` +
        describePatches(bind.patches)
      );
    case 'propertiesParameter':
      return `$${bind.name}${describePatches(bind.patches)}`;
    case 'entityId':
      return `id(entity ${bind.entity})`;
    case 'rowId':
      return `row.${bind.column}`;
    case 'rowLimit':
      return bind.userLimit
        ? `limit(${describeSource(bind.userLimit)})`
        : 'limit(maxRowsPerStep + 1)';
    case 'rowCap':
      return 'maxRowsPerStep';
    case 'rowOffset':
      return `skip(${describeSource(bind.skip)})`;
    case 'stageLimit':
      return `limit(${describeSource(bind.limit)})`;
    case 'pathDepth':
      return bind.max === undefined ? 'maxPathDepth' : `depth(${bind.max})`;
    case 'frontier':
      return 'frontier';
    case 'shortestPaths':
      return `shortestPaths(search ${bind.search + 1})`;
    case 'writtenRows':
      return 'writtenRows';
    case 'currentRow':
      return `currentRow(${bind.written.map((w) => w.name).join(', ')})`;
    case 'procedure':
      return `${bind.name}(...)`;
    case 'temporal':
      return bind.expression.type === 'FunctionCall'
        ? `${bind.expression.name}(...)`
        : `temporal ${bind.expression.type === 'Binary' ? bind.expression.operator : 'value'}`;
    case 'computedId':
      return `id(computed ${bind.index + 1}.${bind.column.name}, ${bind.entity})`;
    case 'deleteIds':
      return `${bind.part}(computed ${bind.index + 1}.${bind.column.name})`;
    case 'deletedNodes':
      return 'deletedNodes';
    case 'forgottenNodes':
      return 'forgottenNodes';
    case 'propertyPatch':
      return `${bind.mode}${bind.key === undefined ? '' : ` ${bind.key}`}(computed ${bind.index + 1}.${bind.column.name})`;
    case 'valuePatch':
      return describePatch(bind);
    case 'parameterAs':
      return `$${bind.name} as ${bind.type}`;
    case 'parameterFits':
      return `$${bind.name} fits ${bind.type}`;
  }
}

function describeSource(source: ValueSource): string {
  switch (source.kind) {
    case 'parameter':
      return `$${source.name}`;
    case 'row':
      return `row.${source.column}`;
    case 'constant':
      return stringifyCypherJson(source.value);
    case 'computed':
      return `computed ${source.index + 1}.${source.column.name}`;
  }
}
