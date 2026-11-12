import type * as ast from '../ast.js';
import { SemanticError, UnsupportedFeatureError } from '../errors.js';
import type { ColumnSpec, PlanStep, ValueSource } from '../plan.js';
import { constantValue, type SqlBuilder } from './sql-builder.js';

/** What a variable refers to in SQL. */
export type Binding =
  /** A node: an alias of the node table. */
  | { kind: 'node'; alias: string }
  /** Any other value: a SQL expression of the dialect's JSON type. */
  | { kind: 'value'; sql: string };

/**
 * The rows produced by the reading clauses of a query (MATCH and UNWIND), as the
 * FROM and WHERE parts of one SELECT, plus the variables they bind.
 */
export class ReadScope {
  private readonly bindings = new Map<string, Binding>();
  private readonly from: string[] = [];
  private readonly where: string[] = [];
  /** Expressions that order rows the way Cypher produces them (one per FROM item). */
  private readonly order: string[] = [];
  private hasUnwind = false;

  public constructor(public readonly b: SqlBuilder) {}

  public static of(b: SqlBuilder, clauses: ast.ReadingClause[]): ReadScope {
    const scope = new ReadScope(b);
    for (const clause of clauses) {
      if (clause.type === 'Match') {
        scope.addMatch(clause);
      } else {
        scope.addUnwind(clause);
      }
    }
    return scope;
  }

  public get variables(): string[] {
    return [...this.bindings.keys()];
  }

  public lookup(variable: { name: string; position: ast.Variable['position'] }): Binding {
    const binding = this.bindings.get(variable.name);
    if (!binding) {
      throw new SemanticError(`Variable \`${variable.name}\` not defined`, {
        position: variable.position,
      });
    }
    return binding;
  }

  public has(name: string): boolean {
    return this.bindings.has(name);
  }

  private addMatch(match: ast.MatchClause): void {
    const b = this.b;
    if (match.optional) {
      throw new UnsupportedFeatureError('OPTIONAL MATCH is not supported yet', {
        position: match.position,
      });
    }
    if (match.where) {
      throw new UnsupportedFeatureError('WHERE is not supported yet', {
        position: match.where.position,
      });
    }
    for (const part of match.pattern) {
      if (part.variable !== undefined) {
        throw new UnsupportedFeatureError('Named paths are not supported yet', {
          position: part.position,
        });
      }
      if (part.elements.length > 1) {
        throw new UnsupportedFeatureError('Relationship patterns in MATCH are not supported yet', {
          position: part.elements[1]!.position,
        });
      }
      const node = part.elements[0] as ast.NodePattern;
      if (node.properties) {
        throw new UnsupportedFeatureError('Property maps in MATCH patterns are not supported yet', {
          position: node.properties.position,
        });
      }
      let alias: string;
      const existing = node.variable !== undefined ? this.bindings.get(node.variable) : undefined;
      if (existing) {
        if (existing.kind !== 'node') {
          throw new SemanticError(`Variable \`${node.variable}\` is not a node`, {
            position: node.position,
          });
        }
        alias = existing.alias;
      } else {
        alias = `n${this.from.length}`;
        this.from.push(`${b.table('nodes')} AS ${alias}`);
        this.order.push(`${alias}.${b.ident(b.mapping.nodes.id)}`);
        if (node.variable !== undefined) {
          this.bindings.set(node.variable, { kind: 'node', alias });
        }
      }
      for (const label of node.labels) {
        this.where.push(
          b.dialect.hasLabel(
            `${alias}.${b.ident(b.mapping.nodes.labels)}`,
            b.bind({ kind: 'sql', value: label }),
          ),
        );
      }
    }
  }

  private addUnwind(unwind: ast.UnwindClause): void {
    if (this.bindings.has(unwind.variable)) {
      throw new SemanticError(`Variable \`${unwind.variable}\` already declared`, {
        position: unwind.position,
      });
    }
    const list = this.value(unwind.expression);
    const alias = `u${this.from.length}`;
    const u = this.b.dialect.unwind(list, alias);
    this.from.push(u.from);
    if (u.where) {
      this.where.push(u.where);
    }
    this.order.push(u.order);
    this.hasUnwind = true;
    this.bindings.set(unwind.variable, { kind: 'value', sql: u.value });
  }

  /** SQL of the dialect's JSON type for a non-entity expression. */
  public value(expr: ast.Expression): string {
    const b = this.b;
    const constant = constantValue(expr);
    if (constant) {
      return b.dialect.jsonInput(b.bind({ kind: 'json', value: constant }));
    }
    if (expr.type === 'Variable') {
      const binding = this.lookup(expr);
      if (binding.kind === 'node') {
        throw new UnsupportedFeatureError(
          `Node \`${expr.name}\` cannot be used as a value here yet`,
          { position: expr.position },
        );
      }
      return binding.sql;
    }
    if (expr.type === 'PropertyAccess') {
      let object: string;
      if (expr.subject.type === 'Variable') {
        const binding = this.lookup(expr.subject);
        object =
          binding.kind === 'node'
            ? `${binding.alias}.${b.ident(b.mapping.nodes.properties)}`
            : binding.sql;
      } else {
        object = this.value(expr.subject);
      }
      return b.dialect.jsonMember(object, b.bind({ kind: 'sql', value: expr.key }), expr.key);
    }
    throw new UnsupportedFeatureError('This expression is not supported here yet', {
      position: expr.position,
    });
  }

