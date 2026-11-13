import type * as ast from './ast.js';
import type { Dialect } from './dialect/dialect.js';
import { LimitExceededError, ReadOnlyViolationError, UnsupportedFeatureError } from './errors.js';
import type { SqlExecutor } from './executor.js';
import { defaultLimits, lowerLimits, type Limits } from './limits.js';
import { defaultMapping, validateMapping, type GraphMapping } from './mapping.js';
import { parse } from './parser/parse.js';
import {
  createPlan,
  executePlan,
  type ColumnSpec,
  type CompiledPlan,
  type PlanStep,
  type WrittenValue,
} from './plan.js';
import { assertQueryReadOnly, assertSupported, hasWriteClause } from './planner/gate.js';
import {
  planRead,
  planWrittenReturn,
  ReadScope,
  RowSource,
  type WrittenVariable,
} from './planner/read.js';
import { SqlBuilder } from './planner/sql-builder.js';
import {
  WritePlanner,
  type CreatedEntity,
  type CreateSource,
  type IdStrategy,
} from './planner/write.js';
import type { CypherValue } from './values.js';

export interface GraphOptions {
  dialect: Dialect;
  executor: SqlExecutor;
  /** Defaults to `defaultMapping` (tables `nodes` and `edges`). */
  mapping?: GraphMapping | undefined;
  /** Defaults to true. With false, CREATE is allowed (the only write clause in version 1). */
  readOnly?: boolean | undefined;
  /** Graph-wide limits. Unset entries use `defaultLimits`. */
  limits?: Partial<Limits> | undefined;
  /** How new entities get their ids (write mode). Defaults to `{ kind: 'database' }`. */
  idStrategy?: IdStrategy | undefined;
}

export interface QueryOptions {
  /** Lowers the graph's limits for this query. Cannot raise them. */
  limits?: Partial<Limits> | undefined;
}

export interface Graph {
  readonly readOnly: boolean;
  query(
    cypher: string,
    params?: Record<string, CypherValue>,
    options?: QueryOptions,
  ): Promise<Record<string, CypherValue>[]>;
  compile(cypher: string, options?: QueryOptions): CompiledPlan;
}

export function createGraph(options: GraphOptions): Graph {
  const readOnly = options.readOnly ?? true;
  const mapping = validateMapping(options.mapping ?? defaultMapping);
  const limits: Limits = { ...defaultLimits, ...options.limits };
  const idStrategy = options.idStrategy ?? { kind: 'database' };
  // A read-only graph has no write planner at all (see WritePlanner).
  const writer = readOnly ? undefined : new WritePlanner(options.dialect, mapping, idStrategy);

  const compile = (cypher: string, queryOptions?: QueryOptions): CompiledPlan => {
    const effective = lowerLimits(limits, queryOptions?.limits);
    const query = parse(cypher);
    if (readOnly) {
      assertQueryReadOnly(query);
    }
    assertSupported(query);
    return planQuery(query, options.dialect, mapping, writer, effective);
  };

  return {
    readOnly,
    compile,
    async query(cypher, params = {}, queryOptions): Promise<Record<string, CypherValue>[]> {
      const plan = compile(cypher, queryOptions);
      return executePlan(plan, {
        executor: options.executor,
        params,
        limits: lowerLimits(limits, queryOptions?.limits),
        idGenerator: idStrategy.kind === 'generator' ? idStrategy.generate : undefined,
      });
    },
  };
}

/** Parses a query and rejects it if it contains any write clause. */
export function assertReadOnly(cypher: string): void {
  assertQueryReadOnly(parse(cypher));
}

