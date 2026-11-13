import type { ScalarType } from './dialect/dialect.js';
import type { SourcePosition } from './errors.js';
import type { Row, SqlExecutor } from './executor.js';
import type { Limits } from './limits.js';
import {
  CypherArgumentError,
  CypherTypeError,
  LimitExceededError,
  SemanticError,
  type CypherError,
} from './errors.js';
import { parseCypherJson, stringifyCypherJson } from './json.js';
import { checkDeclaredType, type PropertyTypes } from './property-types.js';
import { idsJson, pathsJson, shortestPaths } from './search.js';
import type { FunctionCall } from './ast.js';
import { TemporalError } from './temporal.js';
import { evaluateKnown } from './temporal-functions.js';
import { ENTITY_TAG, RESERVED_KEYS } from './dialect/dialect.js';
import {
  CypherNode,
  CypherPath,
  CypherRelationship,
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
    }
  | {
      kind: 'propertiesParameter';
      name: string;
      position: SourcePosition;
      types: PropertyTypes | undefined;
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
   * A temporal function call whose arguments are known before the query runs
   * (see `isKnownBeforeRun`), evaluated when the step is bound, as JSON.
   */
  | { kind: 'temporal'; call: FunctionCall }
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

export interface ParameterComparison {
  kind: 'parameterAs';
  name: string;
  position: SourcePosition;
  type: 'string' | 'integer' | 'float';
  op: '=' | '<' | '<=' | '>' | '>=';
}

/** Where the value of a variable in a written row comes from. */
export type WrittenValue =
  /** The id of an entity created for the row. */
  | { kind: 'entity'; entity: number }
  /** An id column of the source row (a matched node or relationship). */
  | { kind: 'rowId'; column: string }
  /** A JSON text column of the source row. */
  | { kind: 'rowJson'; column: string };

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
}

/** A Cypher value known at compile time, a query parameter, or a JSON column of the current source row. */
export type ValueSource =
  | { kind: 'constant'; value: CypherValue }
  | { kind: 'parameter'; name: string; position: SourcePosition }
  | { kind: 'row'; column: string };

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
}

/** A Cypher error that a step's SQL raises at run time, through `Dialect.raise`. */
export interface RaisedError {
  /** `limit` raises a `LimitExceededError`, with `code` as its hint. */
  kind: 'type' | 'argument' | 'limit';
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
  const readOnly = steps.every((s) => s.creates === undefined && !s.updates);
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
            const { all, min, maxDepth } = s.search;
            text +=
              `\n-- search ${s.search.index + 1}: breadth-first, one step per depth ` +
              `(${all ? 'all shortest paths' : 'one shortest path'} per pair, depth ${min}..` +
              `${describeBind(maxDepth)})\n${describeStep(s.search.expand)}`;
          }
          return text;
        })
        .join('\n'),
  };
}

