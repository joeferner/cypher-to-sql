import type * as ast from '../ast.js';
import { SemanticError, UnsupportedFeatureError } from '../errors.js';
import type { ColumnSpec, PlanStep, ValueSource } from '../plan.js';
import { containsAggregate, isAggregateCall } from './aggregates.js';
import { ExprCompiler, orderTerm, type Expr, type VariableBinding } from './expr.js';
import { constantValue, type SqlBuilder } from './sql-builder.js';

interface SelectOptions {
  distinct?: boolean;
  orderBy?: string[];
  skip?: ValueSource | undefined;
  limit?: ValueSource | undefined;
}

/**
 * Adds ORDER BY, LIMIT, and OFFSET to `sql`. With `distinct`, sorting happens
 * outside: the DISTINCT rows become the derived table `d`, and `orderBy` must
 * refer to its columns.
 *
 * The final SELECT of a step (`capped`) always has a LIMIT: the query's LIMIT
 * or the row limit, whichever is lower. A WITH stage has only the query's LIMIT,
 * so that its rows are never cut short silently.
 */
function finishSelect(
  b: SqlBuilder,
  sql: string,
  options: SelectOptions & { implicitOrder?: string[]; capped?: boolean },
): string {
  const orderBy = options.orderBy ?? [];
  if (options.distinct) {
    if (orderBy.length > 0) {
      sql = `SELECT * FROM (${sql}) AS d ORDER BY ${orderBy.join(', ')}`;
    }
  } else {
    const order = [...orderBy, ...(options.implicitOrder ?? [])];
    if (order.length > 0) {
      sql += ` ORDER BY ${order.join(', ')}`;
    }
  }
  if (options.capped ?? true) {
    sql += ` LIMIT ${b.bind({ kind: 'rowLimit', userLimit: options.limit })}`;
  } else if (options.limit) {
    sql += ` LIMIT ${b.bind({ kind: 'stageLimit', limit: options.limit })}`;
  } else if (options.skip) {
    sql += ` LIMIT ${b.dialect.limitAll}`;
  }
  if (options.skip) {
    sql += ` OFFSET ${b.bind({ kind: 'rowOffset', skip: options.skip })}`;
  }
  return sql;
}

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
  /**
   * True when the rows have an order to keep (from UNWIND, or from an earlier
   * stage's ORDER BY or UNWIND); `order` then gives it.
   */
  public ordered = false;
  public readonly expressions: ExprCompiler;

  private aliasCount = 0;

  public constructor(public readonly b: SqlBuilder) {
    this.expressions = new ExprCompiler(b, (variable) => this.lookup(variable));
  }

  /** A new table alias, unique in this scope. */
  private alias(prefix: string): string {
    return `${prefix}${this.aliasCount++}`;
  }

  /** Adds a FROM item, cross-joined to the ones before it. */
  private addFrom(item: string): void {
    this.from.push(this.from.length === 0 ? item : `CROSS JOIN ${item}`);
  }

  /**
   * The scope after the given clauses. Each WITH ends a stage: the rows so far
   * become a derived table, and a new scope starts with only the projected
   * variables.
   */
  public static of(b: SqlBuilder, clauses: ast.RowClause[]): ReadScope {
    let scope = new ReadScope(b);
    for (const clause of clauses) {
      if (clause.type === 'Match') {
        scope.addMatch(clause);
      } else if (clause.type === 'Unwind') {
        scope.addUnwind(clause);
      } else {
        scope = scope.project(clause);
      }
    }
    return scope;
  }

  /** The scope after `WITH`: the projected rows as the derived table `w0`. */
  private project(w: ast.WithClause): ReadScope {
    const filterFirst = w.where !== undefined && this.whereBeforeProjection(w);
    if (filterFirst) {
      const projected = new Map(w.items.map((item) => [item.name, item.expression]));
      this.where.push(this.expressions.condition(substituteAliases(w.where!, projected)));
    }
    const stage = planProjection(this.b, this, w, 'with');
    const next = new ReadScope(this.b);
    const alias = next.alias('w');
    next.addFrom(`(${stage.sql}) AS ${alias}`);
    if (stage.ordered) {
      next.order.push(`${alias}.o`);
      next.ordered = true;
    }
    for (const output of stage.outputs) {
      if (output.kind === 'value') {
        const sql = output.expr.type === 'null' ? 'NULL' : `${alias}.${output.column}`;
        next.bindings.set(output.name, {
          kind: 'column',
          expr: { ...output.expr, sql, atomic: true },
        });
        continue;
      }
      // An entity is carried as its id and joined back to its table, so that
      // everything that works on entities works on it. A LEFT JOIN keeps rows
      // where it is null (from OPTIONAL MATCH).
      const table = output.kind === 'node' ? 'nodes' : 'edges';
      const entity = next.alias(output.kind === 'node' ? 'n' : 'e');
      next.from.push(
        `LEFT JOIN ${this.b.table(table)} AS ${entity} ` +
          `ON ${entity}.${this.b.ident(this.b.mapping[table].id)} = ${alias}.${output.column}`,
      );
      next.bindings.set(output.name, { kind: output.kind, alias: entity });
    }
    if (w.where && !filterFirst) {
      // An expression equal to a projected one (`a.x` after `WITH DISTINCT a.x AS x`)
      // refers to the projected value.
      next.where.push(next.expressions.condition(replaceProjected(w.where, w.items)));
    }
    return next;
  }

  /**
   * True when WITH's WHERE uses a variable from before the WITH that the WITH
   * does not project (Cypher allows that). Without aggregation or DISTINCT each
   * row projects to one row, so the filter can be applied before projecting.
   */
  private whereBeforeProjection(w: ast.WithClause): boolean {
    const names = new Set([...w.items.map((i) => i.name), ...(w.star ? this.variables : [])]);
    const outside = freeVariables(w.where!).filter((name) => !names.has(name));
    if (outside.length === 0) {
      return false;
    }
    if (w.distinct || w.items.some((item) => containsAggregate(item.expression))) {
      // Not visible after DISTINCT or aggregation: the WHERE fails to compile later.
      return false;
    }
    if (w.skip || w.limit) {
      throw new UnsupportedFeatureError(
        `WITH ... WHERE using \`${outside[0]}\`, which WITH does not project, together with SKIP or LIMIT is not supported yet`,
        { position: w.where!.position, hint: `Add ${outside[0]} to the WITH items.` },
      );
    }
    return true;
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
    const fromStart = this.from.length;
    const whereStart = this.where.length;
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
    if (match.optional) {
      this.makeOptional(fromStart, whereStart);
    }
  }

  /**
   * Turns the tables and conditions added since the given positions into
   *
   *     LEFT JOIN (<tables>) ON <conditions>
   *
   * so that a row without a match is kept, with the new variables null. The
   * conditions (the pattern's and the OPTIONAL MATCH's WHERE) decide what
   * matches; they may refer to earlier tables.
   */
  private makeOptional(fromStart: number, whereStart: number): void {
    const tables = this.from.splice(fromStart).map((item) => item.replace(/^CROSS JOIN /, ''));
    const conditions = this.where.splice(whereStart);
    if (tables.length === 0) {
      // Every variable was bound already: the match adds nothing, and the row is
      // kept either way.
      return;
    }
    if (this.from.length === 0) {
      // A first OPTIONAL MATCH still gives one row (of nulls) when nothing matches.
      this.from.push(`(SELECT 1 AS one) AS ${this.alias('one')}`);
    }
    const on =
      conditions.length > 0 ? conditions.join(' AND ') : this.b.dialect.booleanLiteral(true);
    // Both databases reject a single table in parentheses.
    const joined = tables.length === 1 ? tables[0]! : `(${tables.join(' CROSS JOIN ')})`;
    this.from.push(`LEFT JOIN ${joined} ON ${on}`);
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
      alias = this.alias('n');
      this.addFrom(`${b.table('nodes')} AS ${alias}`);
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
      alias = this.alias('e');
      this.addFrom(`${b.table('edges')} AS ${alias}`);
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
    const alias = this.alias('u');
    const u = this.b.dialect.unwind(list, alias);
    this.addFrom(u.from);
    if (u.where) {
      this.where.push(u.where);
    }
    this.order.push(u.order);
    this.ordered = true;
    this.bindings.set(unwind.variable, { kind: 'value', sql: u.value });
  }

  /** SQL of the dialect's JSON type for a non-entity expression. */
  public value(expr: ast.Expression): string {
    return this.expressions.json(expr);
  }

  /** `SELECT [DISTINCT] columns FROM ... WHERE ... [GROUP BY ...]` over this scope. */
  public selectBase(columns: string[], distinct = false, groupBy?: string[]): string {
    let sql = `SELECT ${distinct ? 'DISTINCT ' : ''}${columns.join(', ')}`;
    if (this.from.length > 0) {
      sql += ` FROM ${this.from.join(' ')}`;
    }
    if (this.where.length > 0) {
      sql += ` WHERE ${this.where.join(' AND ')}`;
    }
    if (groupBy && groupBy.length > 0) {
      sql += ` GROUP BY ${groupBy.join(', ')}`;
    }
    return sql;
  }

  /**
   * The SELECT over this scope, with ORDER BY, SKIP, and LIMIT (with the row
   * limit unless `capped` is false).
   */
  public select(columns: string[], options: SelectOptions & { capped?: boolean } = {}): string {
    return finishSelect(this.b, this.selectBase(columns, options.distinct), {
      ...options,
      // UNWIND defines the order of its rows; keep it (nested-loop order across
      // FROM items) where ORDER BY leaves ties.
      implicitOrder: this.ordered ? this.order : [],
    });
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

/** Plans `MATCH ... / UNWIND ... / WITH ... RETURN ...` as one SELECT. */
export function planRead(
  b: SqlBuilder,
  clauses: ast.RowClause[],
  ret: ast.ReturnClause,
): { step: PlanStep; columns: ColumnSpec[] } {
  const result = planProjection(b, ReadScope.of(b, clauses), ret, 'return');
  return { step: b.finish(result.sql), columns: result.columns };
}

/** A projected value of a WITH stage: a column of the stage's derived table. */
type StageOutput =
  | { name: string; kind: 'node' | 'relationship'; column: string }
  | { name: string; kind: 'value'; column: string; expr: Expr };

interface ProjectionResult {
  sql: string;
  /** For RETURN: how to build the result columns. */
  columns: ColumnSpec[];
  /** For WITH: the stage's columns. */
  outputs: StageOutput[];
  /** For WITH: the stage has an order to keep, in its column `o`. */
  ordered: boolean;
}

type ProjectionMode = 'return' | 'with';

/**
 * A RETURN or WITH over a scope: its items, DISTINCT, aggregation, ORDER BY,
 * SKIP, and LIMIT. RETURN gives the result columns; WITH gives raw columns
 * (JSON stays JSON, entities are their ids) for the next stage.
 */
function planProjection(
  b: SqlBuilder,
  scope: ReadScope,
  proj: ast.ReturnClause | ast.WithClause,
  mode: ProjectionMode,
): ProjectionResult {
  const clause = mode === 'return' ? 'RETURN' : 'WITH';
  const items: ast.ProjectionItem[] = [...proj.items];
  if (proj.star) {
    if (scope.variables.length === 0) {
      throw new SemanticError(`${clause} * is not allowed when there are no variables in scope`, {
        position: proj.position,
      });
    }
    const starItems = scope.variables.sort().map((name): ast.ProjectionItem => ({
      position: proj.position,
      expression: { type: 'Variable', position: proj.position, name },
      alias: undefined,
      name,
    }));
    items.unshift(...starItems);
  }
  if (mode === 'with') {
    for (const item of items) {
      if (item.alias === undefined && item.expression.type !== 'Variable') {
        throw new SemanticError('An expression in WITH must be given a name with AS', {
          position: item.position,
          hint: `For example: WITH ${item.name} AS value`,
        });
      }
    }
  }
  checkUniqueNames(items);
  if (items.some((item) => containsAggregate(item.expression))) {
    return planAggregation(b, scope, items, proj, mode);
  }

  const values = (item: ast.ProjectionItem): ItemValue => {
    const expr = item.expression;
    const binding = expr.type === 'Variable' ? scope.lookup(expr) : undefined;
    if (binding?.kind === 'node' || binding?.kind === 'relationship') {
      return entityColumns(b, binding.kind, (name) => `${binding.alias}.${b.ident(name)}`);
    }
    return { kind: 'value', expr: scope.expressions.compile(expr) };
  };
  const { select, columns, outputs } = projectItems(b, items, values, mode);

  // ORDER BY sees the projection's names (which hide variables of the same
  // name) and, without DISTINCT, every variable in scope.
  const projected = new Map(items.map((item) => [item.name, item.expression]));
  const orderBy = orderTerms(proj, items, select, scope.expressions, (expr) => {
    if (containsAggregate(expr)) {
      throw new SemanticError(`ORDER BY can use aggregates only when ${clause} aggregates`, {
        position: expr.position,
      });
    }
    return scope.expressions.compile(substituteAliases(expr, projected));
  });

  const sql = scope.select(select, {
    distinct: proj.distinct,
    orderBy,
    skip: proj.skip ? rowCount(proj.skip, 'SKIP') : undefined,
    limit: proj.limit ? rowCount(proj.limit, 'LIMIT') : undefined,
    capped: mode === 'return',
  });
  const ordered = orderBy.length > 0 || (scope.ordered && !proj.distinct);
  return stageResult(sql, columns, outputs, mode, ordered);
}

/**
 * For WITH, a stage whose rows have an order (ORDER BY, or UNWIND before it)
 * numbers them in column `o`, so that later stages can keep that order.
 */
function stageResult(
  sql: string,
  columns: ColumnSpec[],
  outputs: StageOutput[],
  mode: ProjectionMode,
  ordered: boolean,
): ProjectionResult {
  if (mode === 'with' && ordered) {
    return {
      sql: `SELECT s.*, row_number() OVER () AS o FROM (${sql}) AS s`,
      columns,
      outputs,
      ordered,
    };
  }
  return { sql, columns, outputs, ordered: false };
}

function checkUniqueNames(items: ast.ProjectionItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.name)) {
      throw new SemanticError(`Multiple result columns with the same name: ${item.name}`, {
        position: item.position,
      });
    }
    seen.add(item.name);
  }
}

