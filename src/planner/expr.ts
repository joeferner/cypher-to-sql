import type * as ast from '../ast.js';
import { ENTITY_TAG, type ScalarType } from '../dialect/dialect.js';
import { SemanticError, UnsupportedFeatureError, type SourcePosition } from '../errors.js';
import { TEMPORAL_KINDS } from '../temporal.js';
import { isTemporalArithmetic } from '../temporal-functions.js';
import { compileAggregate, isAggregateCall } from './aggregates.js';
import { compileFunction } from './functions.js';
import { constantValue, type SqlBuilder } from './sql-builder.js';

/**
 * Static type of a compiled expression:
 * - a native SQL value (`boolean`, `integer`, `float`, `string`),
 * - `json`: a value of the dialect's JSON type whose Cypher type is known only at
 *   run time (properties, parameters, unwound values), unless `shape` says so,
 * - `null`: the null literal,
 * - `node` / `relationship`: an entity; `sql` is the table alias.
 */
export type ExprType = ScalarType | 'json' | 'null' | 'node' | 'relationship';

/** What a JSON value is known to be at compile time. */
export type Shape = 'list' | 'map' | 'path';

export interface Expr {
  sql: string;
  type: ExprType;
  /** Cheap to repeat in SQL (a column, a bind value, a literal). */
  atomic: boolean;
  /** For `json`: the value is known to be a list, a map, or a path (or null). */
  shape?: Shape | undefined;
  /** For a query parameter (`$name`): its name and position. */
  parameter?: { name: string; position: SourcePosition } | undefined;
  /**
   * For a boolean: a comparison an index can serve. `ReadScope` then leaves it
   * unwrapped, so that the database sees it as one.
   */
  indexable?: boolean | undefined;
}

/**
 * One ORDER BY term. `nulls`: SQL NULL means a Cypher null, so it must sort last
 * ascending and first descending (other keys are NULL only for rows that an
 * earlier key already separates).
 */
export interface SortKey {
  sql: string;
  nulls: boolean;
}

/** An ORDER BY term as SQL. */
export function orderTerm(sql: string, key: SortKey, descending: boolean): string {
  const nulls = key.nulls ? (descending ? ' NULLS FIRST' : ' NULLS LAST') : '';
  return `${sql} ${descending ? 'DESC' : 'ASC'}${nulls}`;
}

/** An operand inside `share`: atomic, and for JSON with its run-time type as SQL. */
export interface Shared extends Expr {
  /** SQL text naming the JSON type (see `Dialect.jsonType`); only for `json`. */
  jsonType: string;
}

/** What a variable refers to, as the expression compiler needs it. */
export type VariableBinding =
  | { kind: 'node'; alias: string }
  | { kind: 'relationship'; alias: string }
  | { kind: 'value'; sql: string; shape?: Shape | undefined }
  /**
   * The relationships of a variable-length pattern (`[r*]`): `path` is the
   * dialect's id list of them (see `Dialect.idListEmpty`).
   */
  | { kind: 'relationships'; path: string }
  /** A column of a derived table whose type is known (the outer query of an aggregation). */
  | { kind: 'column'; expr: Expr };

type Comparison = ast.ComparisonOperator;

/** Numbers compare with each other; every other type only with itself. */
const NUMBER_TYPES = `('integer', 'float')`;

/** The JSON types of temporal values (their tags). */
const TEMPORAL_TYPES = `(${TEMPORAL_KINDS.map((k) => `'${k}'`).join(', ')})`;
const TEMPORAL_OR_DURATION = `(${[...TEMPORAL_KINDS, 'duration'].map((k) => `'${k}'`).join(', ')})`;

/**
 * Compiles Cypher expressions to SQL with Cypher semantics: three-valued logic,
 * null for comparisons of different types, integers and floats kept apart.
 * When both operand types are known at compile time the SQL is plain (and can
 * use indexes); otherwise it checks JSON types at run time.
 */
export class ExprCompiler {
  private aliases = 0;
  /** Compiled expressions by their AST, so that equal expressions get equal SQL. */
  private readonly compiled = new Map<string, Expr>();
  /**
   * Where aggregate functions may appear: not at all (`none`, for example in
   * WHERE), in the expressions being compiled (`allowed`, RETURN and its ORDER
   * BY), or not because we are inside one already (`inside`).
   */
  public aggregation: 'none' | 'allowed' | 'inside' = 'none';
  /**
   * The element variables of the list comprehensions and quantifiers being
   * compiled, innermost last. They hide variables of the same name.
   */
  private readonly locals: { name: string; binding: VariableBinding }[] = [];
  /**
   * Compiles a pattern predicate, EXISTS, or pattern comprehension: a
   * correlated subquery over the patterns, which the read planner builds.
   * `find` resolves the variables visible here (including list elements).
   */
  public subquery:
    | ((
        expr: ast.PatternPredicate | ast.ExistsSubquery | ast.PatternComprehension,
        find: (name: string) => VariableBinding | undefined,
      ) => Expr)
    | undefined;

  /**
   * @param lookup Resolves a variable of the enclosing scope; undefined when it
   *   is not defined.
   * @param prefix Starts the aliases this compiler makes, so that those of a
   *   nested subquery never hide the outer query's.
   */
  public constructor(
    public readonly b: SqlBuilder,
    private readonly lookup: (variable: ast.Variable) => VariableBinding | undefined,
    private readonly prefix = '',
  ) {}

  private nextAlias(): string {
    return `${this.prefix}${this.aliases++}`;
  }

  /** The binding of a variable visible here, or undefined. */
  public find(name: string, position: SourcePosition): VariableBinding | undefined {
    for (let i = this.locals.length - 1; i >= 0; i--) {
      const local = this.locals[i]!;
      if (local.name === name) {
        return local.binding;
      }
    }
    return this.lookup({ type: 'Variable', name, position });
  }

  private resolve(variable: ast.Variable): VariableBinding {
    const binding = this.find(variable.name, variable.position);
    if (!binding) {
      throw new SemanticError(`Variable \`${variable.name}\` not defined`, {
        position: variable.position,
      });
    }
    return binding;
  }

  /**
   * Runs `f` with `name` bound to the JSON value `sql`, an element of the list
   * `list`. When `list` is a list literal of literals of one type, the element
   * has that type, so that misuse is a compile-time type error.
   */
  private inScope<T>(name: string, list: ast.Expression, sql: string, f: () => T): T {
    const aggregation = this.aggregation;
    const type = literalElementType(list);
    this.locals.push({
      name,
      binding:
        type === undefined
          ? { kind: 'value', sql }
          : {
              kind: 'column',
              expr: { sql: this.b.dialect.fromJson(sql, type), type, atomic: false },
            },
    });
    // The gate rejects aggregates here; this keeps them from compiling regardless.
    this.aggregation = 'none';
    try {
      return f();
    } finally {
      this.locals.pop();
      this.aggregation = aggregation;
    }
  }

  /**
   * Compiles an expression. Equal expressions compile to the same SQL text (with
   * the same bind markers), which GROUP BY relies on, except when they call
   * rand(), whose calls must stay independent. Inside a list comprehension the
   * same expression can mean something else, so the cache key includes the
   * element variables in scope.
   */
  public compile(expr: ast.Expression): Expr {
    const base = expressionKey(expr);
    const key =
      base === undefined || this.locals.length === 0
        ? base
        : `${JSON.stringify(this.locals)}${base}`;
    const cached = key === undefined ? undefined : this.compiled.get(key);
    if (cached) {
      return cached;
    }
    const result = this.compileNew(expr);
    if (key !== undefined) {
      this.compiled.set(key, result);
    }
    return result;
  }

