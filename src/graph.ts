import type * as ast from './ast.js';
import type { Dialect } from './dialect/dialect.js';
import {
  LimitExceededError,
  ReadOnlyViolationError,
  SemanticError,
  UnsupportedFeatureError,
} from './errors.js';
import { findProcedure, type Procedures } from './procedures.js';
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
} from './plan.js';
import { assertQueryReadOnly, assertSupported, hasWriteClause } from './planner/gate.js';
import { planRead, planWrittenReturn, ReadScope, RowSource } from './planner/read.js';
import { SqlBuilder } from './planner/sql-builder.js';
import {
  rowVariables,
  WritePlanner,
  type CreatedEntity,
  type CreateSource,
  type IdStrategy,
  type UpdateClause,
} from './planner/write.js';
import type { CypherValue } from './values.js';

export interface GraphOptions {
  dialect: Dialect;
  executor: SqlExecutor;
  /** Defaults to `defaultMapping` (tables `nodes` and `edges`). */
  mapping?: GraphMapping | undefined;
  /** Defaults to true. With false, CREATE, MERGE, SET, REMOVE, DELETE, and FOREACH are allowed. */
  readOnly?: boolean | undefined;
  /** Graph-wide limits. Unset entries use `defaultLimits`. */
  limits?: Partial<Limits> | undefined;
  /** How new entities get their ids (write mode). Defaults to `{ kind: 'database' }`. */
  idStrategy?: IdStrategy | undefined;
  /** Procedures for `CALL name(args) YIELD ...`, by name. There are no built-in ones. */
  procedures?: Procedures | undefined;
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
  const procedures = options.procedures ?? {};
  // A read-only graph has no write planner at all (see WritePlanner).
  const writer = readOnly ? undefined : new WritePlanner(options.dialect, mapping, idStrategy);