/** The SQL for one RETURN item: an entity's columns, or a compiled value. */
type ItemValue =
  | { kind: 'node'; id: string; labels: string; properties: string }
  | {
      kind: 'relationship';
      id: string;
      type: string;
      startId: string;
      endId: string;
      properties: string;
    }
  | { kind: 'value'; expr: Expr };

/** The columns of an entity, given how to refer to a column by its mapped name. */
function entityColumns(
  b: SqlBuilder,
  kind: 'node' | 'relationship',
  column: (name: string) => string,
): ItemValue {
  if (kind === 'node') {
    const n = b.mapping.nodes;
    return {
      kind,
      id: column(n.id),
      labels: column(n.labels),
      properties: column(n.properties),
    };
  }
  const e = b.mapping.edges;
  return {
    kind,
    id: column(e.id),
    type: column(e.type),
    startId: column(e.startId),
    endId: column(e.endId),
    properties: column(e.properties),
  };
}

/** SELECT columns and result columns for the RETURN items. */
function projectItems(
  b: SqlBuilder,
  items: ast.ProjectionItem[],
  value: (item: ast.ProjectionItem) => ItemValue,
  mode: ProjectionMode,
): { select: string[]; columns: ColumnSpec[]; outputs: StageOutput[] } {
  const d = b.dialect;
  const select: string[] = [];
  const columns: ColumnSpec[] = [];
  const outputs: StageOutput[] = [];
  for (const [i, item] of items.entries()) {
    const c = `c${i}`;
    const v = value(item);
    if (mode === 'with') {
      // Raw columns for the next stage: an entity's id, or the value itself.
      if (v.kind === 'node' || v.kind === 'relationship') {
        select.push(`${v.id} AS ${c}`);
        outputs.push({ name: item.name, kind: v.kind, column: c });
      } else if (v.expr.type === 'node' || v.expr.type === 'relationship') {
        throw new UnsupportedFeatureError(
          `Projecting this ${v.expr.type} expression is not supported yet`,
          { position: item.expression.position },
        );
      } else {
        select.push(`${v.expr.type === 'null' ? d.jsonInput('NULL') : v.expr.sql} AS ${c}`);
        outputs.push({ name: item.name, kind: 'value', column: c, expr: v.expr });
      }
      continue;
    }
    if (v.kind === 'node') {
      select.push(
        `${v.id} AS ${c}_id`,
        `${d.jsonText(v.labels)} AS ${c}_labels`,
        `${d.jsonText(v.properties)} AS ${c}_props`,
      );
      columns.push({
        name: item.name,
        kind: 'node',
        id: `${c}_id`,
        labels: `${c}_labels`,
        properties: `${c}_props`,
      });
    } else if (v.kind === 'relationship') {
      select.push(
        `${v.id} AS ${c}_id`,
        `${v.type} AS ${c}_type`,
        `${v.startId} AS ${c}_start`,
        `${v.endId} AS ${c}_end`,
        `${d.jsonText(v.properties)} AS ${c}_props`,
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
    } else if (v.expr.type === 'node' || v.expr.type === 'relationship') {
      throw new UnsupportedFeatureError(
        `Returning this ${v.expr.type} expression is not supported yet`,
        { position: item.expression.position },
      );
    } else if (v.expr.type === 'json' || v.expr.type === 'null') {
      select.push(`${d.jsonText(v.expr.type === 'null' ? 'NULL' : v.expr.sql)} AS ${c}`);
      columns.push({ name: item.name, kind: 'json', column: c });
    } else {
      // Native values come back in their SQL type, which keeps floats exact.
      select.push(`${v.expr.sql} AS ${c}`);
      columns.push({ name: item.name, kind: 'scalar', type: v.expr.type, column: c });
    }
  }
  return { select, columns, outputs };
}

/**
 * ORDER BY terms. With DISTINCT, the sort keys become hidden columns of the
 * DISTINCT select (they depend only on projected values, so they do not change
 * which rows are distinct) and the terms refer to the derived table `d`.
 */
function orderTerms(
  ret: ast.ReturnClause | ast.WithClause,
  items: ast.ProjectionItem[],
  select: string[],
  compiler: ExprCompiler,
  compile: (expr: ast.Expression) => Expr,
): string[] {
  const orderBy: string[] = [];
  for (const sort of ret.orderBy) {
    if (ret.distinct) {
      checkProjectedOnly(sort.expression, items);
    }
    for (const key of compiler.sortKeys(compile(sort.expression))) {
      if (ret.distinct) {
        const k = `k${orderBy.length}`;
        select.push(`${key.sql} AS ${k}`);
        orderBy.push(orderTerm(`d.${k}`, key, sort.descending));
      } else {
        orderBy.push(orderTerm(key.sql, key, sort.descending));
      }
    }
  }
  return orderBy;
}

/**
 * RETURN with aggregates, as two levels:
 *
 *     SELECT <items, ORDER BY> FROM (
 *       SELECT <grouping keys>, <aggregates>, <properties of keys> FROM ... GROUP BY <keys>
 *     ) AS g
 *
 * The inner level holds only grouping keys, aggregate calls, and properties of
 * key variables, so PostgreSQL's rules for grouped queries are met however the
 * items combine them; the outer level computes the items from those columns.
 */
function planAggregation(
  b: SqlBuilder,
  scope: ReadScope,
  items: ast.ProjectionItem[],
  ret: ast.ReturnClause | ast.WithClause,
  mode: ProjectionMode,
): ProjectionResult {
  const keys = items.filter((item) => !containsAggregate(item.expression));
  for (const item of items) {
    if (containsAggregate(item.expression)) {
      checkGroupedOnly(item.expression, keys);
    }
  }

  const inner: string[] = [];
  const groupBy: string[] = [];
  const outer = new Map<string, VariableBinding>();
  const column = (name: string, e: Expr): void => {
    outer.set(name, { kind: 'column', expr: { ...e, sql: `g.${name}`, atomic: true } });
  };

  // Grouping keys. Their compiled SQL appears in the inner SELECT and GROUP BY.
  const keyValues = new Map<ast.ProjectionItem, ItemValue>();
  keys.forEach((item, i) => {
    const expr = item.expression;
    const binding = expr.type === 'Variable' ? scope.lookup(expr) : undefined;
    if (binding?.kind === 'node' || binding?.kind === 'relationship') {
      const raw = entityColumns(b, binding.kind, (n) => `${binding.alias}.${b.ident(n)}`);
      const fields = Object.entries(raw).filter(([field]) => field !== 'kind');
      for (const [field, sql] of fields) {
        inner.push(`${sql} AS g${i}_${field}`);
        groupBy.push(sql as string);
      }
      keyValues.set(
        item,
        entityColumns(b, binding.kind, (n) => fieldRef(b, binding.kind, n, i)),
      );
      // Used next to aggregates (for example in ORDER BY), an entity key sorts and compares by id.
      column(`g${i}_id`, { sql: '', type: 'integer', atomic: true });
      outer.set(keyName(i), outer.get(`g${i}_id`)!);
      return;
    }
    const e = scope.expressions.compile(expr);
    if (e.type === 'null') {
      outer.set(keyName(i), { kind: 'column', expr: e });
    } else {
      inner.push(`${e.sql} AS g${i}`);
      groupBy.push(e.sql);
      column(`g${i}`, e);
      outer.set(keyName(i), outer.get(`g${i}`)!);
    }
  });

  // Aggregates and properties of key variables become inner columns, referred
  // to by synthetic variables in the outer expressions.
  const extra = new Map<string, string>();
  const rewrite = (expr: ast.Expression): ast.Expression => {
    const ref = (name: string): ast.Expression => ({
      type: 'Variable',
      position: expr.position,
      name,
    });
    const keyIndex = keys.findIndex(
      (key) =>
        sameExpression(key.expression, expr) ||
        (expr.type === 'Variable' && key.alias === expr.name),
    );
    if (keyIndex >= 0) {
      return ref(keyName(keyIndex));
    }
    const aggregate =
      expr.type === 'CountStar' || (expr.type === 'FunctionCall' && isAggregateCall(expr));
    if (aggregate || (expr.type === 'PropertyAccess' && rootedAtKey(expr, keys))) {
      const text = JSON.stringify(expr, (k, v: unknown) =>
        k === 'position' ? undefined : typeof v === 'bigint' ? `${v}n` : v,
      );
      let name = extra.get(text);
      if (!name) {
        name = `x${extra.size}`;
        extra.set(text, name);
        scope.expressions.aggregation = aggregate ? 'allowed' : 'none';
        const e = scope.expressions.compile(expr);
        scope.expressions.aggregation = 'none';
        inner.push(`${e.type === 'null' ? 'NULL' : e.sql} AS ${name}`);
        column(name, e);
      }
      return ref(name);
    }
    return mapChildren(expr, rewrite);
  };

  const outerCompiler = new ExprCompiler(b, (variable) => {
    const binding = outer.get(variable.name);
    if (!binding) {
      throw new SemanticError(
        `Variable \`${variable.name}\` is not available here: after aggregation only returned values can be used`,
        { position: variable.position },
      );
    }
    return binding;
  });

  const { select, columns, outputs } = projectItems(
    b,
    items,
    (item) => {
      const key = keyValues.get(item);
      if (key) {
        return key;
      }
      return { kind: 'value', expr: outerCompiler.compile(rewrite(item.expression)) };
    },
    mode,
  );

  const projected = new Map(items.map((item) => [item.name, item.expression]));
  const orderBy = orderTerms(ret, items, select, outerCompiler, (expr) => {
    if (containsAggregate(expr)) {
      checkGroupedOnly(expr, keys);
      // ORDER BY may use only aggregates that are also projected.
      const projectedAggregates = items.flatMap((item) => aggregatesIn(item.expression));
      for (const aggregate of aggregatesIn(substituteAliases(expr, projected))) {
        if (!projectedAggregates.some((p) => sameExpression(p, aggregate))) {
          throw new SemanticError(
            'ORDER BY after aggregation can use only aggregates that are projected',
            {
              position: aggregate.position,
              hint: 'Project the aggregate with AS and sort by its name.',
            },
          );
        }
      }
    } else {
      checkProjectedOnly(expr, items);
    }
    return outerCompiler.compile(rewrite(substituteAliases(expr, projected)));
  });

  const innerSql = scope.selectBase(inner.length > 0 ? inner : ['1 AS g'], false, groupBy);
  const sql = finishSelect(
    b,
    `SELECT ${ret.distinct ? 'DISTINCT ' : ''}${select.join(', ')} FROM (${innerSql}) AS g`,
    {
      distinct: ret.distinct,
      orderBy,
      skip: ret.skip ? rowCount(ret.skip, 'SKIP') : undefined,
      limit: ret.limit ? rowCount(ret.limit, 'LIMIT') : undefined,
      capped: mode === 'return',
    },
  );
  return stageResult(sql, columns, outputs, mode, orderBy.length > 0);
}

/** The aggregate calls in an expression (not looking inside them). */
function aggregatesIn(expr: ast.Expression): ast.Expression[] {
  if (expr.type === 'CountStar' || (expr.type === 'FunctionCall' && isAggregateCall(expr))) {
    return [expr];
  }
  const found: ast.Expression[] = [];
  mapChildren(expr, (child) => {
    found.push(...aggregatesIn(child));
    return child;
  });
  return found;
}

/** Replaces subexpressions equal to a projection item's expression with the item's name. */
function replaceProjected(expr: ast.Expression, items: ast.ProjectionItem[]): ast.Expression {
  const item = items.find(
    (i) => i.expression.type !== 'Variable' && sameExpression(i.expression, expr),
  );
  if (item) {
    return { type: 'Variable', position: expr.position, name: item.name };
  }
  return mapChildren(expr, (child) => replaceProjected(child, items));
}

/** The names of the variables an expression uses. */
function freeVariables(expr: ast.Expression): string[] {
  if (expr.type === 'Variable') {
    return [expr.name];
  }
  const names: string[] = [];
  mapChildren(expr, (child) => {
    names.push(...freeVariables(child));
    return child;
  });
  return names;
}

/** The synthetic variable for grouping key `i` in the outer query of an aggregation. */
function keyName(i: number): string {
  return `\u0001key${i}`;
}

/** Outer reference to the inner column holding field `name` of entity key `i`. */
function fieldRef(b: SqlBuilder, kind: 'node' | 'relationship', name: string, i: number): string {
  const fields = entityColumns(b, kind, (n) => n) as Record<string, string>;
  const field = Object.keys(fields).find((f) => f !== 'kind' && fields[f] === name)!;
  return `g.g${i}_${field}`;
}

/** True for `k.a.b` where `k` is (the name of) a grouping key. */
function rootedAtKey(expr: ast.PropertyAccess, keys: ast.ProjectionItem[]): boolean {
  const subject = expr.subject;
  if (subject.type === 'PropertyAccess') {
    return rootedAtKey(subject, keys);
  }
  return (
    subject.type === 'Variable' &&
    keys.some(
      (key) =>
        (key.expression.type === 'Variable' && key.expression.name === subject.name) ||
        key.alias === subject.name,
    )
  );
}

/** A SKIP or LIMIT value: a non-negative integer literal, or a parameter (checked when bound). */
function rowCount(expr: ast.Expression, clause: 'SKIP' | 'LIMIT'): ValueSource {
  const value = constantValue(expr);
  if (!value) {
    throw new UnsupportedFeatureError(`${clause} must be an integer literal or a parameter`, {
      position: expr.position,
    });
  }
  if (value.kind === 'constant' && (typeof value.value !== 'bigint' || value.value < 0n)) {
    throw new SemanticError(`${clause} must be a non-negative integer`, {
      position: expr.position,
    });
  }
  return value;
}

/**
 * An expression with an aggregate may only use, outside its aggregates,
 * constants and grouping keys that are a variable, a property of one, or the
 * name of a key item: `n.x, count(*) + n.x` is fine, but `count(*) + n.y` is
 * ambiguous when `n.y` is not a key, and so is `n.x + n.y` next to an aggregate
 * even when `n.x + n.y` is itself returned (as in Cypher). With `n` as a key,
 * its properties are fixed within a group and may be used.
 */
function checkGroupedOnly(expr: ast.Expression, keys: ast.ProjectionItem[]): void {
  if (expr.type === 'CountStar' || (expr.type === 'FunctionCall' && isAggregateCall(expr))) {
    return;
  }
  const simple = expr.type === 'Variable' || expr.type === 'PropertyAccess';
  const isKey = (e: ast.Expression): boolean =>
    keys.some(
      (key) => sameExpression(key.expression, e) || (e.type === 'Variable' && key.alias === e.name),
    ) ||
    (e.type === 'PropertyAccess' && isKey(e.subject));
  if (simple && isKey(expr)) {
    return;
  }
  if (simple || (expr.type === 'FunctionCall' && expr.name.toLowerCase() === 'rand')) {
    throw new SemanticError(
      'An expression next to an aggregate may use only constants and grouping keys ' +
        '(variables, their properties, or names of returned items)',
      {
        position: expr.position,
        hint: 'Return the value as its own item, or use it inside the aggregate.',
      },
    );
  }
  mapChildren(expr, (child) => {
    checkGroupedOnly(child, keys);
    return child;
  });
}

/** Replaces variables that name a projection item with the item's expression. */
function substituteAliases(
  expr: ast.Expression,
  projected: Map<string, ast.Expression>,
): ast.Expression {
  if (expr.type === 'Variable') {
    return projected.get(expr.name) ?? expr;
  }
  return mapChildren(expr, (child) => substituteAliases(child, projected));
}

/**
 * After `RETURN DISTINCT`, ORDER BY may only use projected values: the names of
 * projection items, and expressions equal to a projected expression.
 */
function checkProjectedOnly(expr: ast.Expression, items: ast.ProjectionItem[]): void {
  if (items.some((item) => sameExpression(item.expression, expr))) {
    return;
  }
  if (expr.type === 'Variable') {
    if (!items.some((item) => item.name === expr.name)) {
      throw new SemanticError(
        `Variable \`${expr.name}\` is not available after RETURN DISTINCT; ORDER BY can only use projected values`,
        { position: expr.position },
      );
    }
    return;
  }
  mapChildren(expr, (child) => {
    checkProjectedOnly(child, items);
    return child;
  });
}

function sameExpression(a: ast.Expression, b: ast.Expression): boolean {
  const text = (e: ast.Expression): string =>
    JSON.stringify(e, (key, value: unknown) =>
      key === 'position' ? undefined : typeof value === 'bigint' ? `${value}n` : value,
    );
  return text(a) === text(b);
}

/** A copy of `expr` with each direct child expression replaced by `f(child)`. */
function mapChildren(
  expr: ast.Expression,
  f: (child: ast.Expression) => ast.Expression,
): ast.Expression {
  switch (expr.type) {
    case 'List':
      return { ...expr, items: expr.items.map(f) };
    case 'Map':
      return { ...expr, entries: expr.entries.map((e) => ({ key: e.key, value: f(e.value) })) };
    case 'PropertyAccess':
    case 'HasLabels':
      return { ...expr, subject: f(expr.subject) };
    case 'Binary':
      return { ...expr, left: f(expr.left), right: f(expr.right) };
    case 'FunctionCall':
      return { ...expr, args: expr.args.map(f) };
    case 'Not':
    case 'Negate':
    case 'IsNull':
      return { ...expr, operand: f(expr.operand) };
    default:
      return expr;
  }
}
