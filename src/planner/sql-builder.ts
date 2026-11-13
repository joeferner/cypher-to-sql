import type { Dialect, EntityColumns, ScalarType } from '../dialect/dialect.js';
import type * as ast from '../ast.js';
import type { SourcePosition } from '../errors.js';
import type { BindValue, PlanStep, RaisedError, ValueSource } from '../plan.js';
import type { GraphMapping } from '../mapping.js';
import type { CypherMap, CypherValue } from '../values.js';

// Bind markers. SQL is assembled from fragments in any order; `finish` replaces
// the markers with the dialect's placeholders in textual order, so the bind values
// always line up with `?` (SQLite) or `$n` (PostgreSQL). No query text ever enters
// the SQL, so these control characters cannot occur in it otherwise.
const MARK = '\u0001';
const MARKER = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');

export class SqlBuilder {
  private readonly binds: BindValue[] = [];
  /**
   * Steps that must run before the main statement: the node-pair steps of
   * shortest path searches, in the order the statement needs their results.
   */
  public readonly searchSteps: PlanStep[] = [];
  private subqueries = 0;
  private readonly errors: RaisedError[] = [];

  /**
   * An expression of `type` that raises `error` when it is evaluated (a Cypher
   * error found at run time). The plan runner turns the database's error back
   * into it.
   */
  public raise(error: RaisedError, type: ScalarType | 'json'): string {
    this.errors.push(error);
    return this.dialect.raise(`!cypher:${this.errors.length - 1}`, type);
  }

  /** `raise` for a value of the wrong type (TypeError, InvalidArgumentType). */
  public typeError(
    message: string,
    position: SourcePosition | undefined,
    type: ScalarType | 'json',
    code = 'InvalidArgumentType',
  ): string {
    return this.raise({ kind: 'type', code, message, position }, type);
  }

  /** A number for a new subquery scope, unique in the statement (for its alias prefix). */
  public nextSubquery(): number {
    return this.subqueries++;
  }

  public constructor(
    public readonly dialect: Dialect,
    public readonly mapping: GraphMapping,
  ) {}

  /** Returns a marker for a bind value. Use the returned text in the SQL. */
  public bind(value: BindValue): string {
    this.binds.push(value);
    return `${MARK}${this.binds.length - 1}${MARK}`;
  }

  public ident(name: string): string {
    return this.dialect.quoteIdent(name);
  }

  public table(kind: 'nodes' | 'edges'): string {
    const table = this.ident(this.mapping[kind].table);
    return this.mapping.schema ? `${this.ident(this.mapping.schema)}.${table}` : table;
  }

  /** The node or edge table and its columns, quoted. */
  public columns(kind: 'nodes' | 'edges'): EntityColumns {
    const m = this.mapping;
    const table = this.table(kind);
    if (kind === 'nodes') {
      return {
        table,
        id: this.ident(m.nodes.id),
        labels: this.ident(m.nodes.labels),
        properties: this.ident(m.nodes.properties),
      };
    }
    return {
      table,
      id: this.ident(m.edges.id),
      type: this.ident(m.edges.type),
      startId: this.ident(m.edges.startId),
      endId: this.ident(m.edges.endId),
      properties: this.ident(m.edges.properties),
    };
  }

  /** The tagged JSON object of the entity in table alias `alias`; JSON null when the alias's row is null. */
  public entityJson(kind: 'node' | 'relationship', alias: string): string {
    const columns = this.columns(kind === 'node' ? 'nodes' : 'edges');
    return (
      `(CASE WHEN ${alias}.${columns.id} IS NULL THEN ${this.dialect.jsonInput('NULL')} ` +
      `ELSE ${this.dialect.entityJson(kind, alias, columns)} END)`
    );
  }

  /**
   * Replaces the markers with placeholders. With numbered placeholders, a marker
   * that occurs more than once gets one placeholder, so equal expressions have
   * equal SQL text (PostgreSQL requires that between SELECT and GROUP BY).
   */
  public finish(sql: string, extra: Omit<PlanStep, 'sql' | 'values'> = {}): PlanStep {
    const values: BindValue[] = [];
    const numbers = new Map<string, number>();
    const text = sql.replace(MARKER, (_m, index: string): string => {
      if (this.dialect.numberedPlaceholders) {
        const known = numbers.get(index);
        if (known !== undefined) {
          return this.dialect.placeholder(known);
        }
        numbers.set(index, values.length + 1);
      }
      values.push(this.binds[Number(index)]!);
      return this.dialect.placeholder(values.length);
    });
    return {
      sql: text,
      values,
      ...(this.errors.length > 0 ? { errors: [...this.errors] } : {}),
      ...extra,
    };
  }
}

/**
 * The value of an expression that needs no database access (literals, lists and
 * maps of those, and parameters), or `undefined` for anything else.
 */
export function constantValue(expr: ast.Expression): ValueSource | undefined {
  if (expr.type === 'Parameter') {
    return { kind: 'parameter', name: expr.name, position: expr.position };
  }
  const value = literalValue(expr);
  return value === undefined ? undefined : { kind: 'constant', value };
}

function literalValue(expr: ast.Expression): CypherValue | undefined {
  switch (expr.type) {
    case 'Literal':
      return expr.value;
    case 'List': {
      const items: CypherValue[] = [];
      for (const item of expr.items) {
        const value = literalValue(item);
        if (value === undefined) {
          return undefined;
        }
        items.push(value);
      }
      return items;
    }
    case 'Map': {
      const map: CypherMap = {};
      for (const entry of expr.entries) {
        const value = literalValue(entry.value);
        if (value === undefined) {
          return undefined;
        }
        map[entry.key] = value;
      }
      return map;
    }
    default:
      return undefined;
  }
}
