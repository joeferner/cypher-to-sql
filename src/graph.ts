import type * as ast from './ast.js';
import type { Dialect } from './dialect/dialect.js';
import { LimitExceededError, ReadOnlyViolationError, UnsupportedFeatureError } from './errors.js';
import type { SqlExecutor } from './executor.js';
import { defaultLimits, lowerLimits, type Limits } from './limits.js';
import { defaultMapping, validateMapping, type GraphMapping } from './mapping.js';
import { parse } from './parser/parse.js';
import { createPlan, executePlan, type CompiledPlan } from './plan.js';
import { assertQueryReadOnly, assertSupported, hasWriteClause } from './planner/gate.js';
import { planRead } from './planner/read.js';
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
    const creates = clauses.filter((c): c is ast.CreateClause => c.type === 'Create');
    if (creates.length !== clauses.length) {
      throw new UnsupportedFeatureError(
        'Only queries made of CREATE clauses can write for now (no MATCH, RETURN, or other clauses with CREATE)',
        { position: clauses.find((c) => c.type !== 'Create')?.position },
      );
    }
    return checkSteps(createPlan(writer.planCreate(creates, limits), []), limits);
  }

  const ret = clauses.at(-1);
  if (ret?.type !== 'Return') {
    throw new UnsupportedFeatureError('A read query must end with RETURN', {
      position: query.position,
    });
  }
  const matches = clauses.slice(0, -1);
  for (const clause of matches) {
    if (clause.type !== 'Match') {
      throw new UnsupportedFeatureError(`${clause.type} is not supported before RETURN yet`, {
        position: clause.position,
      });
    }
  }
  const { step, columns } = planRead(
    new SqlBuilder(dialect, mapping),
    matches as ast.MatchClause[],
    ret,
  );
  return checkSteps(createPlan([step], columns), limits);
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
