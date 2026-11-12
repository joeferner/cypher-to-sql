import type { SourcePosition } from './errors.js';
import type { Row, SqlExecutor } from './executor.js';
import type { Limits } from './limits.js';
import { LimitExceededError, SemanticError } from './errors.js';
import { parseCypherJson, stringifyCypherJson } from './json.js';
import { CypherNode, isCypherMap, type CypherMap, type CypherValue } from './values.js';

/**
 * A value bound to a SQL placeholder. Most are known when the query is compiled;
 * the rest are resolved just before a step runs (query parameters, ids created by
 * earlier steps, and limits that can be lowered per query).
 */
export type BindValue =
  /** A plain SQL value (string or number), for example a label or a property key. */
  | { kind: 'sql'; value: string | number | bigint }
  /** A Cypher value or query parameter, bound as JSON text. */
  | { kind: 'json'; value: ValueSource }
  /** A property map for a new entity, bound as JSON text with null members removed. */
  | { kind: 'properties'; entries: { key: string; value: ValueSource }[] }
  | { kind: 'propertiesParameter'; name: string; position: SourcePosition }
  /** The id of an entity created earlier in the same plan (in the same source row). */
  | { kind: 'entityId'; entity: number }
  /** A column of the current source row, bound as is (for example the id of a matched node). */
  | { kind: 'rowId'; column: string }
  /** The SQL `LIMIT` of a step: `min(user limit, maxRowsPerStep + 1)`. */
  | { kind: 'rowLimit'; userLimit: ValueSource | undefined };

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
  /** When set, the step supplies a generated id for entity `entity` in this bind slot. */
  generatedId?: { entity: number; kind: 'node' | 'relationship' } | undefined;
  /**
   * Per-row steps run once for each row of the step before the first of them (the
   * source step), with `row` values bound from that row. Entity numbers restart for
   * each row. Steps after them do not exist yet.
   */
  perRow?: boolean | undefined;
}

/** How to build one result column from the SQL columns of the final step. */
export type ColumnSpec =
  | { name: string; kind: 'node'; id: string; labels: string; properties: string }
  | { name: string; kind: 'json'; column: string };

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
  const readOnly = steps.every((s) => s.creates === undefined);
  return {
    readOnly,
    steps,
    columns,
    explain: () =>
      steps
        .map(
          (s, i) =>
            `-- step ${i + 1}${s.perRow ? ' (for each source row)' : ''}\n${s.sql}\n-- values: ${s.values.map(describeBind).join(', ')}`,
        )
        .join('\n'),
  };
}

export async function executePlan(
  plan: CompiledPlan,
  options: ExecuteOptions,
): Promise<Record<string, CypherValue>[]> {
  const { executor, limits } = options;
  const deadline = Date.now() + limits.timeoutMs;
  const entityIds = new Map<number, unknown>();

  const firstPerRow = plan.steps.findIndex((s) => s.perRow);
  const once = firstPerRow < 0 ? plan.steps : plan.steps.slice(0, firstPerRow);
  const perRow = firstPerRow < 0 ? [] : plan.steps.slice(firstPerRow);

  const rows = await executor.transaction(plan.readOnly ? 'read' : 'write', async (tx) => {
    const run = async (step: PlanStep, row: Row | undefined): Promise<Row[]> => {
      if (Date.now() > deadline) {
        throw new LimitExceededError(`Query exceeded the time limit of ${limits.timeoutMs} ms`);
      }
      if (step.generatedId && options.idGenerator) {
        entityIds.set(step.generatedId.entity, options.idGenerator(step.generatedId.kind));
      }
      const values = step.values.map((v) => resolveBind(v, options, entityIds, row));
      const result = await tx.query(step.sql, values);
      if (result.length > limits.maxRowsPerStep) {
        throw new LimitExceededError(
          `A SQL step returned more than ${limits.maxRowsPerStep} rows (maxRowsPerStep)`,
          { hint: 'Add LIMIT to the query or make the pattern more selective.' },
        );
      }
      if (step.creates && !step.generatedId) {
        entityIds.set(step.creates.entity, result[0]?.['id']);
      }
      return result;
    };

    let last: Row[] = [];
    for (const step of once) {
      last = await run(step, undefined);
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
        for (const step of perRow) {
          await run(step, row);
        }
      }
      last = [];
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

function resolveBind(
  bind: BindValue,
  options: ExecuteOptions,
  entityIds: Map<number, unknown>,
  row: Row | undefined,
): unknown {
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
          checkPropertyValue(key, resolved);
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
          checkPropertyValue(key, v);
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
  }
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

/** Property values are scalars or lists of scalars (Cypher has no map-valued properties). */
function checkPropertyValue(key: string, value: CypherValue): void {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (item !== null && typeof item === 'object') {
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
    } else {
      record[column.name] = parseJsonColumn(row[column.column]);
    }
  }
  return record;
}

/** Ids are whatever the driver returns for the id column: a string, number, or bigint. */
function idToString(id: unknown): string {
  if (typeof id === 'string' || typeof id === 'number' || typeof id === 'bigint') {
    return String(id);
  }
  throw new Error(`Internal error: unexpected id value of type ${typeof id} from the database`);
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