  /** The SELECT over this scope. The row limit is always applied. */
  public select(columns: string[], userLimit?: ValueSource): string {
    const b = this.b;
    let sql = `SELECT ${columns.join(', ')}`;
    if (this.from.length > 0) {
      sql += ` FROM ${this.from.join(' CROSS JOIN ')}`;
    }
    if (this.where.length > 0) {
      sql += ` WHERE ${this.where.join(' AND ')}`;
    }
    // UNWIND defines the order of its rows; keep it (nested-loop order across FROM items).
    if (this.hasUnwind) {
      sql += ` ORDER BY ${this.order.join(', ')}`;
    }
    sql += ` LIMIT ${b.bind({ kind: 'rowLimit', userLimit })}`;
    return sql;
  }
}

/**
 * The source step of a write query with reading clauses: a SELECT of the values
 * the CREATE clauses use, one row per incoming Cypher row.
 */
export class RowSource {
  private readonly columns: string[] = [];

  public constructor(public readonly scope: ReadScope) {}

  /** Adds `sql` to the SELECT and returns its column name. */
  public column(sql: string): string {
    const name = `r${this.columns.length}`;
    this.columns.push(`${sql} AS ${name}`);
    return name;
  }

  /** A row column holding the JSON text of `expr`. */
  public valueColumn(expr: ast.Expression): ValueSource {
    const sql = this.scope.b.dialect.jsonText(this.scope.value(expr));
    return { kind: 'row', column: this.column(sql) };
  }

  public finish(): PlanStep {
    const columns = this.columns.length > 0 ? this.columns : ['1 AS r0'];
    return this.scope.b.finish(this.scope.select(columns));
  }
}

/**
 * Plans `MATCH ... / UNWIND ... RETURN ...` as a single SELECT.
 *
 * Supported so far: node patterns with labels (several patterns form a Cartesian
 * product), UNWIND, and RETURN of node variables, properties, unwound values, and
 * constants, with LIMIT.
 */
export function planRead(
  b: SqlBuilder,
  clauses: ast.ReadingClause[],
  ret: ast.ReturnClause,
): { step: PlanStep; columns: ColumnSpec[] } {
  const scope = ReadScope.of(b, clauses);
  const nodes = b.mapping.nodes;

  if (ret.distinct || ret.orderBy.length > 0 || ret.skip) {
    const what = ret.distinct ? 'DISTINCT' : ret.orderBy.length > 0 ? 'ORDER BY' : 'SKIP';
    throw new UnsupportedFeatureError(`${what} is not supported yet`, { position: ret.position });
  }

  const items: ast.ProjectionItem[] = [...ret.items];
  if (ret.star) {
    if (scope.variables.length === 0) {
      throw new SemanticError('RETURN * is not allowed when there are no variables in scope', {
        position: ret.position,
      });
    }
    const starItems = scope.variables.sort().map((name): ast.ProjectionItem => ({
      position: ret.position,
      expression: { type: 'Variable', position: ret.position, name },
      alias: undefined,
      name,
    }));
    items.unshift(...starItems);
  }

  const select: string[] = [];
  const columns: ColumnSpec[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.name)) {
      throw new SemanticError(`Multiple result columns with the same name: ${item.name}`, {
        position: item.position,
      });
    }
    seen.add(item.name);

    const c = `c${columns.length}`;
    const expr = item.expression;
    const binding = expr.type === 'Variable' ? scope.lookup(expr) : undefined;
    if (binding?.kind === 'node') {
      select.push(
        `${binding.alias}.${b.ident(nodes.id)} AS ${c}_id`,
        `${b.dialect.jsonText(`${binding.alias}.${b.ident(nodes.labels)}`)} AS ${c}_labels`,
        `${b.dialect.jsonText(`${binding.alias}.${b.ident(nodes.properties)}`)} AS ${c}_props`,
      );
      columns.push({
        name: item.name,
        kind: 'node',
        id: `${c}_id`,
        labels: `${c}_labels`,
        properties: `${c}_props`,
      });
      continue;
    }
    select.push(`${b.dialect.jsonText(scope.value(expr))} AS ${c}`);
    columns.push({ name: item.name, kind: 'json', column: c });
  }

  let userLimit: ValueSource | undefined;
  if (ret.limit) {
    userLimit = constantValue(ret.limit);
    if (!userLimit) {
      throw new UnsupportedFeatureError('LIMIT must be an integer literal or a parameter', {
        position: ret.limit.position,
      });
    }
    if (
      userLimit.kind === 'constant' &&
      (typeof userLimit.value !== 'bigint' || userLimit.value < 0n)
    ) {
      throw new SemanticError('LIMIT must be a non-negative integer', {
        position: ret.limit.position,
      });
    }
  }

  return { step: b.finish(scope.select(select, userLimit)), columns };
}