function planQuery(
  query: ast.Query,
  dialect: Dialect,
  mapping: GraphMapping,
  writer: WritePlanner | undefined,
  limits: Limits,
): CompiledPlan {
  const clauses = query.clauses;

  if (hasWriteClause(query)) {
    if (!writer) {
      // Unreachable while the gate works; kept so that a gate bug cannot reach SQL.
      throw new ReadOnlyViolationError('Write clauses are not allowed on a read-only graph');
    }
    // Reading clauses, then CREATE clauses, then optionally reading clauses over
    // the written rows and RETURN.
    const firstCreate = clauses.findIndex((c) => c.type === 'Create');
    const reading = clauses.slice(0, firstCreate);
    const afterCreate = clauses.findIndex((c, i) => i > firstCreate && c.type !== 'Create');
    const creates = clauses.slice(firstCreate, afterCreate < 0 ? undefined : afterCreate);
    const tail = afterCreate < 0 ? [] : clauses.slice(afterCreate);
    const last = tail.at(-1);
    const ret = last?.type === 'Return' ? last : undefined;
    const tailReading = tail.slice(0, -1);
    const misplaced =
      reading.find((c) => !isRowClause(c)) ??
      (tail.length > 0 && !ret ? tail[0] : undefined) ??
      tailReading.find((c) => !isRowClause(c));
    if (misplaced) {
      throw new UnsupportedFeatureError(
        'A write query can be MATCH, UNWIND, and WITH, then CREATE, then MATCH, UNWIND, and WITH with RETURN for now (not CREATE again after them)',
        { position: misplaced.position },
      );
    }
    const builder = new SqlBuilder(dialect, mapping);
    let source =
      reading.length > 0
        ? new RowSource(ReadScope.of(builder, reading as ast.RowClause[]))
        : undefined;
    const createSource: CreateSource = {
      get current() {
        return source;
      },
      need: () => (source ??= new RowSource(new ReadScope(builder))),
    };
    if (ret) {
      // RETURN collects the written rows from the per-row steps.
      createSource.need();
    }
    const { steps: inserts, created } = writer.planCreate(
      creates as ast.CreateClause[],
      limits,
      createSource,
    );
    const returned = ret
      ? planReturnAfterCreate(
          tailReading as ast.RowClause[],
          ret,
          source!,
          created,
          dialect,
          mapping,
        )
      : undefined;
    const steps = [
      ...builder.searchSteps,
      ...(source ? [source.finish()] : []),
      ...inserts,
      ...(returned ? [returned.step] : []),
    ];
    return checkSteps(createPlan(steps, returned?.columns ?? []), limits);
  }

  const ret = clauses.at(-1);
  if (ret?.type !== 'Return') {
    throw new UnsupportedFeatureError('A read query must end with RETURN', {
      position: query.position,
    });
  }
  const reading = clauses.slice(0, -1);
  for (const clause of reading) {
    if (!isRowClause(clause)) {
      throw new UnsupportedFeatureError(`${clause.type} is not supported before RETURN yet`, {
        position: clause.position,
      });
    }
  }
  const builder = new SqlBuilder(dialect, mapping);
  const { step, columns } = planRead(builder, reading as ast.RowClause[], ret);
  return checkSteps(createPlan([...builder.searchSteps, step], columns), limits);
}

/**
 * The end of `... CREATE ... [MATCH | UNWIND | WITH]* RETURN`: a step after the
 * writes over the written rows, each holding the source row's variables (ids of
 * matched entities, other values as JSON) and the ids of the entities created
 * for it. Must run before `source.finish()`, since it adds source columns.
 */
function planReturnAfterCreate(
  reading: ast.RowClause[],
  ret: ast.ReturnClause,
  source: RowSource,
  created: Map<string, CreatedEntity>,
  dialect: Dialect,
  mapping: GraphMapping,
): { step: PlanStep; columns: ColumnSpec[] } {
  const scope = source.scope;
  const written: { name: string; value: WrittenValue }[] = [];
  const variables: WrittenVariable[] = [];
  for (const name of scope.variables) {
    const binding = scope.lookup({ name, position: ret.position });
    if (binding.kind === 'node' || binding.kind === 'relationship') {
      const table = binding.kind === 'node' ? mapping.nodes : mapping.edges;
      const column = source.column(`${binding.alias}.${scope.b.ident(table.id)}`);
      written.push({ name, value: { kind: 'rowId', column } });
      variables.push({ name, kind: binding.kind });
    } else {
      const value = source.valueColumn({ type: 'Variable', position: ret.position, name });
      if (value.kind !== 'row') {
        throw new Error('Internal error: a variable is not a row column');
      }
      written.push({ name, value: { kind: 'rowJson', column: value.column } });
      variables.push({ name, kind: 'value' });
    }
  }
  for (const [name, entity] of created) {
    written.push({ name, value: { kind: 'entity', entity: entity.entity } });
    variables.push({ name, kind: entity.kind });
  }
  const b = new SqlBuilder(dialect, mapping);
  const { step, columns } = planWrittenReturn(b, variables, reading, ret);
  if (b.searchSteps.length > 0) {
    throw new UnsupportedFeatureError('shortestPath() after CREATE is not supported yet', {
      position: ret.position,
    });
  }
  return { step: { ...step, written }, columns };
}

function isRowClause(clause: ast.Clause): clause is ast.RowClause {
  return clause.type === 'Match' || clause.type === 'Unwind' || clause.type === 'With';
}

/**
 * Applies `maxSteps` to read plans. CREATE plans use one INSERT per entity with
 * database ids, so they are bounded by `maxCreatedEntities` instead.
 */
function checkSteps(plan: CompiledPlan, limits: Limits): CompiledPlan {
  if (plan.steps.length > limits.maxSteps && plan.readOnly) {
    throw new LimitExceededError(
      `The plan needs ${plan.steps.length} SQL steps, more than maxSteps (${limits.maxSteps})`,
    );
  }
  return plan;
}
