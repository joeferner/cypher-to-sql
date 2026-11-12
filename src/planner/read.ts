import type * as ast from '../ast.js';
import { SemanticError, UnsupportedFeatureError } from '../errors.js';
import type { ColumnSpec, PlanStep, ValueSource } from '../plan.js';
import { ExprCompiler, type VariableBinding } from './expr.js';
import { constantValue, type SqlBuilder } from './sql-builder.js';

/**
 * What a variable refers to in SQL: a node (an alias of the node table), a
 * relationship (an alias of the edge table), or any other value (a SQL
 * expression of the dialect's JSON type).
 */
export type Binding = VariableBinding;

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
  public readonly expressions: ExprCompiler;

  public constructor(public readonly b: SqlBuilder) {
    this.expressions = new ExprCompiler(b, (variable) => this.lookup(variable));
  }

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
    /** Edge aliases of this clause's relationships, for relationship uniqueness. */
    const relationships: string[] = [];
    /** Relationship variables bound by this clause. */
    const boundHere = new Set<string>();
    for (const part of match.pattern) {
      if (part.variable !== undefined) {
        throw new UnsupportedFeatureError('Named paths are not supported yet', {
          position: part.position,
        });
      }
      let left = this.matchNode(part.elements[0] as ast.NodePattern);
      for (let i = 1; i < part.elements.length; i += 2) {
        const right = this.matchNode(part.elements[i + 1] as ast.NodePattern);
        const rel = part.elements[i] as ast.RelationshipPattern;
        relationships.push(this.matchRelationship(rel, left, right, boundHere));
        left = right;
      }
    }
    // Within one MATCH, two relationship patterns never bind the same relationship.
    const id = b.ident(b.mapping.edges.id);
    for (let i = 0; i < relationships.length; i++) {
      for (let j = i + 1; j < relationships.length; j++) {
        this.where.push(`${relationships[i]}.${id} <> ${relationships[j]}.${id}`);
      }
    }
    if (match.where) {
      this.where.push(this.expressions.condition(match.where));
    }
  }

  /** Binds or reuses the node of a node pattern, adds its filters, and returns its alias. */
  private matchNode(node: ast.NodePattern): string {
    const b = this.b;
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
    this.matchProperties({ kind: 'node', alias }, node.properties);
    return alias;
  }

  /**
   * Binds or reuses the relationship of a relationship pattern between the nodes
   * `left` and `right` (aliases, in pattern order), and returns its alias.
   */
  private matchRelationship(
    rel: ast.RelationshipPattern,
    left: string,
    right: string,
    boundHere: Set<string>,
  ): string {
    const b = this.b;
    const edges = b.mapping.edges;
    if (rel.range) {
      throw new UnsupportedFeatureError('Variable-length relationships are not supported yet', {
        position: rel.position,
      });
    }
    let alias: string;
    const existing = rel.variable !== undefined ? this.bindings.get(rel.variable) : undefined;
    if (existing) {
      if (existing.kind !== 'relationship') {
        throw new SemanticError(`Variable \`${rel.variable}\` is not a relationship`, {
          position: rel.position,
        });
      }
      if (boundHere.has(rel.variable!)) {
        throw new SemanticError(
          `Relationship variable \`${rel.variable}\` is used for more than one relationship in the same MATCH`,
          { position: rel.position },
        );
      }
      // A relationship bound by an earlier clause: constrain it again.
      alias = existing.alias;
    } else {
      alias = `e${this.from.length}`;
      this.from.push(`${b.table('edges')} AS ${alias}`);
      this.order.push(`${alias}.${b.ident(edges.id)}`);
      if (rel.variable !== undefined) {
        this.bindings.set(rel.variable, { kind: 'relationship', alias });
        boundHere.add(rel.variable);
      }
    }

    const start = `${alias}.${b.ident(edges.startId)}`;
    const end = `${alias}.${b.ident(edges.endId)}`;
    const nodeId = b.ident(b.mapping.nodes.id);
    const outgoing = `${start} = ${left}.${nodeId} AND ${end} = ${right}.${nodeId}`;
    const incoming = `${start} = ${right}.${nodeId} AND ${end} = ${left}.${nodeId}`;
    if (rel.direction === 'right') {
      this.where.push(outgoing);
    } else if (rel.direction === 'left') {
      this.where.push(incoming);
    } else {
      // Either direction. Each orientation that fits is its own row, as in Cypher:
      // `(a)-[r]-(b)` matches a relationship twice, with a and b swapped, and a
      // self-loop once.
      this.where.push(`((${outgoing}) OR (${incoming}))`);
    }

    const types = [...new Set(rel.types)];
    if (types.length > 0) {
      const binds = types.map((type) => b.bind({ kind: 'sql', value: type }));
      const type = `${alias}.${b.ident(edges.type)}`;
      this.where.push(
        binds.length === 1 ? `${type} = ${binds[0]}` : `${type} IN (${binds.join(', ')})`,
      );
    }
    this.matchProperties({ kind: 'relationship', alias }, rel.properties);
    return alias;
  }

  /**
   * Adds a filter `entity.k = v` for each entry of an inline property map
   * `{k: v}`, with Cypher equality (so a null or missing property never matches).
   */
  private matchProperties(
    entity: { kind: 'node' | 'relationship'; alias: string },
    properties: ast.Expression | undefined,
  ): void {
    if (!properties) {
      return;
    }
    if (properties.type !== 'Map') {
      throw new SemanticError('A parameter cannot be used as a property map in MATCH', {
        position: properties.position,
        hint: 'Write the properties out, for example (n {name: $name}).',
      });
    }
    const e = this.expressions;
    for (const { key, value } of properties.entries) {
      this.where.push(e.comparison('=', e.member(entity, key), e.compile(value)).sql);
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
    return this.expressions.json(expr);
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
    if (binding?.kind === 'relationship') {
      const edges = b.mapping.edges;
      const col = (name: string): string => `${binding.alias}.${b.ident(name)}`;
      select.push(
        `${col(edges.id)} AS ${c}_id`,
        `${col(edges.type)} AS ${c}_type`,
        `${col(edges.startId)} AS ${c}_start`,
        `${col(edges.endId)} AS ${c}_end`,
        `${b.dialect.jsonText(col(edges.properties))} AS ${c}_props`,
      );
      columns.push({
        name: item.name,
        kind: 'relationship',
        id: `${c}_id`,
        type: `${c}_type`,
        startId: `${c}_start`,
        endId: `${c}_end`,
        properties: `${c}_props`,
      });
      continue;
    }
    const compiled = scope.expressions.compile(expr);
    if (compiled.type === 'node' || compiled.type === 'relationship') {
      throw new UnsupportedFeatureError(
        `Returning this ${compiled.type} expression is not supported yet`,
        {
          position: expr.position,
        },
      );
    }
    if (compiled.type === 'json' || compiled.type === 'null') {
      select.push(
        `${b.dialect.jsonText(compiled.type === 'null' ? 'NULL' : compiled.sql)} AS ${c}`,
      );
      columns.push({ name: item.name, kind: 'json', column: c });
    } else {
      // Native values come back in their SQL type, which keeps floats exact.
      select.push(`${compiled.sql} AS ${c}`);
      columns.push({ name: item.name, kind: 'scalar', type: compiled.type, column: c });
    }
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