  const compile = (cypher: string, queryOptions?: QueryOptions): CompiledPlan => {
    const effective = lowerLimits(limits, queryOptions?.limits);
    const parsed = parse(cypher);
    if (readOnly) {
      assertQueryReadOnly(parsed);
    }
    const query = resolveCalls(parsed, procedures);
    assertSupported(query);
    const plan = planQuery(query, options.dialect, mapping, writer, effective);
    const first = query.clauses[0];
    // A standalone call of a void procedure has no columns.
    return first?.type === 'Call' && first.standalone && first.definition!.outputs.length === 0
      ? createPlan([...plan.steps], [])
      : plan;
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
    // Query parts of reading clauses (MATCH, UNWIND, CALL, WITH) then write
    // clauses, then optionally reading clauses and RETURN. Each part after the
    // first reads the rows the part before it wrote.
    const parts: { reading: ast.RowClause[]; updates: UpdateClause[] }[] = [];
    let i = 0;
    for (;;) {
      const start = i;
      while (i < clauses.length && isRowClause(clauses[i]!)) {
        i++;
      }
      const updatesStart = i;
      while (i < clauses.length && isUpdateClause(clauses[i]!)) {
        i++;
      }
      if (i === updatesStart) {
        i = start;
        break;
      }
      parts.push({
        reading: clauses.slice(start, updatesStart) as ast.RowClause[],
        updates: clauses.slice(updatesStart, i) as UpdateClause[],
      });
    }
    const tail = clauses.slice(i);
    const last = tail.at(-1);
    const ret = last?.type === 'Return' ? last : undefined;
    const tailReading = tail.slice(0, -1);
    const misplaced =
      (tail.length > 0 && !ret ? tail[0] : undefined) ?? tailReading.find((c) => !isRowClause(c));
    if (misplaced) {
      throw new UnsupportedFeatureError(
        `${misplaced.type === 'UnsupportedClause' ? misplaced.name : misplaced.type.toUpperCase()} cannot be used here: a write query ends with its write clauses or with RETURN`,
        { position: misplaced.position },
      );
    }

    // Plans each part; a part's source is finished last, after the next part
    // (or RETURN) added the columns it reads from it.
    interface Planned {
      builder: SqlBuilder;
      source: RowSource | undefined;
      /** For a part after the first: the variables of the rows it starts from. */
      written: PlanStep['written'];
      inserts: PlanStep[];
      created: Map<string, CreatedEntity>;
    }
    const planned: Planned[] = [];
    for (const [index, part] of parts.entries()) {
      const builder = new SqlBuilder(dialect, mapping);
      const previous = planned.at(-1);
      let source: RowSource | undefined;
      let written: PlanStep['written'];
      if (previous) {
        const before = rowVariables(previous.source!, previous.created, mapping, query.position);
        written = before.written;
        source = new RowSource(
          ReadScope.of(builder, part.reading, ReadScope.written(builder, before.variables)),
        );
      } else if (part.reading.length > 0) {
        source = new RowSource(ReadScope.of(builder, part.reading));
      }
      const createSource: CreateSource = {
        get current() {
          return source;
        },
        need: () => (source ??= new RowSource(new ReadScope(builder))),
      };
      if (ret || index < parts.length - 1) {
        // The next part, or RETURN, reads the rows the per-row steps wrote.
        createSource.need();
      }
      const { steps: inserts, created } = writer.planUpdates(part.updates, limits, createSource);
      planned.push({ builder, source, written, inserts, created });
    }
    const lastPart = planned.at(-1)!;
    const returned = ret
      ? planReturnAfterCreate(
          tailReading as ast.RowClause[],
          ret,
          lastPart.source!,
          lastPart.created,
          dialect,
          mapping,
        )
      : undefined;
    const steps = planned.flatMap(({ builder, source, written, inserts }, segment) =>
      [
        ...builder.searchSteps,
        ...(source ? [{ ...source.finish(), written }] : []),
        ...inserts,
      ].map((step) => ({ ...step, segment })),
    );
    if (returned) {
      steps.push({ ...returned.step, segment: planned.length });
    }
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
  const { written, variables } = rowVariables(source, created, mapping, ret.position);
  const b = new SqlBuilder(dialect, mapping);
  const { step, columns } = planWrittenReturn(b, variables, reading, ret);
  if (b.searchSteps.length > 0) {
    throw new UnsupportedFeatureError('shortestPath() after CREATE is not supported yet', {
      position: ret.position,
    });
  }
  return { step: { ...step, written }, columns };
}

function isUpdateClause(clause: ast.Clause): boolean {
  return (
    clause.type === 'Create' ||
    clause.type === 'Set' ||
    clause.type === 'Remove' ||
    clause.type === 'Delete' ||
    clause.type === 'Merge' ||
    clause.type === 'Foreach'
  );
}

function isRowClause(clause: ast.Clause): clause is ast.RowClause {
  return (
    clause.type === 'Match' ||
    clause.type === 'Unwind' ||
    clause.type === 'Call' ||
    clause.type === 'With'
  );
}

/**
 * Gives each CALL its registered procedure and its arguments (an implicit call
 * takes parameters of the inputs' names). A standalone CALL becomes CALL plus
 * a RETURN of what it yields (every output, without YIELD or with `YIELD *`).
 */
function resolveCalls(query: ast.Query, procedures: Procedures): ast.Query {
  const clauses = query.clauses.flatMap((clause): ast.Clause[] => {
    if (clause.type !== 'Call') {
      return [clause];
    }
    const definition = findProcedure(procedures, clause.procedure, clause.position);
    const args =
      clause.args ??
      definition.inputs.map((input): ast.Expression => ({
        type: 'Parameter',
        position: clause.position,
        name: input.name,
      }));
    if (args.length !== definition.inputs.length) {
      throw new SemanticError(
        `${clause.procedure}() takes ${definition.inputs.length} argument(s), got ${args.length}`,
        { position: clause.position },
      );
    }
    if (!clause.standalone) {
      return [{ ...clause, args, definition }];
    }
    const position = clause.position;
    const yields =
      clause.yields ??
      definition.outputs.map((o) => ({ output: o.name, variable: o.name, position }));
    const items: ast.ProjectionItem[] = yields.map((y) => ({
      position: y.position,
      expression: { type: 'Variable', position: y.position, name: y.variable },
      alias: y.variable,
      name: y.variable,
    }));
    const ret: ast.ReturnClause = {
      type: 'Return',
      position,
      distinct: false,
      star: false,
      // A void procedure returns no rows and no columns (see planQuery).
      items:
        items.length > 0
          ? items
          : [
              {
                position,
                expression: { type: 'Literal', position, value: null },
                alias: 'void',
                name: 'void',
              },
            ],
      orderBy: [],
      skip: undefined,
      limit: items.length > 0 ? undefined : { type: 'Literal', position, value: 0n },
    };
    return [{ ...clause, args, yields, definition }, ret];
  });
  return { ...query, clauses };
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
