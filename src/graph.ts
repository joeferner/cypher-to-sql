import type * as ast from './ast.js';
import type { Dialect } from './dialect/dialect.js';
import { LimitExceededError, ReadOnlyViolationError, UnsupportedFeatureError } from './errors.js';
import type { SqlExecutor } from './executor.js';
import { defaultLimits, lowerLimits, type Limits } from './limits.js';
import { defaultMapping, validateMapping, type GraphMapping } from './mapping.js';
import { parse } from './parser/parse.js';
import { createPlan, executePlan, type CompiledPlan } from './plan.js';
import { assertQueryReadOnly, assertSupported, hasWriteClause } from './planner/gate.js';
import { planRead, ReadScope, RowSource } from './planner/read.js';
import { SqlBuilder } from './planner/sql-builder.js';
import { WritePlanner, type IdStrategy } from './planner/write.js';
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
    // Reading clauses (and WITH) first, then CREATE clauses only.
    const firstCreate = clauses.findIndex((c) => c.type === 'Create');
    const reading = clauses.slice(0, firstCreate);
    const creates = clauses.slice(firstCreate);
    const misplaced =
      reading.find((c) => !isRowClause(c)) ?? creates.find((c) => c.type !== 'Create');
    if (misplaced) {
      throw new UnsupportedFeatureError(
        'Only MATCH, UNWIND, and WITH followed by CREATE can write for now (no RETURN or other clauses after CREATE)',
        { position: misplaced.position },
      );
    }
    if (reading.length === 0) {
      return checkSteps(
        createPlan(writer.planCreate(creates as ast.CreateClause[], limits), []),
        limits,
      );
    }
    const source = new RowSource(
      ReadScope.of(new SqlBuilder(dialect, mapping), reading as ast.RowClause[]),
    );
    const inserts = writer.planCreate(creates as ast.CreateClause[], limits, source);
    return checkSteps(createPlan([source.finish(), ...inserts], []), limits);
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
  const { step, columns } = planRead(
    new SqlBuilder(dialect, mapping),
    reading as ast.RowClause[],
    ret,
  );
  return checkSteps(createPlan([step], columns), limits);
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