  private compileNew(expr: ast.Expression): Expr {
    const b = this.b;
    switch (expr.type) {
      case 'Literal':
        return this.literal(expr.value);
      case 'List':
      case 'Map':
      case 'Parameter': {
        const shape = expr.type === 'List' ? 'list' : expr.type === 'Map' ? 'map' : undefined;
        const reserved =
          expr.type === 'Map' ? expr.entries.find((e) => e.key === ENTITY_TAG) : undefined;
        if (reserved) {
          throw new SemanticError(`The map key ${JSON.stringify(ENTITY_TAG)} is reserved`, {
            position: reserved.value.position,
          });
        }
        const constant = constantValue(expr);
        if (constant) {
          const sql = b.dialect.jsonInput(b.bind({ kind: 'json', value: constant }));
          const parameter =
            constant.kind === 'parameter'
              ? { name: constant.name, position: constant.position }
              : undefined;
          return { sql, type: 'json', atomic: true, shape, parameter };
        }
        if (expr.type === 'List') {
          const sql = b.dialect.jsonArray(expr.items.map((item) => this.json(item)));
          return { sql, type: 'json', atomic: false, shape };
        }
        const map = expr as ast.MapExpression;
        const sql = b.dialect.jsonObject(
          map.entries.map(({ key, value }) => ({
            keyPlaceholder: b.bind({ kind: 'sql', value: key }),
            value: this.json(value),
          })),
        );
        return { sql, type: 'json', atomic: false, shape };
      }
      case 'MapProjection': {
        let sql = this.json(expr.base);
        for (const { key, value } of expr.entries) {
          if (key === ENTITY_TAG) {
            throw new SemanticError(`The map key ${JSON.stringify(ENTITY_TAG)} is reserved`, {
              position: value.position,
            });
          }
          sql = b.dialect.jsonSetKey(
            sql,
            b.bind({ kind: 'sql', value: key }),
            key,
            this.json(value),
          );
        }
        return { sql, type: 'json', atomic: false, shape: 'map' };
      }
      case 'Variable': {
        const binding = this.resolve(expr);
        if (binding.kind === 'value') {
          return { ...json(binding.sql, /^[\w."]+$/.test(binding.sql)), shape: binding.shape };
        }
        if (binding.kind === 'column') {
          return binding.expr;
        }
        if (binding.kind === 'relationships') {
          const sql = b.dialect.entityList('relationship', binding.path, b.columns('edges'));
          return { sql, type: 'json', atomic: false, shape: 'list' };
        }
        return { sql: binding.alias, type: binding.kind, atomic: true };
      }
      case 'PropertyAccess':
        return this.property(expr);
      case 'HasLabels':
        return this.hasLabels(expr);
      case 'Not':
        return boolean(`(NOT ${this.toBoolean(this.compile(expr.operand), expr.operand)})`);
      case 'IsNull':
        return this.isNull(expr);
      case 'Negate':
        return this.negate(expr);
      case 'Binary':
        return this.binary(expr);
      case 'FunctionCall': {
        if (isAggregateCall(expr)) {
          return compileAggregate(this, expr);
        }
        const name = expr.name.toLowerCase();
        const path = expr.args.length === 1 ? this.relationshipList(expr.args[0]!) : undefined;
        if (path !== undefined && name === 'size') {
          return { sql: b.dialect.idListLength(path), type: 'integer', atomic: false };
        }
        return compileFunction(this, expr);
      }
      case 'CountStar':
        return compileAggregate(this, expr);
      case 'Index':
        return this.index(expr);
      case 'Slice':
        return this.slice(expr);
      case 'ListComprehension':
        return this.comprehension(expr);
      case 'Quantifier':
        return this.quantifier(expr);
      case 'Case':
        return this.caseExpression(expr);
      case 'PatternPredicate':
      case 'Exists':
      case 'PatternComprehension':
        if (!this.subquery) {
          throw new UnsupportedFeatureError(
            'Patterns in expressions are not supported here (after aggregation)',
            { position: expr.position },
          );
        }
        return this.subquery(expr, (name) => this.find(name, expr.position));
      case 'UnsupportedExpression':
        throw new UnsupportedFeatureError(`${expr.description} are not supported yet`, {
          position: expr.position,
        });
    }
  }

  /** Drops compiled expressions, after a variable is bound to something else. */
  public forget(): void {
    this.compiled.clear();
  }

  /** The id list, when the expression is a variable bound to the relationships of a variable-length pattern. */
  public relationshipList(expr: ast.Expression): string | undefined {
    if (expr.type !== 'Variable') {
      return undefined;
    }
    const binding = this.resolve(expr);
    return binding.kind === 'relationships' ? binding.path : undefined;
  }

  /** The expression as a value of the dialect's JSON type. */
  public json(expr: ast.Expression): string {
    return this.toJson(this.compile(expr));
  }

  /** The expression as a WHERE condition. */
  public condition(expr: ast.Expression): string {
    return this.toBoolean(this.compile(expr), expr);
  }

  /** `entity.key`, read with its declared type if the mapping declares one. */
  public member(entity: { kind: 'node' | 'relationship'; alias: string }, key: string): Expr {
    const b = this.b;
    const table = b.mapping[entity.kind === 'node' ? 'nodes' : 'edges'];
    const column = `${entity.alias}.${b.ident(table.properties)}`;
    const declared = table.propertyTypes?.[key];
    if (declared) {
      // Dates and date-times are ISO 8601 strings.
      const type: ScalarType = declared === 'date' || declared === 'datetime' ? 'string' : declared;
      return { sql: b.dialect.typedMember(column, key, type), type, atomic: true };
    }
    return json(b.dialect.jsonMember(column, b.bind({ kind: 'sql', value: key }), key), true);
  }

  /** Cypher `left <op> right` as a boolean. */
  public comparison(operator: Comparison, left: Expr, right: Expr): Expr {
    return this.compare(operator, left, right, 0);
  }

  /**
   * ORDER BY terms that sort a value in Cypher's order: across types
   * map < node < relationship < list < string < boolean < number < null
   * (ascending; descending reverses it, so nulls come first), and within a type
   * by value. Lists sort element by element (see `listSortKey`); maps and
   * entities by their JSON text. Apply a direction with `orderTerm`.
   */
  public sortKeys(e: Expr): SortKey[] {
    const d = this.b.dialect;
    switch (e.type) {
      case 'null':
        return [];
      case 'node':
      case 'relationship': {
        const table = this.b.mapping[e.type === 'node' ? 'nodes' : 'edges'];
        return [{ sql: `${e.sql}.${this.b.ident(table.id)}`, nulls: true }];
      }
      case 'string':
        return [{ sql: d.orderString(e.sql), nulls: true }];
      case 'json': {
        // The expression is repeated in each key; ORDER BY has no way to share it.
        const t = d.jsonType(e.sql);
        const when = (types: string, value: string): SortKey => ({
          sql: `(CASE WHEN ${t} IN ${types} THEN ${value} END)`,
          nulls: false,
        });
        return [
          {
            // Null (and a missing property) ranks last.
            sql:
              `(CASE ${t} WHEN 'map' THEN 1 WHEN 'node' THEN 2 WHEN 'relationship' THEN 3 ` +
              `WHEN 'list' THEN 4 WHEN 'path' THEN 5 WHEN 'datetime' THEN 6 ` +
              `WHEN 'localdatetime' THEN 7 WHEN 'date' THEN 8 WHEN 'time' THEN 9 ` +
              `WHEN 'localtime' THEN 10 WHEN 'duration' THEN 11 WHEN 'string' THEN 12 ` +
              `WHEN 'boolean' THEN 13 WHEN 'integer' THEN 14 WHEN 'float' THEN 14 ELSE 99 END)`,
            nulls: false,
          },
          // Temporal values of one kind by instant (their sort key).
          when(
            TEMPORAL_TYPES,
            d.orderString(
              d.fromJson(
                d.jsonMember(e.sql, this.b.bind({ kind: 'sql', value: '~k' }), '~k'),
                'string',
              ),
            ),
          ),
          when(NUMBER_TYPES, d.fromJson(e.sql, 'number')),
          when(`('string')`, d.orderString(d.fromJson(e.sql, 'string'))),
          when(`('boolean')`, d.fromJson(e.sql, 'boolean')),
          {
            // Lists element by element; maps and entities by their JSON text.
            sql:
              `(CASE WHEN ${t} = 'list' THEN ${d.orderString(this.listSortKey(e.sql))} ` +
              `WHEN ${t} IN ('map', 'node', 'relationship', 'path') ` +
              `THEN ${d.orderString(d.jsonText(e.sql))} END)`,
            nulls: false,
          },
        ];
      }
      default:
        return [{ sql: e.sql, nulls: true }];
    }
  }

  /**
   * A text key that sorts JSON lists in Cypher's order: element by element (each
   * by type rank, then value), a list that is a prefix of another first. Each
   * element is a type letter (map B, node C, relationship D, list E, path F,
   * string G, boolean H, number I, null J) and its value; the list ends in `A`,
   * which is below every type letter. Nested lists, maps, and entities inside
   * the list use their JSON text, so they are not in Cypher's order among
   * themselves. Numbers are compared as floats.
   */
  private listSortKey(list: string): string {
    const d = this.b.dialect;
    const u = d.unwind(list, `lk${this.nextAlias()}`);
    const v = 'lkv.v';
    const t = 'lkv.t';
    const element =
      `(CASE WHEN ${t} IN ${NUMBER_TYPES} THEN 'I' || ${d.sortableNumber(d.fromJson(v, 'float'))} ` +
      `WHEN ${t} = 'string' THEN 'G' || ${d.sortableString(d.fromJson(v, 'string'))} ` +
      `WHEN ${t} = 'boolean' THEN 'H' || (CASE WHEN ${d.fromJson(v, 'boolean')} THEN '1' ELSE '0' END) ` +
      `WHEN ${t} = 'null' THEN 'J' ` +
      `ELSE (CASE ${t} WHEN 'map' THEN 'B' WHEN 'node' THEN 'C' WHEN 'relationship' THEN 'D' ` +
      `WHEN 'list' THEN 'E' ELSE 'F' END) || ${d.sortableString(d.jsonText(v))} END)`;
    return (
      `(SELECT COALESCE(${d.stringAggregate(element, ['lkv.o'])}, '') || 'A' ` +
      `FROM (SELECT ${u.value} AS v, ${d.jsonType(u.value)} AS t, ${u.order} AS o FROM ${u.from}` +
      `${u.where ? ` WHERE ${u.where}` : ''}) AS lkv)`
    );
  }

  // ---- values ------------------------------------------------------------------

  private literal(value: ast.Literal['value']): Expr {
    const b = this.b;
    if (value === null) {
      return { sql: 'NULL', type: 'null', atomic: true };
    }
    if (typeof value === 'boolean') {
      return { sql: b.dialect.booleanLiteral(value), type: 'boolean', atomic: true };
    }
    const type =
      typeof value === 'bigint' ? 'integer' : typeof value === 'number' ? 'float' : 'string';
    return {
      sql: b.dialect.typedPlaceholder(b.bind({ kind: 'sql', value }), type),
      type,
      atomic: true,
    };
  }

  private property(expr: ast.PropertyAccess): Expr {
    const subject = this.compile(expr.subject);
    switch (subject.type) {
      case 'node':
      case 'relationship':
        return this.member({ kind: subject.type, alias: subject.sql }, expr.key);
      case 'json':
        if (subject.shape === 'list' || subject.shape === 'path') {
          throw typeError('a map, node, or relationship', subject.shape, expr.subject.position);
        }
        return json(
          this.b.dialect.jsonMember(
            subject.sql,
            this.b.bind({ kind: 'sql', value: expr.key }),
            expr.key,
          ),
          subject.atomic,
        );
      case 'null':
        return subject;
      default:
        throw typeError('a map, node, or relationship', subject.type, expr.subject.position);
    }
  }

  /** The value as the dialect's JSON type. */
  public toJson(e: Expr): string {
    switch (e.type) {
      case 'json':
        return e.sql;
      case 'null':
        // Typed, so that PostgreSQL can resolve JSON functions applied to it.
        return this.b.dialect.jsonInput('NULL');
      case 'node':
      case 'relationship':
        return this.b.entityJson(e.type, e.sql);
      default:
        return this.b.dialect.toJson(e.sql, e.type);
    }
  }

  /** The value as a JSON expression. */
  public asJson(e: Expr): Expr {
    if (e.type === 'json') {
      return e;
    }
    // An entity's object is built from several columns: not cheap to repeat.
    const entity = e.type === 'node' || e.type === 'relationship';
    return json(this.toJson(e), e.atomic && !entity);
  }

  /**
   * Runs `body` with the operands made cheap to repeat, and with the run-time
   * type of each JSON operand computed once: anything that is not atomic, and
   * the types, are computed in a scalar subquery and referred to by column.
   */
  public share(exprs: Expr[], body: (shared: Shared[]) => string): string {
    const d = this.b.dialect;
    const alias = `s${this.nextAlias()}`;
    const values: string[] = [];
    const outer: string[] = [];
    const refs = exprs.map((e, i): Shared => {
      let inner = e.sql;
      let sql = e.sql;
      if (!e.atomic) {
        values.push(`${e.sql} AS v${i}`);
        inner = `x.v${i}`;
        outer.push(`x.v${i} AS v${i}`);
        sql = `${alias}.v${i}`;
      }
      let jsonType = '';
      if (e.type === 'json') {
        outer.push(`${d.jsonType(inner)} AS t${i}`);
        jsonType = `${alias}.t${i}`;
      }
      return { ...e, sql, atomic: true, jsonType };
    });
    const result = body(refs);
    if (outer.length === 0) {
      return result;
    }
    const fence = d.noFlatten;
    const from = values.length > 0 ? ` FROM (SELECT ${values.join(', ')}${fence}) AS x` : '';
    return `(SELECT ${result} FROM (SELECT ${outer.join(', ')}${from}${fence}) AS ${alias})`;
  }

  // ---- booleans ----------------------------------------------------------------

  /** A boolean SQL expression for a Cypher boolean (null when unknown). */
  private toBoolean(e: Expr, source: { position: SourcePosition }): string {
    const d = this.b.dialect;
    switch (e.type) {
      case 'boolean':
        return e.sql;
      case 'null':
        return d.booleanLiteral(null);
      case 'json':
        if (e.shape) {
          throw typeError('a boolean', e.shape, source.position);
        }
        return this.share(
          [e],
          ([j]) =>
            `(CASE WHEN ${j!.jsonType} = 'boolean' THEN ${d.fromJson(j!.sql, 'boolean')} ` +
            `WHEN ${isNullType(j!.jsonType)} THEN NULL ` +
            `ELSE ${this.b.typeError('Type mismatch: expected a boolean', source.position, 'boolean')} END)`,
        );
      default:
        throw typeError('a boolean', e.type, source.position);
    }
  }

  private hasLabels(expr: ast.HasLabelsExpression): Expr {
    const subject = this.compile(expr.subject);
    if (subject.type === 'null') {
      return boolean(this.b.dialect.booleanLiteral(null));
    }
    const b = this.b;
    if (subject.type === 'json' && subject.shape === undefined) {
      // A node held in a JSON value: check its `~labels`; null gives null, and
      // any other value is a type error.
      return boolean(
        this.share([subject], ([s]) => {
          const labels = b.dialect.jsonMember(
            s!.sql,
            b.bind({ kind: 'sql', value: '~labels' }),
            '~labels',
          );
          const checks = expr.labels
            .map((l) => b.dialect.hasLabel(labels, b.bind({ kind: 'sql', value: l })))
            .join(' AND ');
          return (
            `(CASE WHEN ${s!.jsonType} = 'node' THEN (${checks}) ` +
            `WHEN ${isNullType(s!.jsonType)} THEN NULL ` +
            `ELSE ${b.typeError('Type mismatch: a label predicate needs a node', expr.position, 'boolean')} END)`
          );
        }),
      );
    }
    if (subject.type !== 'node') {
      throw new UnsupportedFeatureError('Label predicates are supported on nodes only', {
        position: expr.position,
      });
    }
    const labels = `${subject.sql}.${b.ident(b.mapping.nodes.labels)}`;
    const checks = expr.labels
      .map((l) => b.dialect.hasLabel(labels, b.bind({ kind: 'sql', value: l })))
      .join(' AND ');
    // A null node (from OPTIONAL MATCH) has no labels column: the answer is null.
    const id = `${subject.sql}.${b.ident(b.mapping.nodes.id)}`;
    return boolean(`(CASE WHEN ${id} IS NULL THEN NULL ELSE (${checks}) END)`);
  }

  private isNull(expr: ast.IsNullExpression): Expr {
    const d = this.b.dialect;
    const path = this.relationshipList(expr.operand);
    if (path !== undefined) {
      return boolean(`(${path} IS ${expr.negated ? 'NOT ' : ''}NULL)`);
    }
    const e = this.compile(expr.operand);
    let sql: string;
    switch (e.type) {
      case 'null':
        sql = d.booleanLiteral(true);
        break;
      case 'json':
        sql = d.jsonIsNull(e.sql);
        break;
      case 'node':
      case 'relationship': {
        const table = this.b.mapping[e.type === 'node' ? 'nodes' : 'edges'];
        sql = `(${e.sql}.${this.b.ident(table.id)} IS NULL)`;
        break;
      }
      default:
        sql = `(${e.sql} IS NULL)`;
    }
    return boolean(expr.negated ? `(NOT ${sql})` : sql);
  }

  private binary(expr: ast.BinaryExpression): Expr {
    const left = this.compile(expr.left);
    const right = this.compile(expr.right);
    switch (expr.operator) {
      case 'AND':
      case 'OR':
        return boolean(
          `(${this.toBoolean(left, expr.left)} ${expr.operator} ${this.toBoolean(right, expr.right)})`,
        );
      case 'XOR':
        // `<>` on booleans is XOR, and null when either side is null.
        return boolean(
          `(${this.toBoolean(left, expr.left)} <> ${this.toBoolean(right, expr.right)})`,
        );
      case '=':
      case '<>':
      case '<':
      case '<=':
      case '>':
      case '>=':
        return this.compare(expr.operator, left, right, 0);
      case 'STARTS WITH':
      case 'ENDS WITH':
      case 'CONTAINS':
      case '=~':
        return this.stringPredicate(expr.operator, left, right, expr.position);
      case 'IN':
        return this.inList(left, right, expr);
      default:
        return this.arithmetic(expr.operator, left, right, expr);
    }
  }

  // ---- comparison --------------------------------------------------------------

  /**
   * Cypher comparison. Null on either side gives null; numbers compare by value;
   * values of different types are unequal and unordered (null for `<` and the
   * like). Lists compare element by element for `=` and `<>` (lists nested in
   * lists compare as JSON); ordering of lists and maps is null.
   */
  private compare(op: Comparison, left: Expr, right: Expr, depth: number): Expr {
    const d = this.b.dialect;
    const unknown = d.booleanLiteral(null);
    if (left.type === 'null' || right.type === 'null') {
      return boolean(unknown);
    }
    /** Result for two non-null values of different types. */
    const mismatch =
      op === '=' ? d.booleanLiteral(false) : op === '<>' ? d.booleanLiteral(true) : unknown;

    const entities = ['node', 'relationship'];
    if (entities.includes(left.type) || entities.includes(right.type)) {
      if (left.type === 'json' || right.type === 'json') {
        // Compared as values: entities in JSON are equal when their objects are.
        return this.compare(op, this.asJson(left), this.asJson(right), depth);
      }
      if (left.type !== right.type) {
        if (entities.includes(left.type) && entities.includes(right.type)) {
          return boolean(mismatch);
        }
        return boolean(
          this.share([left, right], ([l, r]) => {
            const [entity, other] = entities.includes(left.type) ? [l!, r!] : [r!, l!];
            const table = this.b.mapping[entity.type === 'node' ? 'nodes' : 'edges'];
            const id = `${entity.sql}.${this.b.ident(table.id)}`;
            return `(CASE WHEN ${id} IS NULL OR ${other.sql} IS NULL THEN NULL ELSE ${mismatch} END)`;
          }),
        );
      }
      if (op !== '=' && op !== '<>') {
        return boolean(unknown);
      }
      const table = this.b.mapping[left.type === 'node' ? 'nodes' : 'edges'];
      const id = this.b.ident(table.id);
      return boolean(`(${left.sql}.${id} ${op} ${right.sql}.${id})`);
    }

    if (left.type !== 'json' && right.type !== 'json') {
      const cls = typeClass(left.type);
      if (cls === typeClass(right.type)) {
        return boolean(this.compareSame(op, left.sql, right.sql, cls));
      }
      return boolean(
        this.share(
          [left, right],
          ([l, r]) =>
            `(CASE WHEN ${l!.sql} IS NULL OR ${r!.sql} IS NULL THEN NULL ELSE ${mismatch} END)`,
        ),
      );
    }

    const parameter = left.parameter ? left : right.parameter ? right : undefined;
    const known = parameter === left ? right : left;
    if (
      parameter &&
      op !== '<>' &&
      (known.type === 'string' || known.type === 'integer' || known.type === 'float')
    ) {
      return this.compareParameter(op, known, parameter, parameter === left);
    }

    if (left.type !== 'json' || right.type !== 'json') {
      // One side's type is known: check the other's at run time.
      const scalarSide = left.type === 'json' ? right : left;
      const cls = typeClass(scalarSide.type);
      const types = cls === 'number' ? NUMBER_TYPES : `('${cls}')`;
      return boolean(
        this.share([left, right], ([l, r]) => {
          const [j, s] = left.type === 'json' ? [l!, r!] : [r!, l!];
          const value = d.fromJson(j.sql, cls);
          const [ls, rs] = left.type === 'json' ? [value, s.sql] : [s.sql, value];
          return (
            `(CASE WHEN ${j.jsonType} IS NULL OR ${j.jsonType} = 'null' OR ${s.sql} IS NULL THEN NULL ` +
            `WHEN ${j.jsonType} IN ${types} THEN ${this.compareSame(op, ls, rs, cls)} ` +
            `ELSE ${mismatch} END)`
          );
        }),
      );
    }

    return boolean(
      this.share([left, right], ([l, r]) => {
        const lt = l!.jsonType;
        const rt = r!.jsonType;
        const same = (cls: 'string' | 'boolean'): string =>
          this.compareSame(op, d.fromJson(l!.sql, cls), d.fromJson(r!.sql, cls), cls);
        const sortKey = (j: string): string =>
          d.fromJson(d.jsonMember(j, this.b.bind({ kind: 'sql', value: '~k' }), '~k'), 'string');
        let structured: string;
        if (op === '=' || op === '<>') {
          const equal = d.jsonDeepEquals(l!.sql, r!.sql);
          structured = op === '=' ? equal : `(NOT ${equal})`;
        } else {
          // Lists order lexicographically (top level only); maps are unordered.
          const lists = depth === 0 ? this.listOrder(op, l!.sql, r!.sql) : unknown;
          structured = `(CASE WHEN ${lt} = 'list' THEN ${lists} END)`;
        }
        return (
          `(CASE WHEN ${lt} IS NULL OR ${lt} = 'null' OR ${rt} IS NULL OR ${rt} = 'null' THEN NULL ` +
          `WHEN ${lt} IN ${NUMBER_TYPES} AND ${rt} IN ${NUMBER_TYPES} THEN ` +
          `${d.fromJson(l!.sql, 'number')} ${op} ${d.fromJson(r!.sql, 'number')} ` +
          `WHEN ${lt} <> ${rt} THEN ${mismatch} ` +
          // Temporal values of one kind compare by their sort key (by instant).
          `WHEN ${lt} IN ${TEMPORAL_TYPES} THEN ${d.compareStrings(sortKey(l!.sql), op, sortKey(r!.sql))} ` +
          `WHEN ${lt} = 'string' THEN ${same('string')} ` +
          `WHEN ${lt} = 'boolean' THEN ${same('boolean')} ` +
          `ELSE ${structured} END)`
        );
      }),
    );
  }

  /**
   * A native value (typically a declared property) compared with a query
   * parameter, as plain SQL an index can serve:
   *
   *     known op ?value AND (?fits = 1 OR (known IS NULL AND NULL))
   *
   * The plan runner binds `?value` as the parameter converted to the known
   * type, and `?fits` as whether its type fits (see `parameterAs` in plan.ts).
   * The second conjunct keeps Cypher's result for a parameter of another type:
   * false for `=` (null when `known` is null), null for an ordering.
   */
  private compareParameter(
    op: Exclude<Comparison, '<>'>,
    known: Expr,
    parameter: Expr,
    parameterOnLeft: boolean,
  ): Expr {
    const b = this.b;
    const d = b.dialect;
    const type = known.type as 'string' | 'integer' | 'float';
    // With the parameter on the left, flip the operator: `$min < n.age` is `n.age > $min`.
    const flipped = { '=': '=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' } as const;
    const columnOp = parameterOnLeft ? flipped[op] : op;
    const { name, position } = parameter.parameter!;
    const bind = { name, position, type, op: columnOp };
    const value = d.typedPlaceholder(b.bind({ kind: 'parameterAs', ...bind }), type);
    const fits = d.typedPlaceholder(b.bind({ kind: 'parameterFits', ...bind }), 'integer');
    // A known value that is not atomic is computed once in a subquery, which no
    // index can serve; an atomic one (a declared property) stays plain.
    const sql = this.share([known], ([k]) => {
      const comparison = this.compareSame(columnOp, k!.sql, value, typeClass(type));
      const unknown = d.booleanLiteral(null);
      return `(${comparison} AND (${fits} = 1 OR (${k!.sql} IS NULL AND ${unknown})))`;
    });
    return { ...boolean(sql), indexable: known.atomic };
  }

  /** Comparison of two non-null native values of the same class. */
  private compareSame(op: Comparison, left: string, right: string, cls: TypeClass): string {
    return cls === 'string'
      ? this.b.dialect.compareStrings(left, op, right)
      : `(${left} ${op} ${right})`;
  }

  /**
   * Lexicographic `<`, `<=`, `>`, `>=` on two JSON lists (cheap to repeat): the
   * first pair of elements that are not equal decides (null if that pair is
   * null or unordered); if one list is a prefix of the other, the lengths decide.
   */
  private listOrder(op: Comparison, left: string, right: string): string {
    const d = this.b.dialect;
    const n = this.nextAlias();
    const a = d.unwind(left, `la${n}`);
    const z = d.unwind(right, `lb${n}`);
    const ea = json(a.value, false);
    const ez = json(z.value, false);
    const eq = this.compare('=', ea, ez, 1).sql;
    const cmp = this.compare(op, ea, ez, 1).sql;
    const where = [`${a.order} = ${z.order}`, a.where, z.where].filter(Boolean).join(' AND ');
    // 1 = true, 0 = false, 2 = null.
    const decided =
      `(SELECT CASE WHEN q.eq IS NULL OR q.cmp IS NULL THEN 2 WHEN q.cmp THEN 1 ELSE 0 END ` +
      `FROM (SELECT ${a.order} AS k, ${eq} AS eq, ${cmp} AS cmp FROM ${a.from} CROSS JOIN ${z.from} ` +
      `WHERE ${where}${d.noFlatten}) AS q WHERE NOT COALESCE(q.eq, ${d.booleanLiteral(false)}) ` +
      `ORDER BY q.k LIMIT 1)`;
    const lengths = `CASE WHEN ${d.listLength(left)} ${op} ${d.listLength(right)} THEN 1 ELSE 0 END`;
    return (
      `(CASE COALESCE(${decided}, ${lengths}) WHEN 1 THEN ${d.booleanLiteral(true)} ` +
      `WHEN 0 THEN ${d.booleanLiteral(false)} END)`
    );
  }

  /**
   * Three-valued aggregate over the boolean column `column` of the rows:
   * `any` is true if any row is true, `all` is false if any row is false;
   * otherwise null if any row is null.
   */
  private anyAll(column: string, kind: 'any' | 'all'): string {
    const d = this.b.dialect;
    const decisive = kind === 'any' ? column : `NOT ${column}`;
    return (
      `CASE WHEN SUM(CASE WHEN ${decisive} THEN 1 ELSE 0 END) > 0 THEN ${d.booleanLiteral(kind === 'any')} ` +
      `WHEN SUM(CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END) > 0 THEN NULL ` +
      `ELSE ${d.booleanLiteral(kind !== 'any')} END`
    );
  }

  private inList(left: Expr, right: Expr, expr: ast.BinaryExpression): Expr {
    const d = this.b.dialect;
    if (right.type === 'null') {
      return boolean(d.booleanLiteral(null));
    }
    if (right.type !== 'json' || right.shape === 'map') {
      throw typeError('a list', right.shape ?? right.type, expr.right.position);
    }
    return boolean(
      this.share([left, right], ([l, r]) => {
        const n = this.nextAlias();
        const e = d.unwind(r!.sql, `in${n}`);
        const eq = this.compare('=', l!, json(e.value, false), 0).sql;
        return (
          `(CASE WHEN ${isNullType(r!.jsonType)} THEN NULL ` +
          `WHEN ${r!.jsonType} <> 'list' THEN ${this.b.typeError('Type mismatch: IN needs a list', expr.right.position, 'boolean')} ` +
          `ELSE (SELECT ${this.anyAll('eq', 'any')} FROM (SELECT ${eq} AS eq FROM ${e.from}` +
          `${e.where ? ` WHERE ${e.where}` : ''}) AS q${n}) END)`
        );
      }),
    );
  }

  private stringPredicate(
    op: ast.StringOperator,
    left: Expr,
    right: Expr,
    position: SourcePosition,
  ): Expr {
    const d = this.b.dialect;
    const regexMatch = d.regexMatch;
    if (op === '=~' && !regexMatch) {
      throw new UnsupportedFeatureError(`=~ is not supported on ${d.name} without its functions`, {
        position,
        hint:
          'Register them with registerSqliteFunctions(db) and use sqlite({ functions: true }), ' +
          'or use STARTS WITH, ENDS WITH, or CONTAINS.',
      });
    }
    const apply = (s: string, p: string): string =>
      op === 'STARTS WITH'
        ? d.startsWith(s, p)
        : op === 'ENDS WITH'
          ? d.endsWith(s, p)
          : op === '=~'
            ? regexMatch!(s, p)
            : d.contains(s, p);
    if (left.type === 'string' && right.type === 'string') {
      return boolean(this.share([left, right], ([l, r]) => apply(l!.sql, r!.sql)));
    }
    if (left.type !== 'json' && right.type !== 'json') {
      // Null, or not strings: null in Cypher.
      return boolean(d.booleanLiteral(null));
    }
    return boolean(
      this.share(
        [this.asJson(left), this.asJson(right)],
        ([l, r]) =>
          `(CASE WHEN ${l!.jsonType} = 'string' AND ${r!.jsonType} = 'string' ` +
          `THEN ${apply(d.fromJson(l!.sql, 'string'), d.fromJson(r!.sql, 'string'))} END)`,
      ),
    );
  }

  // ---- CASE --------------------------------------------------------------------

  /**
   * `CASE`. The generic form takes the first branch whose condition is true (a
   * null condition is not). The simple form compares the subject with each
   * value using Cypher equality, so a null subject or value matches nothing.
   * When all branches that are not the null literal have one native type, the
   * result has it; otherwise every branch is JSON.
   */
  private caseExpression(expr: ast.CaseExpression): Expr {
    const d = this.b.dialect;
    const results = [
      ...expr.alternatives.map((a) => a.then),
      ...(expr.otherwise ? [expr.otherwise] : []),
    ].map((e) => this.compile(e));
    const typed = results.filter((r) => r.type !== 'null');
    if (typed.length === 0) {
      return { sql: 'NULL', type: 'null', atomic: true };
    }
    const first = typed[0]!;
    const native =
      first.type !== 'json' &&
      first.type !== 'node' &&
      first.type !== 'relationship' &&
      typed.every((r) => r.type === first.type);
    const type: ExprType = native ? first.type : 'json';
    const shapes = new Set(typed.map((r) => (r.type === 'json' ? r.shape : undefined)));
    const shape =
      type === 'json' && shapes.size === 1 && typed.every((r) => r.type === 'json')
        ? first.shape
        : undefined;
    const value = (e: Expr): string => {
      if (e.type === 'null') {
        return type === 'json' ? d.jsonInput('NULL') : 'NULL';
      }
      return type === 'json' ? this.toJson(e) : e.sql;
    };
    const otherwise = expr.otherwise ? ` ELSE ${value(results.at(-1)!)}` : '';
    const branches = (conditions: string[]): string =>
      `(CASE ${conditions.map((c, i) => `WHEN ${c} THEN ${value(results[i]!)}`).join(' ')}${otherwise} END)`;

    let sql: string;
    if (expr.subject === undefined) {
      sql = branches(expr.alternatives.map((a) => this.toBoolean(this.compile(a.when), a.when)));
    } else {
      const subject = this.compile(expr.subject);
      sql = this.share([subject], ([s]) =>
        branches(expr.alternatives.map((a) => this.compare('=', s!, this.compile(a.when), 0).sql)),
      );
    }
    return { sql, type, atomic: false, shape };
  }

  // ---- lists -------------------------------------------------------------------

  /**
   * The operand of a list operation, checked to be a list where its type is
   * known; undefined when it is the null literal (the result is null).
   */
  private listOperand(e: Expr, position: SourcePosition): Expr | undefined {
    if (e.type === 'null') {
      return undefined;
    }
    if (e.type !== 'json' || (e.shape !== undefined && e.shape !== 'list')) {
      throw typeError('a list', e.shape ?? e.type, position);
    }
    return e;
  }

  /**
   * `subject[index]`: the element of a list at an integer index (negative counts
   * from the end, out of range is null), or the value of a map, node, or
   * relationship under a string key. Other combinations are type errors when
   * the types are known, and `CypherTypeError`s at run time otherwise.
   */
  private index(expr: ast.IndexExpression): Expr {
    const b = this.b;
    const d = b.dialect;
    let subject = this.compile(expr.subject);
    const index = this.compile(expr.index);
    if (subject.type === 'null' || index.type === 'null') {
      return { sql: 'NULL', type: 'null', atomic: true };
    }
    const key = expr.index.type === 'Literal' ? expr.index.value : undefined;
    if (subject.type === 'node' || subject.type === 'relationship') {
      if (typeof key === 'string') {
        return this.member({ kind: subject.type, alias: subject.sql }, key);
      }
      // By a computed key: look it up in the properties.
      const table = b.mapping[subject.type === 'node' ? 'nodes' : 'edges'];
      subject = {
        sql: `${subject.sql}.${b.ident(table.properties)}`,
        type: 'json',
        atomic: true,
        shape: 'map',
      };
    }
    if (subject.type !== 'json' || subject.shape === 'path') {
      throw typeError('a list or a map', subject.shape ?? subject.type, expr.subject.position);
    }
    const lists = subject.shape !== 'map';
    const maps = subject.shape !== 'list';
    if (index.type !== 'integer' && index.type !== 'string' && index.type !== 'json') {
      throw typeError('an integer or a string', index.type, expr.index.position);
    }
    if ((index.type === 'integer' && !lists) || (index.type === 'string' && !maps)) {
      throw typeError(lists ? 'an integer' : 'a string', index.type, expr.index.position);
    }
    if (typeof key === 'string') {
      // A constant key: a plain member access (an index on it can be used).
      return json(d.jsonMember(subject.sql, b.bind({ kind: 'sql', value: key }), key), false);
    }
    return json(
      this.share([subject, index], ([s, i]) => {
        const nulls = [isNullType(s!.jsonType)];
        if (index.type === 'json') {
          nulls.push(isNullType(i!.jsonType));
        }
        const arms = [`WHEN ${nulls.join(' OR ')} THEN NULL`];
        const indexIs = (type: string): string =>
          index.type === 'json' ? ` AND ${i!.jsonType} = '${type}'` : '';
        if (lists && index.type !== 'string') {
          const n = index.type === 'json' ? d.fromJson(i!.sql, 'integer') : i!.sql;
          arms.push(
            `WHEN ${s!.jsonType} = 'list'${indexIs('integer')} THEN ${d.jsonElement(s!.sql, n)}`,
          );
        }
        if (maps && index.type !== 'integer') {
          const k = index.type === 'json' ? d.fromJson(i!.sql, 'string') : i!.sql;
          arms.push(
            `WHEN ${s!.jsonType} IN ('map', 'node', 'relationship')${indexIs('string')} ` +
              `THEN ${d.jsonMemberAt(s!.sql, k)}`,
          );
        }
        // What is left is a type error.
        const position = expr.index.position;
        if (maps) {
          const message = 'Type mismatch: a map, node, or relationship is indexed by a string key';
          arms.push(
            `WHEN ${s!.jsonType} IN ('map', 'node', 'relationship') THEN ` +
              b.typeError(message, position, 'json', 'MapElementAccessByNonString'),
          );
        }
        if (lists) {
          arms.push(
            `WHEN ${s!.jsonType} = 'list' THEN ` +
              b.typeError('Type mismatch: a list index must be an integer', position, 'json'),
          );
        }
        const notIndexable = b.typeError(
          'Type mismatch: only a list, map, node, or relationship can be indexed',
          expr.subject.position,
          'json',
        );
        return `(CASE ${arms.join(' ')} ELSE ${notIndexable} END)`;
      }),
      false,
    );
  }

  /**
   * `list[from..to]`: the elements from position `from` up to (not including)
   * `to`. Negative bounds count from the end, bounds out of range are clamped,
   * and a missing bound is open; a null bound gives null.
   */
  private slice(expr: ast.SliceExpression): Expr {
    const d = this.b.dialect;
    const list = this.listOperand(this.compile(expr.subject), expr.subject.position);
    const bounds = [expr.from, expr.to].map((bound) =>
      bound === undefined ? undefined : { expr: this.compile(bound), position: bound.position },
    );
    if (!list || bounds.some((bound) => bound?.expr.type === 'null')) {
      return { sql: 'NULL', type: 'null', atomic: true };
    }
    for (const bound of bounds) {
      if (bound && bound.expr.type !== 'integer' && bound.expr.type !== 'json') {
        throw typeError('an integer', bound.expr.type, bound.position);
      }
    }
    const given = bounds.filter((bound) => bound !== undefined).map((bound) => bound.expr);
    const sql = this.share([list, ...given], ([l, ...shared]) => {
      const length = d.listLength(l!.sql);
      /** Conditions that make the slice null, and type errors, in order. */
      const nulls = [isNullType(l!.jsonType)];
      const errors = [
        `WHEN ${l!.jsonType} <> 'list' THEN ${this.b.typeError('Type mismatch: only a list can be sliced', expr.subject.position, 'json')}`,
      ];
      let next = 0;
      const position = (bound: (typeof bounds)[number], open: string): string => {
        if (!bound) {
          return open;
        }
        const s = shared[next++]!;
        let value = s.sql;
        if (s.type === 'json') {
          errors.push(
            `WHEN NOT ${isNullType(s.jsonType)} AND ${s.jsonType} <> 'integer' THEN ` +
              this.b.typeError(
                'Type mismatch: a slice bound must be an integer',
                bound.position,
                'json',
              ),
          );
          value = `(CASE WHEN ${s.jsonType} = 'integer' THEN ${d.fromJson(s.sql, 'integer')} END)`;
        }
        nulls.push(`${value} IS NULL`);
        return `(CASE WHEN ${value} < 0 THEN ${length} + ${value} ELSE ${value} END)`;
      };
      const from = position(bounds[0], '0');
      const to = position(bounds[1], length);
      const n = this.nextAlias();
      const u = d.unwind(l!.sql, `ls${n}`);
      const elements = d.jsonAggregate(u.value, {
        distinct: false,
        orderBy: [u.order],
        filter: `${u.index} >= ${from} AND ${u.index} < ${to}`,
      });
      // A null list gives null before its type is checked; then the bounds' types.
      return (
        `(CASE WHEN ${nulls[0]} THEN NULL ${errors.join(' ')} ` +
        `WHEN ${nulls.slice(1).join(' OR ') || d.booleanLiteral(false)} THEN NULL ` +
        `ELSE (SELECT ${elements} FROM ${u.from}${u.where ? ` WHERE ${u.where}` : ''}) END)`
      );
    });
    return { ...json(sql, false), shape: 'list' };
  }

  /** `CASE` arms for an operand that must be a list: null for null, else a type error. */
  private notAList(type: string, position: SourcePosition, result: 'json' | 'boolean'): string {
    return (
      `WHEN ${isNullType(type)} THEN NULL ` +
      `ELSE ${this.b.typeError('Type mismatch: expected a list', position, result)}`
    );
  }

  /** `[x IN list WHERE condition | projection]`: a list in the order of `list`. */
  private comprehension(expr: ast.ListComprehension): Expr {
    const d = this.b.dialect;
    const list = this.listOperand(this.compile(expr.list), expr.list.position);
    if (!list) {
      return { sql: 'NULL', type: 'null', atomic: true };
    }
    const sql = this.share([list], ([l]) => {
      const u = d.unwind(l!.sql, `lc${this.nextAlias()}`);
      const [filter, value] = this.inScope(expr.variable, expr.list, u.value, () => [
        expr.where ? this.condition(expr.where) : d.booleanLiteral(true),
        expr.projection ? this.json(expr.projection) : u.value,
      ]);
      const elements = d.jsonAggregate(value, { distinct: false, orderBy: [u.order], filter });
      return (
        `(CASE WHEN ${l!.jsonType} = 'list' THEN (SELECT ${elements} FROM ${u.from}` +
        `${u.where ? ` WHERE ${u.where}` : ''}) ${this.notAList(l!.jsonType, expr.list.position, 'json')} END)`
      );
    });
    return { ...json(sql, false), shape: 'list' };
  }

  /**
   * `all(x IN list WHERE condition)`, `any`, `none`, `single`, with Cypher's
   * three-valued logic: a null condition makes the result null unless the
   * elements that are not null decide it.
   */
  private quantifier(expr: ast.QuantifierExpression): Expr {
    const d = this.b.dialect;
    if (!expr.where) {
      throw new SemanticError(`${expr.quantifier}(...) requires a WHERE condition`, {
        position: expr.position,
        hint: `For example: ${expr.quantifier}(x IN list WHERE x > 0)`,
      });
    }
    const where = expr.where;
    const list = this.listOperand(this.compile(expr.list), expr.list.position);
    if (!list) {
      return boolean(d.booleanLiteral(null));
    }
    return boolean(
      this.share([list], ([l]) => {
        const n = this.nextAlias();
        const u = d.unwind(l!.sql, `lq${n}`);
        const condition = this.inScope(expr.variable, expr.list, u.value, () =>
          this.condition(where),
        );
        return (
          `(CASE WHEN ${l!.jsonType} = 'list' THEN (SELECT ${this.quantify('p', expr.quantifier)} ` +
          `FROM (SELECT ${condition} AS p FROM ${u.from}${u.where ? ` WHERE ${u.where}` : ''}) AS q${n}) ` +
          `${this.notAList(l!.jsonType, expr.list.position, 'boolean')} END)`
        );
      }),
    );
  }

  /** A quantifier as an aggregate over the boolean column `column` (one row per element). */
  private quantify(column: string, kind: ast.QuantifierExpression['quantifier']): string {
    const d = this.b.dialect;
    switch (kind) {
      case 'any':
      case 'all':
        return `(${this.anyAll(column, kind)})`;
      case 'none':
        return `(NOT (${this.anyAll(column, 'any')}))`;
      case 'single': {
        const count = (condition: string): string =>
          `SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END)`;
        return (
          `(CASE WHEN ${count(column)} > 1 THEN ${d.booleanLiteral(false)} ` +
          `WHEN ${count(`${column} IS NULL`)} > 0 THEN NULL ` +
          `WHEN ${count(column)} = 1 THEN ${d.booleanLiteral(true)} ELSE ${d.booleanLiteral(false)} END)`
        );
      }
    }
  }

  // ---- arithmetic --------------------------------------------------------------

  private negate(expr: ast.NegateExpression): Expr {
    const e = this.compile(expr.operand);
    const d = this.b.dialect;
    if (e.type === 'null') {
      return e;
    }
    const negated = (integer: string): string =>
      d.checkedInteger(`(-${integer})`, this.overflow(expr.position));
    if (e.type === 'integer') {
      return { sql: this.share([e], ([v]) => negated(v!.sql)), type: e.type, atomic: false };
    }
    if (e.type === 'float') {
      return { sql: `(-${e.sql})`, type: e.type, atomic: false };
    }
    if (e.type !== 'json' || e.shape) {
      throw typeError('a number', e.shape ?? e.type, expr.operand.position);
    }
    return json(
      this.share(
        [e],
        ([j]) =>
          `(CASE WHEN ${isNullType(j!.jsonType)} THEN NULL ` +
          `WHEN ${j!.jsonType} = 'integer' THEN ${d.toJson(negated(d.fromJson(j!.sql, 'integer')), 'integer')} ` +
          `WHEN ${j!.jsonType} = 'float' THEN ${d.toJson(`(-${d.fromJson(j!.sql, 'float')})`, 'float')} ` +
          `ELSE ${this.b.typeError('Type mismatch: expected a number', expr.operand.position, 'json')} END)`,
      ),
      false,
    );
  }

  /** `Dialect.raise` for an integer result that does not fit in 64 bits. */
  private overflow(position: SourcePosition): string {
    return this.b.raise(
      {
        kind: 'argument',
        code: 'NumberOutOfRange',
        message: 'Integer overflow: the result does not fit in 64 bits',
        position,
      },
      'integer',
    );
  }

  private arithmetic(
    op: ast.ArithmeticOperator,
    left: Expr,
    right: Expr,
    expr: ast.BinaryExpression,
  ): Expr {
    if (left.type === 'null' || right.type === 'null') {
      return { sql: 'NULL', type: 'null', atomic: true };
    }
    if (isTemporalArithmetic(expr)) {
      // Temporal arithmetic of values known before the query runs: in the library.
      const b = this.b;
      return json(b.dialect.jsonInput(b.bind({ kind: 'temporal', expression: expr })), false);
    }
    const numeric = (t: ExprType): boolean => t === 'integer' || t === 'float';

    if (left.type !== 'json' && right.type !== 'json') {
      if (op === '+' && left.type === 'string' && right.type === 'string') {
        return { sql: `(${left.sql} || ${right.sql})`, type: 'string', atomic: false };
      }
      // A string and a number or boolean concatenate, as toString() writes it.
      const concatenates = (t: ExprType): boolean => numeric(t) || t === 'boolean';
      if (
        op === '+' &&
        ((left.type === 'string' && concatenates(right.type)) ||
          (concatenates(left.type) && right.type === 'string'))
      ) {
        const text = (e: Expr): string =>
          e.type === 'string'
            ? e.sql
            : this.scalarText(e.sql, e.type as 'integer' | 'float' | 'boolean');
        return { sql: `(${text(left)} || ${text(right)})`, type: 'string', atomic: false };
      }
      if (!numeric(left.type) || !numeric(right.type)) {
        const bad = numeric(left.type) ? expr.right : expr.left;
        throw typeError('a number', numeric(left.type) ? right.type : left.type, bad.position);
      }
      const type =
        op !== '^' && left.type === 'integer' && right.type === 'integer' ? 'integer' : 'float';
      return {
        sql: this.share([left, right], ([l, r]) =>
          this.numericOp(op, l!.sql, r!.sql, type, expr.position),
        ),
        type,
        atomic: false,
      };
    }

    // At least one side is known only at run time: compute on JSON.
    const listResult = op === '+' && (left.shape === 'list' || right.shape === 'list');
    // Temporal arithmetic only where the static types allow it: a JSON value of
    // unknown shape may be a temporal value or duration.
    const mayBeTemporal = (e: Expr): boolean => e.type === 'json' && e.shape === undefined;
    const mayBeNumber = (e: Expr): boolean => numeric(e.type) || mayBeTemporal(e);
    const temporal =
      op === '+' || op === '-'
        ? mayBeTemporal(left) && mayBeTemporal(right)
        : op === '*'
          ? (mayBeTemporal(left) && mayBeNumber(right)) ||
            (mayBeNumber(left) && mayBeTemporal(right))
          : op === '/' && mayBeTemporal(left) && mayBeNumber(right);
    return {
      ...json(
        this.share([this.asJson(left), this.asJson(right)], ([l, r]) =>
          this.jsonArithmetic(op, l!, r!, expr.position, temporal),
        ),
        false,
      ),
      shape: listResult ? 'list' : undefined,
    };
  }

  /** Arithmetic on two JSON values (cheap to repeat), dispatching on their types. */
  private jsonArithmetic(
    op: ast.ArithmeticOperator,
    l: Shared,
    r: Shared,
    position: SourcePosition,
    temporalPossible: boolean,
  ): string {
    const d = this.b.dialect;
    const lt = l.jsonType;
    const rt = r.jsonType;
    const arms: string[] = [];
    if (op !== '^') {
      const ints = this.numericOp(
        op,
        d.fromJson(l.sql, 'integer'),
        d.fromJson(r.sql, 'integer'),
        'integer',
        position,
      );
      arms.push(`WHEN ${lt} = 'integer' AND ${rt} = 'integer' THEN ${d.toJson(ints, 'integer')}`);
    }
    const floats = this.numericOp(
      op,
      d.fromJson(l.sql, 'float'),
      d.fromJson(r.sql, 'float'),
      'float',
      position,
    );
    arms.push(
      `WHEN ${lt} IN ${NUMBER_TYPES} AND ${rt} IN ${NUMBER_TYPES} THEN ${d.toJson(floats, 'float')}`,
    );
    if (op === '+') {
      const strings = `(${d.fromJson(l.sql, 'string')} || ${d.fromJson(r.sql, 'string')})`;
      arms.push(`WHEN ${lt} = 'string' AND ${rt} = 'string' THEN ${d.toJson(strings, 'string')}`);
      // A string and a number or boolean concatenate, as toString() writes it.
      const text = (e: Shared, t: string): string =>
        `(CASE ${t} WHEN 'string' THEN ${d.fromJson(e.sql, 'string')} ` +
        (['integer', 'float', 'boolean'] as const)
          .map((type) => `WHEN '${type}' THEN ${this.scalarText(d.fromJson(e.sql, type), type)} `)
          .join('') +
        'END)';
      const scalars = `('integer', 'float', 'boolean')`;
      arms.push(
        `WHEN (${lt} = 'string' AND ${rt} IN ${scalars}) OR ` +
          `(${lt} IN ${scalars} AND ${rt} = 'string') ` +
          `THEN ${d.toJson(`(${text(l, lt)} || ${text(r, rt)})`, 'string')}`,
      );
      // List + list concatenates; list + value appends; value + list prepends.
      const asList = (e: Shared, t: string): string =>
        `(CASE WHEN ${t} = 'list' THEN ${e.sql} ELSE ${d.jsonArray([e.sql])} END)`;
      arms.push(
        `WHEN ${lt} = 'list' OR ${rt} = 'list' THEN ${d.concatLists(asList(l, lt), asList(r, rt))}`,
      );
    }
    // A temporal value or duration on either side: the dialect's temporal arithmetic.
    const temporal = d.temporalArithmetic;
    if (temporal && temporalPossible && op !== '%' && op !== '^') {
      arms.push(
        `WHEN ${lt} IN ${TEMPORAL_OR_DURATION} OR ${rt} IN ${TEMPORAL_OR_DURATION} ` +
          `THEN ${temporal(op, l.sql, r.sql)}`,
      );
    }
    const mismatch = this.b.typeError(
      `Type mismatch: cannot apply \`${op}\` to these values`,
      position,
      'json',
    );
    return (
      `(CASE WHEN ${isNullType(lt)} OR ${isNullType(rt)} THEN NULL ${arms.join(' ')} ` +
      `ELSE ${mismatch} END)`
    );
  }

  /** A number or boolean as text, as toString() writes it (`1`, `1.0`, `1.0E20`, `true`). */
  private scalarText(sql: string, type: 'integer' | 'float' | 'boolean'): string {
    switch (type) {
      case 'integer':
        return `CAST(${sql} AS TEXT)`;
      case 'float':
        return this.b.dialect.floatToString(sql);
      case 'boolean':
        return `(CASE WHEN ${sql} THEN 'true' WHEN NOT ${sql} THEN 'false' END)`;
    }
  }

  /**
   * `left op right` on numbers (cheap to repeat). For `type: 'float'` at least
   * one side is already a float (double precision / REAL), so the operation is
   * done in floating point, as in Cypher. Integer `/` truncates toward zero in
   * both databases, as in Cypher; float `%` is computed because SQLite's `%`
   * works on integers only. Integer overflow and integer division by zero are
   * errors (`CypherArgumentError`).
   */
  private numericOp(
    op: ast.ArithmeticOperator,
    left: string,
    right: string,
    type: 'integer' | 'float',
    position: SourcePosition,
  ): string {
    const d = this.b.dialect;
    if (op === '^') {
      return d.power(left, right);
    }
    if (type === 'float' && op === '/') {
      return d.floatDivide(left, right);
    }
    if (type === 'float' && op === '%') {
      return `(${left} - trunc(${left} / ${right}) * ${right})`;
    }
    if (type === 'float') {
      return `(${left} ${op} ${right})`;
    }
    const result = d.checkedInteger(`(${left} ${op} ${right})`, this.overflow(position));
    if (op === '/' || op === '%') {
      const zero = this.b.raise(
        { kind: 'argument', code: 'DivisionByZero', message: 'Division by zero', position },
        'integer',
      );
      return `(CASE WHEN ${right} = 0 THEN ${zero} ELSE ${result} END)`;
    }
    return result;
  }
}

type TypeClass = 'number' | 'string' | 'boolean';

function typeClass(type: ExprType): TypeClass {
  if (type === 'integer' || type === 'float') {
    return 'number';
  }
  if (type === 'string' || type === 'boolean') {
    return type;
  }
  throw new Error(`Internal error: no type class for ${type}`);
}

/** A key that is equal for equal expressions (positions ignored); none for rand(). */
function expressionKey(expr: ast.Expression): string | undefined {
  let random = false;
  const key = JSON.stringify(expr, (k, value: unknown) => {
    if (k === 'position') {
      return undefined;
    }
    if (k === 'name' && typeof value === 'string' && value.toLowerCase() === 'rand') {
      random = true;
    }
    return typeof value === 'bigint' ? `${value}n` : value;
  });
  return random ? undefined : key;
}

/**
 * The type of every element of a list literal whose elements are all non-null
 * literals of one type; undefined otherwise (also for an empty list).
 */
function literalElementType(list: ast.Expression): ScalarType | undefined {
  if (list.type !== 'List' || list.items.length === 0) {
    return undefined;
  }
  const types = new Set(
    list.items.map((item) => {
      if (item.type !== 'Literal' || item.value === null) {
        return undefined;
      }
      const value = item.value;
      return typeof value === 'bigint'
        ? 'integer'
        : typeof value === 'number'
          ? 'float'
          : typeof value === 'boolean'
            ? 'boolean'
            : 'string';
    }),
  );
  const [type] = types;
  return types.size === 1 ? type : undefined;
}

/** Condition: a JSON type (see `Dialect.jsonType`) is a null value (SQL NULL or JSON null). */
export function isNullType(type: string): string {
  return `(${type} IS NULL OR ${type} = 'null')`;
}

function json(sql: string, atomic: boolean): Expr {
  return { sql, type: 'json', atomic };
}

function boolean(sql: string): Expr {
  return { sql, type: 'boolean', atomic: false };
}

export function typeError(
  expected: string,
  actual: string,
  position: SourcePosition,
): SemanticError {
  return new SemanticError(`Type mismatch: expected ${expected} but was ${describeType(actual)}`, {
    position,
  });
}

function describeType(type: string): string {
  switch (type) {
    case 'json':
      return 'a value';
    case 'null':
      return 'null';
    case 'integer':
      return 'an integer';
    default:
      return `a ${type}`;
  }
}
