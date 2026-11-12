import type * as ast from '../ast.js';
import type { ScalarType } from '../dialect/dialect.js';
import { SemanticError, UnsupportedFeatureError, type SourcePosition } from '../errors.js';
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

export interface Expr {
  sql: string;
  type: ExprType;
  /** Cheap to repeat in SQL (a column, a bind value, a literal). */
  atomic: boolean;
  /** For `json`: the value is known to be a list or a map (a literal). */
  shape?: 'list' | 'map' | undefined;
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
  | { kind: 'value'; sql: string }
  /** A column of a derived table whose type is known (the outer query of an aggregation). */
  | { kind: 'column'; expr: Expr };

type Comparison = ast.ComparisonOperator;

/** Numbers compare with each other; every other type only with itself. */
const NUMBER_TYPES = `('integer', 'float')`;

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

  public constructor(
    public readonly b: SqlBuilder,
    private readonly lookup: (variable: ast.Variable) => VariableBinding,
  ) {}

  /**
   * Compiles an expression. Equal expressions compile to the same SQL text (with
   * the same bind markers), which GROUP BY relies on, except when they call
   * rand(), whose calls must stay independent.
   */
  public compile(expr: ast.Expression): Expr {
    const key = expressionKey(expr);
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
        const constant = constantValue(expr);
        if (constant) {
          const sql = b.dialect.jsonInput(b.bind({ kind: 'json', value: constant }));
          return { sql, type: 'json', atomic: true, shape };
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
      case 'Variable': {
        const binding = this.lookup(expr);
        if (binding.kind === 'value') {
          return json(binding.sql, /^[\w."]+$/.test(binding.sql));
        }
        if (binding.kind === 'column') {
          return binding.expr;
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
      case 'FunctionCall':
        return isAggregateCall(expr) ? compileAggregate(this, expr) : compileFunction(this, expr);
      case 'CountStar':
        return compileAggregate(this, expr);
      case 'UnsupportedExpression':
        throw new UnsupportedFeatureError(`${expr.description} are not supported yet`, {
          position: expr.position,
        });
    }
  }

  /** The expression as a value of the dialect's JSON type. */
  public json(expr: ast.Expression): string {
    return this.toJson(this.compile(expr), expr.position);
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
   * by value. Lists and maps sort by their JSON text within their type, which
   * is not Cypher's element-wise order. Apply a direction with `orderTerm`.
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
              `(CASE ${t} WHEN 'map' THEN 1 WHEN 'list' THEN 4 WHEN 'string' THEN 12 ` +
              `WHEN 'boolean' THEN 13 WHEN 'integer' THEN 14 WHEN 'float' THEN 14 ELSE 99 END)`,
            nulls: false,
          },
          when(NUMBER_TYPES, d.fromJson(e.sql, 'number')),
          when(`('string')`, d.orderString(d.fromJson(e.sql, 'string'))),
          when(`('boolean')`, d.fromJson(e.sql, 'boolean')),
          when(`('list', 'map')`, d.jsonText(e.sql)),
        ];
      }
      default:
        return [{ sql: e.sql, nulls: true }];
    }
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
        if (subject.shape === 'list') {
          throw typeError('a map, node, or relationship', 'list', expr.subject.position);
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
  public toJson(e: Expr, position: SourcePosition): string {
    switch (e.type) {
      case 'json':
        return e.sql;
      case 'null':
        // Typed, so that PostgreSQL can resolve JSON functions applied to it.
        return this.b.dialect.jsonInput('NULL');
      case 'node':
      case 'relationship':
        throw new UnsupportedFeatureError(`A ${e.type} cannot be used as a value here yet`, {
          position,
        });
      default:
        return this.b.dialect.toJson(e.sql, e.type);
    }
  }

  private asJson(e: Expr, position: SourcePosition): Expr {
    return e.type === 'json' ? e : { ...json(this.toJson(e, position), e.atomic) };
  }

  /**
   * Runs `body` with the operands made cheap to repeat, and with the run-time
   * type of each JSON operand computed once: anything that is not atomic, and
   * the types, are computed in a scalar subquery and referred to by column.
   */
  public share(exprs: Expr[], body: (shared: Shared[]) => string): string {
    const d = this.b.dialect;
    const alias = `s${this.aliases++}`;
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
        // A non-boolean value is a type error in Cypher; here it is null.
        return this.share(
          [e],
          ([j]) =>
            `(CASE WHEN ${j!.jsonType} = 'boolean' THEN ${d.fromJson(j!.sql, 'boolean')} END)`,
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
    if (subject.type !== 'node') {
      throw new UnsupportedFeatureError('Label predicates are supported on nodes only', {
        position: expr.position,
      });
    }
    const b = this.b;
    const labels = `${subject.sql}.${b.ident(b.mapping.nodes.labels)}`;
    return boolean(
      `(${expr.labels.map((l) => b.dialect.hasLabel(labels, b.bind({ kind: 'sql', value: l }))).join(' AND ')})`,
    );
  }

  private isNull(expr: ast.IsNullExpression): Expr {
    const e = this.compile(expr.operand);
    const d = this.b.dialect;
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
      if (left.type !== right.type) {
        if (entities.includes(left.type) && entities.includes(right.type)) {
          return boolean(mismatch);
        }
        throw new UnsupportedFeatureError(
          'Comparing a node or relationship with another value is not supported yet',
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
          `WHEN ${lt} = 'string' THEN ${same('string')} ` +
          `WHEN ${lt} = 'boolean' THEN ${same('boolean')} ` +
          `ELSE ${structured} END)`
        );
      }),
    );
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
    const n = this.aliases++;
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
        const n = this.aliases++;
        const e = d.unwind(r!.sql, `in${n}`);
        const eq = this.compare('=', l!, json(e.value, false), 0).sql;
        return (
          `(CASE WHEN ${r!.jsonType} IS NULL OR ${r!.jsonType} <> 'list' THEN NULL ` +
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
    const apply = (s: string, p: string): string =>
      op === 'STARTS WITH'
        ? d.startsWith(s, p)
        : op === 'ENDS WITH'
          ? d.endsWith(s, p)
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
        [this.asJson(left, position), this.asJson(right, position)],
        ([l, r]) =>
          `(CASE WHEN ${l!.jsonType} = 'string' AND ${r!.jsonType} = 'string' ` +
          `THEN ${apply(d.fromJson(l!.sql, 'string'), d.fromJson(r!.sql, 'string'))} END)`,
      ),
    );
  }

