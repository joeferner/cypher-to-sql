import type * as ast from '../ast.js';
import { SemanticError, UnsupportedFeatureError } from '../errors.js';
import type { ColumnSpec, PlanStep, ValueSource } from '../plan.js';
import { containsAggregate, isAggregateCall } from './aggregates.js';
import { ExprCompiler, orderTerm, type Expr, type VariableBinding } from './expr.js';
import { constantValue, type SqlBuilder } from './sql-builder.js';
import { children, mapChildren, patternVariables } from './walk.js';

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
 * A relationship pattern of a MATCH: one edge (an alias), or a variable-length
 * match (its edge-id list, and for named paths the ids of the nodes after the
 * start node).
 */
type Matched =
  { kind: 'one'; alias: string } | { kind: 'list'; path: string; nodes: string | undefined };

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
  /**
   * The FROM items: a table (or derived table) that the planner may join in any
   * order, or a join that must stay where it is (`LEFT JOIN ... ON ...`).
   */
  private readonly from: ({ table: string } | { join: string })[] = [];
  private readonly where: string[] = [];
  /** Expressions that order rows the way Cypher produces them (one per FROM item). */
  private readonly order: string[] = [];
  /**
   * True when the rows have an order to keep (from UNWIND, or from an earlier
   * stage's ORDER BY or UNWIND); `order` then gives it.
   */
  public ordered = false;
  public readonly expressions: ExprCompiler;
  /**
   * True when the rows include a variable-length search that starts at every
   * node (see `startNodes`), here or in an earlier stage.
   */
  private searchesEverything = false;

  private aliasCount = 0;

  /**
   * @param outer For the scope of a subquery (EXISTS, a pattern predicate or
   *   comprehension): resolves the variables of the enclosing query, and starts
   *   every alias, so that none hides an alias of the enclosing query.
   */
  public constructor(
    public readonly b: SqlBuilder,
    private readonly outer?: {
      find: (name: string) => Binding | undefined;
      prefix: string;
    },
  ) {
    this.expressions = new ExprCompiler(
      b,
      (variable) => this.find(variable.name),
      outer?.prefix ?? '',
    );
    this.expressions.subquery = (expr, find): Expr => this.subquery(expr, find);
  }

  /** A new table alias, unique in this scope and its enclosing ones. */
  private alias(prefix: string): string {
    return `${this.outer?.prefix ?? ''}${prefix}${this.aliasCount++}`;
  }

  /** The binding of a variable of this scope or an enclosing query, or undefined. */
  private find(name: string): Binding | undefined {
    return this.bindings.get(name) ?? this.outer?.find(name);
  }

  /** Adds a FROM item, joined to the ones before it (see `joinTables`). */
  private addFrom(item: string): void {
    this.from.push({ table: item });
  }

  /**
   * Tables joined with plain inner joins, `a JOIN b ON TRUE`: their conditions
   * are in WHERE, and the database may join them in any order. (SQLite takes
   * `CROSS JOIN` as a fixed join order, which made it scan whole tables.)
   */
  private joinTables(tables: string[]): string {
    const on = ` ON ${this.b.dialect.booleanLiteral(true)}`;
    return tables.map((t, i) => (i === 0 ? t : `JOIN ${t}${on}`)).join(' ');
  }

  /** The FROM clause, without the keyword. */
  private fromClause(): string {
    const on = ` ON ${this.b.dialect.booleanLiteral(true)}`;
    return this.from
      .map((item, i) =>
        'join' in item ? item.join : i === 0 ? item.table : `JOIN ${item.table}${on}`,
      )
      .join(' ');
  }

  /**
   * The scope after the given clauses. Each WITH ends a stage: the rows so far
   * become a derived table, and a new scope starts with only the projected
   * variables.
   */
  public static of(
    b: SqlBuilder,
    clauses: ast.RowClause[],
    start: ReadScope = new ReadScope(b),
  ): ReadScope {
    let scope = start;
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

  /** The scope over the rows a write query wrote (see `planWrittenReturn`). */
  public static written(b: SqlBuilder, variables: WrittenVariable[]): ReadScope {
    const d = b.dialect;
    const scope = new ReadScope(b);
    const u = d.unwind(d.jsonInput(b.bind({ kind: 'writtenRows' })), scope.alias('r'));
    scope.addFrom(u.from);
    if (u.where) {
      scope.where.push(u.where);
    }
    scope.order.push(u.order);
    scope.ordered = true;
    for (const { name, kind } of variables) {
      const member = d.jsonMember(u.value, b.bind({ kind: 'sql', value: name }), name);
      if (kind === 'value') {
        scope.bindings.set(name, { kind: 'value', sql: member });
        continue;
      }
      const table = kind === 'node' ? 'nodes' : 'edges';
      const alias = scope.alias(kind === 'node' ? 'n' : 'e');
      const idName = b.mapping[table].id;
      // LEFT JOIN: a node from OPTIONAL MATCH may be null.
      scope.from.push({
        join:
          `LEFT JOIN ${b.table(table)} AS ${alias} ON ${alias}.${b.ident(idName)} = ` +
          d.jsonId(member, b.table(table), idName),
      });
      scope.bindings.set(name, { kind, alias });
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
    const next = new ReadScope(this.b, this.outer);
    next.searchesEverything = this.searchesEverything;
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
      if (output.kind === 'relationships') {
        next.bindings.set(output.name, {
          kind: 'relationships',
          path: `${alias}.${output.column}`,
        });
        continue;
      }
      // An entity is carried as its id and joined back to its table, so that
      // everything that works on entities works on it. A LEFT JOIN keeps rows
      // where it is null (from OPTIONAL MATCH).
      const table = output.kind === 'node' ? 'nodes' : 'edges';
      const entity = next.alias(output.kind === 'node' ? 'n' : 'e');
      next.from.push({
        join:
          `LEFT JOIN ${this.b.table(table)} AS ${entity} ` +
          `ON ${entity}.${this.b.ident(this.b.mapping[table].id)} = ${alias}.${output.column}`,
      });
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
    const binding = this.find(variable.name);
    if (!binding) {
      throw new SemanticError(`Variable \`${variable.name}\` not defined`, {
        position: variable.position,
      });
    }
    return binding;
  }

  public has(name: string): boolean {
    return this.find(name) !== undefined;
  }

  /** True for a variable of the enclosing query of a subquery (not bound by this scope). */
  public isOuter(name: string): boolean {
    return !this.bindings.has(name) && this.outer?.find(name) !== undefined;
  }

  private addMatch(match: ast.MatchClause): void {
    const fromStart = this.from.length;
    const whereStart = this.where.length;
    /** This clause's relationships, for relationship uniqueness. */
    const relationships: Matched[] = [];
    /** Relationship variables bound by this clause. */
    const boundHere = new Set<string>();
    // A path variable names only its path: no node or relationship of the MATCH may use it.
    const elementVariables = new Set(
      match.pattern.flatMap((part) => part.elements.map((e) => e.variable)),
    );
    for (const part of match.pattern) {
      if (part.variable !== undefined && elementVariables.has(part.variable)) {
        throw new SemanticError(`Variable \`${part.variable}\` already declared`, {
          position: part.position,
        });
      }
      if (part.shortest) {
        checkShortestPath(part, match.where);
      }
    }
    for (const part of match.pattern) {
      const named = part.variable !== undefined;
      if (named && this.has(part.variable!)) {
        throw new SemanticError(`Variable \`${part.variable}\` already declared`, {
          position: part.position,
        });
      }
      const first = this.matchNode(part.elements[0] as ast.NodePattern);
      let left = first;
      /** The segments of this part, for a named path. */
      const segments: { rel: Matched; node: string }[] = [];
      for (let i = 1; i < part.elements.length; i += 2) {
        // The rows before the right node joins: where a variable-length search starts.
        const start = this.startNodes(left);
        const right = this.matchNode(part.elements[i + 1] as ast.NodePattern);
        const rel = part.elements[i] as ast.RelationshipPattern;
        const matched: Matched = part.shortest
          ? this.matchShortestPath(rel, left, right, boundHere, part.shortest)
          : rel.range
            ? this.matchVariableLength(rel, left, right, boundHere, named, start)
            : { kind: 'one', alias: this.matchRelationship(rel, left, right, boundHere) };
        relationships.push(matched);
        segments.push({ rel: matched, node: right });
        left = right;
      }
      if (named) {
        this.bindings.set(part.variable!, {
          kind: 'value',
          sql: this.pathValue(first, segments),
          shape: 'path',
        });
      }
    }
    // Within one MATCH, two relationship patterns never bind the same relationship.
    for (let i = 0; i < relationships.length; i++) {
      for (let j = i + 1; j < relationships.length; j++) {
        this.where.push(this.distinctRelationships(relationships[i]!, relationships[j]!));
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
    const tables = this.from.splice(fromStart).map((item) => {
      if (!('table' in item)) {
        throw new Error('Internal error: a MATCH added a join that is not a table');
      }
      return item.table;
    });
    const conditions = this.where.splice(whereStart);
    if (tables.length === 0) {
      // Every variable was bound already: the match adds nothing, and the row is
      // kept either way.
      return;
    }
    if (this.from.length === 0) {
      // A first OPTIONAL MATCH still gives one row (of nulls) when nothing matches.
      this.from.push({ table: `(SELECT 1 AS one) AS ${this.alias('one')}` });
    }
    const on =
      conditions.length > 0 ? conditions.join(' AND ') : this.b.dialect.booleanLiteral(true);
    // Both databases reject a single table in parentheses.
    const joined = tables.length === 1 ? tables[0]! : `(${this.joinTables(tables)})`;
    this.from.push({ join: `LEFT JOIN ${joined} ON ${on}` });
  }

  /** Binds or reuses the node of a node pattern, adds its filters, and returns its alias. */
  private matchNode(node: ast.NodePattern): string {
    const b = this.b;
    let alias: string;
    const existing = node.variable !== undefined ? this.find(node.variable) : undefined;
    if (existing?.kind === 'value' || existing?.kind === 'column') {
      // A value that may hold a node (from a list, a path, or collect()): join
      // the node it holds, and refer to that from now on.
      const value = this.expressions.compile({
        type: 'Variable',
        position: node.position,
        name: node.variable!,
      });
      if ((value.type !== 'json' && value.type !== 'null') || value.shape !== undefined) {
        throw new SemanticError(`Variable \`${node.variable}\` is not a node`, {
          position: node.position,
        });
      }
      alias = this.alias('n');
      this.addFrom(`${b.table('nodes')} AS ${alias}`);
      this.order.push(`${alias}.${b.ident(b.mapping.nodes.id)}`);
      const id = `${alias}.${b.ident(b.mapping.nodes.id)}`;
      this.where.push(
        value.type === 'null'
          ? b.dialect.booleanLiteral(false)
          : this.expressions.share(
              [value],
              ([v]) =>
                `(${v!.jsonType} = 'node' AND ${b.dialect.jsonIdEquals(
                  id,
                  b.dialect.jsonMember(v!.sql, b.bind({ kind: 'sql', value: '~id' }), '~id'),
                )})`,
            ),
      );
      this.bindings.set(node.variable!, { kind: 'node', alias });
      this.expressions.forget();
    } else if (existing) {
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
    let alias: string;
    const existing = rel.variable !== undefined ? this.find(rel.variable) : undefined;
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

    this.where.push(...this.relationshipFilters(rel, alias));
    return alias;
  }

  /** Conditions on the edge `alias` from the types and properties of a relationship pattern. */
  private relationshipFilters(rel: ast.RelationshipPattern, alias: string): string[] {
    const b = this.b;
    const conditions: string[] = [];
    const types = [...new Set(rel.types)];
    if (types.length > 0) {
      const binds = types.map((type) => b.bind({ kind: 'sql', value: type }));
      const type = `${alias}.${b.ident(b.mapping.edges.type)}`;
      conditions.push(
        binds.length === 1 ? `${type} = ${binds[0]}` : `${type} IN (${binds.join(', ')})`,
      );
    }
    conditions.push(...this.propertyFilters({ kind: 'relationship', alias }, rel.properties));
    return conditions;
  }

  /**
   * The JSON value of a named path that starts at the node alias `first`: its
   * nodes and relationships in order, with those of variable-length segments
   * loaded from their id lists. Null when any part is null (OPTIONAL MATCH).
   */
  private pathValue(first: string, segments: { rel: Matched; node: string }[]): string {
    const b = this.b;
    const d = b.dialect;
    const nodeId = b.ident(b.mapping.nodes.id);
    const edgeId = b.ident(b.mapping.edges.id);
    /** Each list as JSON lists to concatenate; consecutive single entities share one list. */
    const nodes: (string | string[])[] = [[d.entityJson('node', first, b.columns('nodes'))]];
    const rels: (string | string[])[] = [];
    const nulls = [`${first}.${nodeId} IS NULL`];
    const add = (list: (string | string[])[], item: string): void => {
      const last = list[list.length - 1];
      if (Array.isArray(last)) {
        last.push(item);
      } else {
        list.push([item]);
      }
    };
    for (const { rel, node } of segments) {
      if (rel.kind === 'one') {
        add(rels, d.entityJson('relationship', rel.alias, b.columns('edges')));
        add(nodes, d.entityJson('node', node, b.columns('nodes')));
        nulls.push(`${rel.alias}.${edgeId} IS NULL`, `${node}.${nodeId} IS NULL`);
      } else {
        rels.push(d.entityList('relationship', rel.path, b.columns('edges')));
        nodes.push(d.entityList('node', rel.nodes!, b.columns('nodes')));
        nulls.push(`${rel.path} IS NULL`);
      }
    }
    const concat = (list: (string | string[])[]): string => {
      const parts = list.map((item) => (Array.isArray(item) ? d.jsonArray(item) : item));
      return parts.length === 0
        ? d.jsonArray([])
        : parts.reduce((all, item) => d.concatLists(all, item));
    };
    return (
      `(CASE WHEN ${nulls.join(' OR ')} THEN ${d.jsonInput('NULL')} ` +
      `ELSE ${d.pathJson(concat(nodes), concat(rels))} END)`
    );
  }

  /**
   * A query of the node ids that `left` (a node alias) can be in the rows so
   * far, or undefined when that is every node or cannot be known here. Called
   * before the pattern's next node joins, so the query has only the earlier
   * tables and conditions: it is self-contained and fits in a recursive CTE.
   */
  private startNodes(left: string): string | undefined {
    const b = this.b;
    if (this.outer || this.where.length === 0 || this.searchesEverything) {
      // In a subquery the rows refer to the enclosing query; with no condition
      // at all, every node can start; and repeating a search that starts at
      // every node would cost more than it saves.
      return undefined;
    }
    let sql = `SELECT ${left}.${b.ident(b.mapping.nodes.id)} FROM ${this.fromClause()}`;
    sql += ` WHERE ${this.where.join(' AND ')}`;
    return sql;
  }

  /**
   * Matches a variable-length relationship pattern `[r:T*min..max {k: v}]`
   * between the nodes `left` and `right` and returns the SQL of its id list.
   *
   * Every path is found by a recursive CTE, which starts with a path of length
   * zero at each possible start node and adds one relationship per step, never
   * one already on the path:
   *
   *     (WITH RECURSIVE p(s, t, d, path) AS (
   *        SELECT n.id, n.id, 0, <empty list> FROM nodes AS n WHERE n.id IN (<start>)
   *        UNION ALL
   *        SELECT p.s, e.end_id, p.d + 1, <path + e.id> FROM p JOIN edges AS e ON e.start_id = p.t
   *        WHERE p.d < <max> AND <e.id not on path> AND <type and property filters>
   *      ) SELECT s, t, path FROM p WHERE d >= <min>) AS v
   *
   * The CTE cannot refer to the outer query (SQLite has no LATERAL). So the
   * start nodes come from `start` (see `startNodes`): the same rows as the
   * outer query has before the pattern's end node joins, as a self-contained
   * query. Without one, the search starts at every node. The outer query joins
   * the CTE's start and end to `left` and `right`.
   */
  private matchVariableLength(
    rel: ast.RelationshipPattern,
    left: string,
    right: string,
    boundHere: Set<string>,
    withNodes: boolean,
    startNodes: string | undefined,
  ): Matched & { kind: 'list' } {
    const b = this.b;
    const d = b.dialect;
    this.checkListPattern(rel, boundHere);
    const min = rel.range!.min ?? 1;
    const max = rel.range!.max;
    const depth = b.bind({ kind: 'pathDepth', min, max, position: rel.position });
    if (!startNodes) {
      this.searchesEverything = true;
    }

    const v = this.alias('v');
    const p = `${v}p`;
    const n = this.alias('n');
    const e = this.alias('e');
    const nodeId = b.ident(b.mapping.nodes.id);
    const edges = b.columns('edges');
    const start = `${e}.${edges.startId}`;
    const end = `${e}.${edges.endId}`;
    let adjacent: string;
    let next: string;
    if (rel.direction === 'right') {
      adjacent = `${start} = ${p}.t`;
      next = end;
    } else if (rel.direction === 'left') {
      adjacent = `${end} = ${p}.t`;
      next = start;
    } else {
      // Either direction; a self-loop is followed once.
      adjacent = `(${start} = ${p}.t OR ${end} = ${p}.t)`;
      next = `CASE WHEN ${start} = ${p}.t THEN ${end} ELSE ${start} END`;
    }
    const step = [
      `${p}.d < ${depth}`,
      `NOT ${d.idListHas(`${p}.path`, `${e}.${edges.id}`)}`,
      ...this.relationshipFilters(rel, e),
    ];
    // A named path also needs the nodes along the way.
    const nodes = withNodes
      ? {
          column: ', nodes',
          empty: `, ${d.idListEmpty(b.table('nodes'), nodeId)}`,
          append: `, ${d.idListAppend(`${p}.nodes`, next)}`,
        }
      : { column: '', empty: '', append: '' };
    const cte =
      `WITH RECURSIVE ${p}(s, t, d, path${nodes.column}) AS (` +
      `SELECT ${n}.${nodeId}, ${n}.${nodeId}, 0, ${d.idListEmpty(edges.table, edges.id)}${nodes.empty} ` +
      `FROM ${b.table('nodes')} AS ${n}` +
      (startNodes ? ` WHERE ${n}.${nodeId} IN (${startNodes})` : '') +
      ` UNION ALL SELECT ${p}.s, ${next}, ${p}.d + 1, ${d.idListAppend(`${p}.path`, `${e}.${edges.id}`)}` +
      `${nodes.append} FROM ${p} JOIN ${edges.table} AS ${e} ON ${adjacent} WHERE ${step.join(' AND ')})` +
      ` SELECT s, t, path${nodes.column} FROM ${p} WHERE d >= ${min}`;
    return this.joinPaths(`(${cte}) AS ${v}`, v, rel, left, right, boundHere, withNodes);
  }

  /**
   * Matches `shortestPath((a)-[r*min..max]-(b))` (or allShortestPaths) between
   * the nodes `left` and `right` with a breadth-first search that runs as steps
   * before this statement:
   *
   * 1. A step selects every pair of nodes that `left` and `right` can be in the
   *    rows so far: the FROM and WHERE of this scope at this point, which
   *    include both nodes' filters. Later conditions of the MATCH cannot add
   *    pairs, so this is a superset of the pairs the statement joins.
   * 2. One step per depth selects the edges next to the frontier (see
   *    `shortestPaths` in src/search.ts).
   * 3. The statement reads the paths found from a bound JSON value and joins
   *    them like the paths of a variable-length pattern.
   */
  private matchShortestPath(
    rel: ast.RelationshipPattern,
    left: string,
    right: string,
    boundHere: Set<string>,
    kind: 'one' | 'all',
  ): Matched & { kind: 'list' } {
    const b = this.b;
    const d = b.dialect;
    this.checkListPattern(rel, boundHere);
    const nodeId = b.ident(b.mapping.nodes.id);
    const index = b.searchSteps.length;
    const pairs = finishSelect(
      b,
      this.selectBase([`${left}.${nodeId} AS s`, `${right}.${nodeId} AS t`], true),
      {},
    );

    const e = this.alias('e');
    const edges = b.columns('edges');
    const frontier = d.jsonInput(b.bind({ kind: 'frontier' }));
    const filters = this.relationshipFilters(rel, e);
    const half = (from: string, to: string): string =>
      `SELECT ${e}.${from} AS f, ${e}.${edges.id} AS r, ${e}.${to} AS t FROM ${edges.table} AS ${e} WHERE ` +
      [
        d.boundIdIn(`${e}.${from}`, frontier, b.table('nodes'), b.mapping.nodes.id),
        ...filters,
      ].join(' AND ');
    const halves =
      rel.direction === 'right'
        ? [half(edges.startId!, edges.endId!)]
        : rel.direction === 'left'
          ? [half(edges.endId!, edges.startId!)]
          : [half(edges.startId!, edges.endId!), half(edges.endId!, edges.startId!)];
    // Ordered, so that shortestPath picks the same path every time.
    const expand = finishSelect(b, `SELECT f, r, t FROM (${halves.join(' UNION ALL ')}) AS x`, {
      implicitOrder: ['r', 'f'],
    });

    b.searchSteps.push(
      b.finish(pairs, {
        search: {
          index,
          all: kind === 'all',
          min: rel.range!.min ?? 1,
          maxDepth: {
            kind: 'pathDepth',
            min: rel.range!.min ?? 1,
            max: rel.range!.max,
            position: rel.position,
          },
          expand: b.finish(expand),
        },
      }),
    );

    const v = this.alias('v');
    const found = d.boundPaths(
      d.jsonInput(b.bind({ kind: 'shortestPaths', search: index })),
      { table: b.table('nodes'), id: b.mapping.nodes.id },
      { table: edges.table, id: b.mapping.edges.id },
    );
    return this.joinPaths(`(${found}) AS ${v}`, v, rel, left, right, boundHere, true);
  }

  /**
   * Joins a derived table `v` of paths (columns s, t, path, and nodes when
   * `withNodes`) between the nodes `left` and `right`, and binds the pattern's
   * relationship variable to its id list.
   */
  private joinPaths(
    table: string,
    v: string,
    rel: ast.RelationshipPattern,
    left: string,
    right: string,
    boundHere: Set<string>,
    withNodes: boolean,
  ): Matched & { kind: 'list' } {
    const nodeId = this.b.ident(this.b.mapping.nodes.id);
    this.addFrom(table);
    this.order.push(`${v}.path`);
    this.where.push(`${v}.s = ${left}.${nodeId}`, `${v}.t = ${right}.${nodeId}`);
    const path = `${v}.path`;
    if (rel.variable !== undefined) {
      this.bindings.set(rel.variable, { kind: 'relationships', path });
      boundHere.add(rel.variable);
    }
    return { kind: 'list', path, nodes: withNodes ? `${v}.nodes` : undefined };
  }

  /** Checks the variable and inline properties of a variable-length relationship pattern. */
  private checkListPattern(rel: ast.RelationshipPattern, boundHere: Set<string>): void {
    const existing = rel.variable !== undefined ? this.find(rel.variable) : undefined;
    if (existing?.kind === 'node' || existing?.kind === 'relationship') {
      throw new SemanticError(`Variable \`${rel.variable}\` is not a list of relationships`, {
        position: rel.position,
      });
    }
    if (existing && boundHere.has(rel.variable!)) {
      throw new SemanticError(
        `Relationship variable \`${rel.variable}\` is used for more than one relationship in the same MATCH`,
        { position: rel.position },
      );
    }
    if (existing) {
      throw new UnsupportedFeatureError(
        `A variable-length pattern with the bound variable \`${rel.variable}\` is not supported yet`,
        { position: rel.position },
      );
    }
    if (rel.properties?.type === 'Map') {
      for (const { value } of rel.properties.entries) {
        if (freeVariables(value).length > 0) {
          throw new UnsupportedFeatureError(
            'Property values that use variables in a variable-length pattern are not supported yet',
            { position: value.position },
          );
        }
      }
    }
  }

  /** Condition: two relationship patterns of one MATCH bind different relationships. */
  private distinctRelationships(a: Matched, c: Matched): string {
    const d = this.b.dialect;
    const id = this.b.ident(this.b.mapping.edges.id);
    if (a.kind === 'one' && c.kind === 'one') {
      return `${a.alias}.${id} <> ${c.alias}.${id}`;
    }
    if (a.kind === 'list' && c.kind === 'list') {
      return `NOT ${d.idListsOverlap(a.path, c.path)}`;
    }
    if (a.kind === 'one' && c.kind === 'list') {
      return `NOT ${d.idListHas(c.path, `${a.alias}.${id}`)}`;
    }
    if (a.kind === 'list' && c.kind === 'one') {
      return `NOT ${d.idListHas(a.path, `${c.alias}.${id}`)}`;
    }
    throw new Error('Internal error: unexpected relationship kinds');
  }

  /**
   * Adds a filter `entity.k = v` for each entry of an inline property map
   * `{k: v}`, with Cypher equality (so a null or missing property never matches).
   */
  private matchProperties(
    entity: { kind: 'node' | 'relationship'; alias: string },
    properties: ast.Expression | undefined,
  ): void {
    this.where.push(...this.propertyFilters(entity, properties));
  }

  private propertyFilters(
    entity: { kind: 'node' | 'relationship'; alias: string },
    properties: ast.Expression | undefined,
  ): string[] {
    if (!properties) {
      return [];
    }
    if (properties.type !== 'Map') {
      throw new SemanticError('A parameter cannot be used as a property map in MATCH', {
        position: properties.position,
        hint: 'Write the properties out, for example (n {name: $name}).',
      });
    }
    const e = this.expressions;
    return properties.entries.map(({ key, value }) => {
      const condition = e.comparison('=', e.member(entity, key), e.compile(value));
      // Inline properties usually pick out few rows; telling the database lets it
      // start a pattern there even when no index serves the comparison. An
      // indexable comparison stays unwrapped, so that the index is used.
      return condition.indexable ? condition.sql : this.b.dialect.selective(condition.sql);
    });
  }

  private addUnwind(unwind: ast.UnwindClause): void {
    if (this.has(unwind.variable)) {
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

  /**
   * A pattern predicate, EXISTS, or pattern comprehension, as a correlated
   * subquery: a new scope matches the pattern (or runs the query) with the
   * variables visible here bound, through `find`, to this query's aliases and
   * values.
   *
   * - `(a)-->(b)` and `EXISTS { pattern WHERE c }`: `EXISTS (SELECT 1 FROM ... WHERE ...)`.
   *   A pattern predicate may not introduce variables.
   * - `EXISTS { MATCH ... RETURN ... }`: `EXISTS (<the query>)`.
   * - `[(a)-->(b) WHERE c | e]`: the JSON list of `e` over the matches.
   */
  private subquery(
    expr: ast.PatternPredicate | ast.ExistsSubquery | ast.PatternComprehension,
    find: (name: string) => Binding | undefined,
  ): Expr {
    const b = this.b;
    const sub = new ReadScope(b, { find, prefix: `q${b.nextSubquery()}_` });
    // The node-pair step of a search runs on its own, so it cannot refer to the
    // enclosing query.
    const noShortestPath = (pattern: ast.PatternPart[]): void => {
      const shortest = pattern.find((part) => part.shortest !== undefined);
      if (shortest) {
        throw new UnsupportedFeatureError(
          'shortestPath() inside EXISTS or a pattern comprehension is not supported yet',
          { position: shortest.position },
        );
      }
    };
    const match = (pattern: ast.PatternPart[], where: ast.Expression | undefined): void => {
      noShortestPath(pattern);
      sub.addMatch({ type: 'Match', position: expr.position, optional: false, pattern, where });
    };
    const exists = (sql: string): Expr => ({
      sql: `EXISTS (${sql})`,
      type: 'boolean',
      atomic: false,
    });

    switch (expr.type) {
      case 'PatternPredicate': {
        for (const name of patternVariables([expr.pattern])) {
          if (find(name) === undefined) {
            throw new SemanticError(`Variable \`${name}\` not defined`, {
              position: expr.position,
              hint: 'A pattern used as a condition cannot introduce variables; use EXISTS { ... } for that.',
            });
          }
        }
        match([expr.pattern], undefined);
        return exists(sub.selectBase(['1']));
      }
      case 'Exists': {
        if (expr.pattern) {
          match(expr.pattern, expr.where);
          return exists(sub.selectBase(['1']));
        }
        const clauses = expr.query!.clauses;
        const ret = clauses.at(-1);
        const reading = clauses.slice(0, -1);
        const other = reading.find(
          (c) => c.type !== 'Match' && c.type !== 'Unwind' && c.type !== 'With',
        );
        if (ret?.type !== 'Return' || other) {
          throw new UnsupportedFeatureError(
            'An EXISTS subquery may use only MATCH, UNWIND, and WITH, and must end with RETURN',
            { position: (other ?? ret ?? expr).position },
          );
        }
        for (const clause of reading) {
          if (clause.type === 'Match') {
            noShortestPath(clause.pattern);
          }
        }
        const scope = ReadScope.of(b, reading as ast.RowClause[], sub);
        return exists(planProjection(b, scope, ret, 'return').sql);
      }
      case 'PatternComprehension': {
        match([expr.pattern], expr.where);
        const value = sub.expressions.json(expr.projection);
        const list = b.dialect.jsonAggregate(value, {
          distinct: false,
          orderBy: sub.order,
          filter: b.dialect.booleanLiteral(true),
        });
        return { sql: `(${sub.selectBase([list])})`, type: 'json', atomic: false, shape: 'list' };
      }
    }
  }

  /** SQL of the dialect's JSON type for a non-entity expression. */
  public value(expr: ast.Expression): string {
    return this.expressions.json(expr);
  }

  /** `SELECT [DISTINCT] columns FROM ... WHERE ... [GROUP BY ...]` over this scope. */
  public selectBase(columns: string[], distinct = false, groupBy?: string[]): string {
    let sql = `SELECT ${distinct ? 'DISTINCT ' : ''}${columns.join(', ')}`;
    if (this.from.length > 0) {
      sql += ` FROM ${this.fromClause()}`;
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

/** A variable of the rows a write query wrote (see `PlanStep.written`). */
export interface WrittenVariable {
  name: string;
  /** Nodes and relationships are ids in the rows; other values are JSON. */
  kind: 'node' | 'relationship' | 'value';
}

/**
 * Plans the reading clauses and RETURN after the CREATE of a write query, over
 * the rows it wrote: a bound JSON array with one object per source row, in
 * source order. Entities are joined back by id, so created ones are read as
 * stored, and a MATCH there sees them.
 */
export function planWrittenReturn(
  b: SqlBuilder,
  variables: WrittenVariable[],
  reading: ast.RowClause[],
  ret: ast.ReturnClause,
): { step: PlanStep; columns: ColumnSpec[] } {
  const scope = ReadScope.of(b, reading, ReadScope.written(b, variables));
  const result = planProjection(b, scope, ret, 'return');
  return { step: b.finish(result.sql), columns: result.columns };
}

/** A projected value of a WITH stage: a column of the stage's derived table. */
type StageOutput =
  | { name: string; kind: 'node' | 'relationship' | 'relationships'; column: string }
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
    if (binding?.kind === 'relationships') {
      return { kind: 'relationships', path: binding.path };
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
  /** The relationships of a variable-length pattern, as an id list. */
  | { kind: 'relationships'; path: string }
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
      } else if (v.kind === 'relationships') {
        select.push(`${v.path} AS ${c}`);
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
    } else if (v.kind === 'relationships') {
      const list = d.entityList('relationship', v.path, b.columns('edges'));
      select.push(`${d.jsonText(list)} AS ${c}`);
      columns.push({ name: item.name, kind: 'json', column: c });
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
    // In a subquery, a key that uses only the enclosing query's variables is the
    // same in every row; SQLite cannot group by an outer column, so it is not grouped.
    const variables = freeVariables(expr);
    const grouped = variables.length === 0 || !variables.every((name) => scope.isOuter(name));
    const binding = expr.type === 'Variable' ? scope.lookup(expr) : undefined;
    if (binding?.kind === 'node' || binding?.kind === 'relationship') {
      const raw = entityColumns(b, binding.kind, (n) => `${binding.alias}.${b.ident(n)}`);
      const fields = Object.entries(raw).filter(([field]) => field !== 'kind');
      for (const [field, sql] of fields) {
        inner.push(`${sql} AS g${i}_${field}`);
        if (grouped) {
          groupBy.push(sql as string);
        }
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
    if (binding?.kind === 'relationships') {
      throw new UnsupportedFeatureError(
        `Grouping by the relationship list \`${item.name}\` of a variable-length pattern is not supported yet`,
        { position: expr.position },
      );
    }
    const e = scope.expressions.compile(expr);
    if (e.type === 'null') {
      outer.set(keyName(i), { kind: 'column', expr: e });
    } else {
      inner.push(`${e.sql} AS g${i}`);
      if (grouped) {
        groupBy.push(e.sql);
      }
      column(`g${i}`, e);
      outer.set(keyName(i), outer.get(`g${i}`)!);
    }
  });

  // Aggregates and properties of key variables become inner columns, referred
  // to by synthetic variables in the outer expressions.
  const extra = new Map<string, string>();
  const rewrite = (
    expr: ast.Expression,
    locals: ReadonlySet<string> = new Set(),
  ): ast.Expression => {
    const ref = (name: string): ast.Expression => ({
      type: 'Variable',
      position: expr.position,
      name,
    });
    if (freeVariables(expr).some((name) => locals.has(name))) {
      // Uses the element of an enclosing list comprehension or quantifier: not a
      // key or a value of the group. Its parts may still be.
      return mapChildren(expr, (child, local) => rewrite(child, withLocal(locals, local)));
    }
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
    return mapChildren(expr, (child, local) => rewrite(child, withLocal(locals, local)));
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

  let innerSql = scope.selectBase(inner.length > 0 ? inner : ['1 AS g'], false, groupBy);
  if (keys.length > 0 && groupBy.length === 0) {
    // Keys that are not grouped (see above) still mean no row for no input.
    innerSql += ' HAVING COUNT(*) > 0';
  }
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
  return children(expr).flatMap(({ child }) => aggregatesIn(child));
}

/** Replaces subexpressions equal to a projection item's expression with the item's name. */
function replaceProjected(expr: ast.Expression, items: ast.ProjectionItem[]): ast.Expression {
  const item = items.find(
    (i) => i.expression.type !== 'Variable' && sameExpression(i.expression, expr),
  );
  if (item) {
    return { type: 'Variable', position: expr.position, name: item.name };
  }
  return mapChildren(expr, (child, local) =>
    replaceProjected(
      child,
      // Inside a comprehension, the local names are not projected names, and an
      // item's expression that uses one means something else there.
      items.filter(
        (i) =>
          !local.includes(i.name) && !freeVariables(i.expression).some((n) => local.includes(n)),
      ),
    ),
  );
}

/**
 * Checks a `shortestPath(...)` or `allShortestPaths(...)` pattern part: one
 * variable-length relationship with a lower bound of 0 or 1. Conditions of the
 * MATCH's WHERE on the path or its relationships apply during the search in
 * Cypher, which the search here does not do, so they are rejected.
 */
function checkShortestPath(part: ast.PatternPart, where: ast.Expression | undefined): void {
  const name = part.shortest === 'all' ? 'allShortestPaths' : 'shortestPath';
  if (part.elements.length !== 3) {
    throw new SemanticError(`${name}() requires a pattern with exactly one relationship`, {
      position: part.position,
    });
  }
  const rel = part.elements[1] as ast.RelationshipPattern;
  if (!rel.range) {
    throw new UnsupportedFeatureError(
      `${name}() with a single relationship (no *) is not supported yet`,
      { position: rel.position, hint: 'Use a variable-length relationship, for example [*].' },
    );
  }
  if ((rel.range.min ?? 1) > 1) {
    throw new SemanticError(`${name}() requires a lower bound of 0 or 1`, {
      position: rel.position,
    });
  }
  const used = where ? freeVariables(where) : [];
  const variable = [part.variable, rel.variable].find((v) => v !== undefined && used.includes(v));
  if (variable !== undefined) {
    throw new UnsupportedFeatureError(
      `A WHERE that uses \`${variable}\` of ${name}() in the same MATCH is not supported yet`,
      {
        position: where!.position,
        hint:
          `Cypher applies such a condition during the search. To filter the paths found instead, ` +
          `use WITH ... WHERE after the MATCH.`,
      },
    );
  }
}

/**
 * The names of the variables an expression uses from outside it. The variables
 * of a pattern in an expression count (they refer to outer ones when bound),
 * except in an opaque `EXISTS { query }`.
 */
function freeVariables(expr: ast.Expression): string[] {
  if (expr.type === 'Variable') {
    return [expr.name];
  }
  const own =
    expr.type === 'PatternPredicate' || expr.type === 'PatternComprehension'
      ? patternVariables([expr.pattern])
      : expr.type === 'Exists' && expr.pattern
        ? patternVariables(expr.pattern)
        : [];
  const inner = children(expr).flatMap(({ child, local }) =>
    freeVariables(child).filter((name) => !local.includes(name)),
  );
  return [...new Set([...own, ...inner])];
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
function checkGroupedOnly(
  expr: ast.Expression,
  keys: ast.ProjectionItem[],
  locals: ReadonlySet<string> = new Set(),
): void {
  if (expr.type === 'CountStar' || (expr.type === 'FunctionCall' && isAggregateCall(expr))) {
    return;
  }
  const simple = expr.type === 'Variable' || expr.type === 'PropertyAccess';
  const root = rootVariable(expr);
  if (simple && root !== undefined && locals.has(root)) {
    // The element of a list comprehension or quantifier.
    return;
  }
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
  for (const { child, local } of children(expr)) {
    checkGroupedOnly(child, keys, withLocal(locals, local));
  }
}

/** Replaces variables that name a projection item with the item's expression. */
function substituteAliases(
  expr: ast.Expression,
  projected: Map<string, ast.Expression>,
): ast.Expression {
  if (expr.type === 'Variable') {
    return projected.get(expr.name) ?? expr;
  }
  return mapChildren(expr, (child, local) => {
    if (!local.some((name) => projected.has(name))) {
      return substituteAliases(child, projected);
    }
    const inner = new Map(projected);
    for (const name of local) {
      inner.delete(name);
    }
    return substituteAliases(child, inner);
  });
}

/**
 * After `RETURN DISTINCT`, ORDER BY may only use projected values: the names of
 * projection items, and expressions equal to a projected expression.
 */
function checkProjectedOnly(
  expr: ast.Expression,
  items: ast.ProjectionItem[],
  locals: ReadonlySet<string> = new Set(),
): void {
  if (items.some((item) => sameExpression(item.expression, expr))) {
    return;
  }
  if (expr.type === 'Variable') {
    if (!locals.has(expr.name) && !items.some((item) => item.name === expr.name)) {
      throw new SemanticError(
        `Variable \`${expr.name}\` is not available after RETURN DISTINCT; ORDER BY can only use projected values`,
        { position: expr.position },
      );
    }
    return;
  }
  for (const { child, local } of children(expr)) {
    checkProjectedOnly(child, items, withLocal(locals, local));
  }
}

function sameExpression(a: ast.Expression, b: ast.Expression): boolean {
  const text = (e: ast.Expression): string =>
    JSON.stringify(e, (key, value: unknown) =>
      key === 'position' ? undefined : typeof value === 'bigint' ? `${value}n` : value,
    );
  return text(a) === text(b);
}

/** The variable at the root of `v`, `v.a`, or `v.a.b`; undefined for other expressions. */
function rootVariable(expr: ast.Expression): string | undefined {
  if (expr.type === 'Variable') {
    return expr.name;
  }
  return expr.type === 'PropertyAccess' ? rootVariable(expr.subject) : undefined;
}

/** `locals` plus `local`, the variables a comprehension or pattern binds for a child. */
function withLocal(locals: ReadonlySet<string>, local: readonly string[]): ReadonlySet<string> {
  return local.length === 0 ? locals : new Set([...locals, ...local]);
}