export async function executePlan(
  plan: CompiledPlan,
  options: ExecuteOptions,
): Promise<Record<string, CypherValue>[]> {
  const { executor, limits } = options;
  const deadline = Date.now() + limits.timeoutMs;
  const state: RunState = {
    entityIds: new Map(),
    searches: new Map(),
    frontier: undefined,
    written: undefined,
    computed: new Map(),
  };
  const entityIds = state.entityIds;
  let stepsRun = 0;

  const final = plan.steps.find((s) => s.written);
  const steps = plan.steps.filter((s) => s !== final);
  const firstPerRow = steps.findIndex((s) => s.perRow);
  const once = firstPerRow < 0 ? steps : steps.slice(0, firstPerRow);
  const perRow = firstPerRow < 0 ? [] : steps.slice(firstPerRow);
  /** For a write query with RETURN: one JSON object per source row (see `PlanStep.written`). */
  const written: string[] = [];
  const collect = (row: Row | undefined): void => {
    if (final?.written) {
      written.push(writtenRow(final.written, entityIds, row));
    }
  };

  const rows = await executor.transaction(plan.readOnly ? 'read' : 'write', async (tx) => {
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
      const values = step.values.map((v) => resolveBind(v, options, state, row));
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
      if (step.computes !== undefined) {
        state.computed.set(step.computes, result[0] ?? {});
      }
      return result;
    };

    let last: Row[] = [];
    for (const step of once) {
      last = await run(step, undefined);
      const search = step.search;
      if (search) {
        const found = await shortestPaths(last, {
          all: search.all,
          min: search.min,
          maxDepth: resolvePathDepth(search.maxDepth, limits),
          maxFrontierSize: limits.maxFrontierSize,
          maxPaths: limits.maxRowsPerStep,
          expand: async (frontier) => {
            state.frontier = idsJson(frontier);
            try {
              return await run(search.expand, undefined);
            } finally {
              state.frontier = undefined;
            }
          },
        });
        state.searches.set(search.index, pathsJson(found));
      }
    }
    if (perRow.length > 0) {
      const perRowEntities = perRow.filter((s) => s.creates).length;
      if (last.length * perRowEntities > limits.maxCreatedEntities) {
        throw new LimitExceededError(
          `The query creates more than ${limits.maxCreatedEntities} entities (maxCreatedEntities)`,
        );
      }
      for (const row of last) {
        entityIds.clear();
        state.computed.clear();
        for (const step of perRow) {
          await run(step, row);
        }
        collect(row);
      }
      last = [];
    } else if (final) {
      collect(undefined);
    }
    if (final) {
      state.written = `[${written.join(',')}]`;
      last = await run(final, undefined);
    }
    return last;
  });

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
    return raised.kind === 'type'
      ? new CypherTypeError(raised.message, options)
      : new CypherArgumentError(raised.message, options);
  }
  // PostgreSQL: numeric_value_out_of_range, division_by_zero. SQLite: integer overflow.
  if (code === '22003' || /integer overflow/.test(message)) {
    return new CypherArgumentError('Integer overflow: the result does not fit in 64 bits', {
      code: 'NumberOutOfRange',
    });
  }
  if (code === '22012') {
    return new CypherArgumentError('Division by zero', { code: 'DivisionByZero' });
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
  if (code === '2201B' || /^invalid regular expression/i.test(message)) {
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
    } else if (value.kind === 'rowId') {
      json = idJsonOrNull(requireRow(row)[value.column]);
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
      return stringifyCypherJson(resolveValue(bind.value, options.params, row));
    case 'properties': {
      const map: CypherMap = {};
      for (const { key, value } of bind.entries) {
        const resolved = resolveValue(value, options.params, row);
        if (resolved !== null) {
          checkPropertyValue(key, resolved, bind.types);
          map[key] = resolved;
        }
      }
      return stringifyCypherJson(map);
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
          checkPropertyValue(key, v, bind.types);
          map[key] = v;
        }
      }
      return stringifyCypherJson(map);
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
    case 'temporal':
      try {
        return stringifyCypherJson(
          evaluateKnown(bind.call, (name, position) =>
            resolveValue({ kind: 'parameter', name, position }, options.params, row),
          ),
        );
      } catch (error) {
        throw error instanceof TemporalError
          ? new CypherArgumentError(error.message, {
              code: 'InvalidArgumentValue',
              position: bind.call.position,
            })
          : error;
      }
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
      return propertyPatch(bind, computedValue(state, bind.index, bind.column).value);
    case 'parameterAs':
    case 'parameterFits': {
      const value = resolveValue(
        { kind: 'parameter', name: bind.name, position: bind.position },
        options.params,
        row,
      );
      const compared = compareParameter(value, bind);
      return bind.kind === 'parameterAs' ? compared.value : compared.fits;
    }
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
): CypherValue {
  if (source.kind === 'constant') {
    return source.value;
  }
  if (source.kind === 'row') {
    return parseJsonColumn(requireRow(row)[source.column]);
  }
  if (!Object.hasOwn(params, source.name)) {
    throw new SemanticError(`Missing parameter $${source.name}`, { position: source.position });
  }
  return params[source.name] ?? null;
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

/** The JSON object of a `propertyPatch` bind, from the value SET computed. */
function propertyPatch(
  bind: Extract<BindValue, { kind: 'propertyPatch' }>,
  value: CypherValue,
): string {
  const patch: CypherMap = {};
  if (bind.mode === 'property') {
    if (value !== null) {
      checkPropertyValue(bind.key!, value, bind.types);
    }
    patch[bind.key!] = value;
    return stringifyCypherJson(patch);
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
      checkPropertyValue(key, v, bind.types);
      patch[key] = v;
    } else if (bind.mode === 'merge') {
      patch[key] = null;
    }
  }
  return stringifyCypherJson(patch);
}

function checkPropertyValue(
  key: string,
  value: CypherValue,
  types: PropertyTypes | undefined,
): void {
  if (RESERVED_KEYS.has(key)) {
    throw new SemanticError(`The property key ${JSON.stringify(key)} is reserved`);
  }
  const declared = types && Object.hasOwn(types, key) ? types[key] : undefined;
  if (declared) {
    checkDeclaredType(key, value, declared);
    return;
  }
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (item !== null && typeof item === 'object' && !(item instanceof CypherTemporal)) {
      throw new SemanticError(
        `Property ${JSON.stringify(key)} cannot be set to a ${Array.isArray(item) ? 'nested list' : 'map, node, or relationship'}`,
        { hint: 'Property values must be strings, numbers, booleans, or lists of those.' },
      );
    }
  }
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

function describeBind(bind: BindValue): string {
  switch (bind.kind) {
    case 'sql':
      return JSON.stringify(typeof bind.value === 'bigint' ? bind.value.toString() : bind.value);
    case 'json':
      return describeSource(bind.value);
    case 'properties':
      return `{${bind.entries.map((e) => `${e.key}: ${describeSource(e.value)}`).join(', ')}}`;
    case 'propertiesParameter':
      return `$${bind.name}`;
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
    case 'temporal':
      return `${bind.call.name}(...)`;
    case 'computedId':
      return `id(computed ${bind.index + 1}.${bind.column.name}, ${bind.entity})`;
    case 'propertyPatch':
      return `${bind.mode}${bind.key === undefined ? '' : ` ${bind.key}`}(computed ${bind.index + 1}.${bind.column.name})`;
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
  }
}