  // ---- arithmetic --------------------------------------------------------------

  private negate(expr: ast.NegateExpression): Expr {
    const e = this.compile(expr.operand);
    const d = this.b.dialect;
    if (e.type === 'null') {
      return e;
    }
    if (e.type === 'integer' || e.type === 'float') {
      return { sql: `(-${e.sql})`, type: e.type, atomic: false };
    }
    if (e.type !== 'json' || e.shape) {
      throw typeError('a number', e.shape ?? e.type, expr.operand.position);
    }
    return json(
      this.share(
        [e],
        ([j]) =>
          `(CASE ${j!.jsonType} WHEN 'integer' THEN ${d.toJson(`(-${d.fromJson(j!.sql, 'integer')})`, 'integer')} ` +
          `WHEN 'float' THEN ${d.toJson(`(-${d.fromJson(j!.sql, 'float')})`, 'float')} END)`,
      ),
      false,
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
    const numeric = (t: ExprType): boolean => t === 'integer' || t === 'float';

    if (left.type !== 'json' && right.type !== 'json') {
      if (op === '+' && left.type === 'string' && right.type === 'string') {
        return { sql: `(${left.sql} || ${right.sql})`, type: 'string', atomic: false };
      }
      if (!numeric(left.type) || !numeric(right.type)) {
        const bad = numeric(left.type) ? expr.right : expr.left;
        throw typeError('a number', numeric(left.type) ? right.type : left.type, bad.position);
      }
      const type =
        op !== '^' && left.type === 'integer' && right.type === 'integer' ? 'integer' : 'float';
      return {
        sql: this.share([left, right], ([l, r]) => this.numericOp(op, l!.sql, r!.sql, type)),
        type,
        atomic: false,
      };
    }

    // At least one side is known only at run time: compute on JSON.
    const listResult = op === '+' && (left.shape === 'list' || right.shape === 'list');
    return {
      ...json(
        this.share(
          [this.asJson(left, expr.left.position), this.asJson(right, expr.right.position)],
          ([l, r]) => this.jsonArithmetic(op, l!, r!),
        ),
        false,
      ),
      shape: listResult ? 'list' : undefined,
    };
  }

  /** Arithmetic on two JSON values (cheap to repeat), dispatching on their types. */
  private jsonArithmetic(op: ast.ArithmeticOperator, l: Shared, r: Shared): string {
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
      );
      arms.push(`WHEN ${lt} = 'integer' AND ${rt} = 'integer' THEN ${d.toJson(ints, 'integer')}`);
    }
    const floats = this.numericOp(
      op,
      d.fromJson(l.sql, 'float'),
      d.fromJson(r.sql, 'float'),
      'float',
    );
    arms.push(
      `WHEN ${lt} IN ${NUMBER_TYPES} AND ${rt} IN ${NUMBER_TYPES} THEN ${d.toJson(floats, 'float')}`,
    );
    if (op === '+') {
      const strings = `(${d.fromJson(l.sql, 'string')} || ${d.fromJson(r.sql, 'string')})`;
      arms.push(`WHEN ${lt} = 'string' AND ${rt} = 'string' THEN ${d.toJson(strings, 'string')}`);
      // List + list concatenates; list + value appends; value + list prepends.
      const asList = (e: Shared, t: string): string =>
        `(CASE WHEN ${t} = 'list' THEN ${e.sql} ELSE ${d.jsonArray([e.sql])} END)`;
      arms.push(
        `WHEN ${lt} = 'list' OR ${rt} = 'list' THEN ${d.concatLists(asList(l, lt), asList(r, rt))}`,
      );
    }
    // Other combinations are type errors in Cypher; here they are null.
    return `(CASE WHEN ${lt} = 'null' OR ${rt} = 'null' THEN NULL ${arms.join(' ')} END)`;
  }

  /**
   * `left op right` on numbers (cheap to repeat). For `type: 'float'` at least
   * one side is already a float (double precision / REAL), so the operation is
   * done in floating point, as in Cypher. Integer `/` truncates toward zero in
   * both databases, as in Cypher; float `%` is computed because SQLite's `%`
   * works on integers only.
   */
  private numericOp(
    op: ast.ArithmeticOperator,
    left: string,
    right: string,
    type: 'integer' | 'float',
  ): string {
    if (op === '^') {
      return this.b.dialect.power(left, right);
    }
    if (type === 'float' && op === '/') {
      return this.b.dialect.floatDivide(left, right);
    }
    if (type === 'float' && op === '%') {
      return `(${left} - trunc(${left} / ${right}) * ${right})`;
    }
    return `(${left} ${op} ${right})`;
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
