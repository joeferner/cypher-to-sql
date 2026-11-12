import type * as ast from '../ast.js';
import type { ScalarType } from '../dialect/dialect.js';
import { SemanticError, UnsupportedFeatureError } from '../errors.js';
import { typeError, type Expr, type ExprCompiler, type ExprType, type Shared } from './expr.js';

// Scalar, string, list, and math functions. Each function checks the argument
// types it can see at compile time (a SemanticError for a wrong type) and checks
// JSON arguments at run time (null for a wrong type, where Cypher would raise a
// type error; see #30). A null argument gives null, except in coalesce().

/** What a function argument must be. `float` accepts integers and converts them. */
type Kind = 'string' | 'integer' | 'float' | 'boolean' | 'list' | 'map';

const JSON_TYPES: Record<Kind, string> = {
  string: `('string')`,
  integer: `('integer')`,
  float: `('integer', 'float')`,
  boolean: `('boolean')`,
  list: `('list')`,
  map: `('map')`,
};

interface Call {
  c: ExprCompiler;
  node: ast.FunctionCall;
  args: Expr[];
}

type FunctionImpl = (call: Call) => Expr;

interface FunctionDef {
  min: number;
  max: number;
  impl: FunctionImpl;
}

function fn(min: number, max: number, impl: FunctionImpl): FunctionDef {
  return { min, max, impl };
}

/** Compiles a call of a function that is not an aggregate (see aggregates.ts). */
export function compileFunction(c: ExprCompiler, node: ast.FunctionCall): Expr {
  const name = node.name.toLowerCase();
  const def = FUNCTIONS[name];
  if (!def) {
    throw new UnsupportedFeatureError(`Function ${node.name}() is not supported`, {
      position: node.position,
      hint: `Supported functions: ${Object.keys(FUNCTIONS).sort().join(', ')}.`,
    });
  }
  if (node.args.length < def.min || node.args.length > def.max) {
    const expected =
      def.min === def.max
        ? `${def.min}`
        : def.max === Infinity
          ? `at least ${def.min}`
          : `${def.min} to ${def.max}`;
    throw new SemanticError(
      `Function ${node.name}() takes ${expected} argument${def.max === 1 ? '' : 's'}, got ${node.args.length}`,
      { position: node.position },
    );
  }
  if (node.distinct) {
    throw new SemanticError(`DISTINCT is only allowed in aggregate functions, not ${node.name}()`, {
      position: node.position,
    });
  }
  return def.impl({ c, node, args: node.args.map((arg) => c.compile(arg)) });
}

// ---- helpers ---------------------------------------------------------------------

const NULL: Expr = { sql: 'NULL', type: 'null', atomic: true };

function result(sql: string, type: ExprType, shape?: 'list' | 'map'): Expr {
  return { sql, type, atomic: false, shape };
}

/**
 * Applies `body` to the arguments as values of the given kinds: native SQL
 * values for scalars, JSON for lists and maps. Arguments whose type is only
 * known at run time are checked then, and a mismatch gives null.
 */
function apply(
  call: Call,
  kinds: Kind[],
  type: ExprType,
  body: (values: string[]) => string,
  shape?: 'list' | 'map',
): Expr {
  const { c, node, args } = call;
  const d = c.b.dialect;
  if (args.some((a) => a.type === 'null')) {
    return NULL;
  }
  args.forEach((arg, i) => {
    const kind = kinds[i]!;
    const ok =
      arg.type === 'json'
        ? arg.shape === undefined || arg.shape === kind
        : arg.type === kind || (kind === 'float' && arg.type === 'integer');
    if (!ok) {
      throw typeError(`${article(kind)} ${kind}`, arg.shape ?? arg.type, node.args[i]!.position);
    }
  });
  const sql = c.share(args, (refs) => {
    const checks: string[] = [];
    const values = refs.map((ref, i) => {
      const kind = kinds[i]!;
      if (ref.type !== 'json') {
        return kind === 'float' && ref.type === 'integer' ? d.toFloat(ref.sql) : ref.sql;
      }
      checks.push(`${ref.jsonType} IN ${JSON_TYPES[kind]}`);
      if (kind === 'list' || kind === 'map') {
        return ref.sql;
      }
      return kind === 'float'
        ? d.toFloat(d.fromJson(ref.sql, 'number'))
        : d.fromJson(ref.sql, kind);
    });
    const value = body(values);
    return checks.length > 0 ? `(CASE WHEN ${checks.join(' AND ')} THEN ${value} END)` : value;
  });
  return result(sql, type, shape);
}

type Cases = Partial<Record<Kind, (value: string) => string>>;

/**
 * A function of one argument that accepts several types. `cases` gives the SQL
 * for each accepted type, from the value as a native value (or JSON for lists
 * and maps). Each case returns a value of `resultType`; for `json`, cases for
 * scalar types return the scalar natively and it is converted to JSON.
 */
function dispatch(
  call: Call,
  resultType: ScalarType | 'json',
  cases: Cases,
  shape?: 'list' | 'map',
): Expr {
  const { c, node, args } = call;
  const d = c.b.dialect;
  const arg = args[0]!;
  if (arg.type === 'null') {
    return NULL;
  }
  const finish = (type: string, sql: string): string =>
    resultType === 'json' && type !== 'list' && type !== 'map'
      ? d.toJson(sql, type as ScalarType)
      : sql;
  const known = arg.type === 'json' ? arg.shape : arg.type;
  if (known !== undefined) {
    const f = cases[known as Kind];
    if (!f) {
      throw typeError(Object.keys(cases).join(' or '), known, node.args[0]!.position);
    }
    return result(
      c.share([arg], ([a]) => finish(known, f(a!.sql))),
      resultType,
      shape,
    );
  }
  // Known only at run time: one CASE arm per accepted type.
  const sql = c.share([arg], ([a]) => {
    const arms = Object.entries(cases).map(([type, f]) => {
      const value =
        type === 'list' || type === 'map' ? a!.sql : d.fromJson(a!.sql, type as ScalarType);
      return `WHEN '${type}' THEN ${finish(type, f(value))}`;
    });
    return `(CASE ${a!.jsonType} ${arms.join(' ')} END)`;
  });
  return result(sql, resultType, shape);
}

function article(kind: string): string {
  return /^[aeiou]/.test(kind) ? 'an' : 'a';
}

/** The entity argument of `id()`, `labels()`, and the like, or undefined for null. */
function entity(call: Call, kinds: ('node' | 'relationship')[]): Expr | undefined {
  const arg = call.args[0]!;
  if (arg.type === 'null') {
    return undefined;
  }
  if (!(kinds as string[]).includes(arg.type)) {
    throw typeError(kinds.join(' or '), arg.shape ?? arg.type, call.node.args[0]!.position);
  }
  return arg;
}

/** A column of an entity's table (`labels` only for nodes, `type` only for relationships). */
function column(call: Call, e: Expr, name: 'id' | 'labels' | 'properties' | 'type'): string {
  const b = call.c.b;
  const nodes = b.mapping.nodes;
  const edges = b.mapping.edges;
  let columnName: string;
  if (name === 'id') {
    columnName = e.type === 'node' ? nodes.id : edges.id;
  } else if (name === 'properties') {
    columnName = e.type === 'node' ? nodes.properties : edges.properties;
  } else {
    columnName = name === 'labels' ? nodes.labels : edges.type;
  }
  return `${e.sql}.${b.ident(columnName)}`;
}

function math(name: string, arity: number): FunctionDef {
  return fn(arity, arity, (call) =>
    apply(call, Array<Kind>(arity).fill('float'), 'float', (v) => call.c.b.dialect.math(name, v)),
  );
}

function stringFunction(arity: number, sql: (values: string[]) => string): FunctionDef {
  return fn(arity, arity, (call) => apply(call, Array<Kind>(arity).fill('string'), 'string', sql));
}

// ---- the functions -----------------------------------------------------------------

const FUNCTIONS: Record<string, FunctionDef> = {
  // Entities
  id: fn(1, 1, (call) => {
    const e = entity(call, ['node', 'relationship']);
    return e ? result(column(call, e, 'id'), 'integer') : NULL;
  }),
  labels: fn(1, 1, (call) => {
    const e = entity(call, ['node']);
    return e ? result(column(call, e, 'labels'), 'json', 'list') : NULL;
  }),
  type: fn(1, 1, (call) => {
    const e = entity(call, ['relationship']);
    return e ? result(column(call, e, 'type'), 'string') : NULL;
  }),
  properties: fn(1, 1, (call) => {
    const arg = call.args[0]!;
    if (arg.type === 'node' || arg.type === 'relationship') {
      return result(column(call, arg, 'properties'), 'json', 'map');
    }
    return dispatch(call, 'json', { map: (m) => m }, 'map');
  }),
  keys: fn(1, 1, (call) => {
    const d = call.c.b.dialect;
    const arg = call.args[0]!;
    if (arg.type === 'node' || arg.type === 'relationship') {
      return result(d.jsonKeys(column(call, arg, 'properties')), 'json', 'list');
    }
    return dispatch(call, 'json', { map: (m) => d.jsonKeys(m) }, 'list');
  }),

  // Conversions
  coalesce: fn(1, Infinity, coalesce),
  tostring: fn(1, 1, toStringFunction),
  tostringornull: fn(1, 1, toStringFunction),
  tointeger: fn(1, 1, (call) => toNumber(call, 'integer')),
  tointegerornull: fn(1, 1, (call) => toNumber(call, 'integer')),
  tofloat: fn(1, 1, (call) => toNumber(call, 'float')),
  tofloatornull: fn(1, 1, (call) => toNumber(call, 'float')),
  toboolean: fn(1, 1, toBoolean),
  tobooleanornull: fn(1, 1, toBoolean),

  // Lists and strings
  size: fn(1, 1, (call) => {
    const d = call.c.b.dialect;
    return dispatch(call, 'integer', {
      string: (s) => d.stringLength(s),
      list: (l) => d.listLength(l),
    });
  }),
  head: fn(1, 1, (call) =>
    apply(call, ['list'], 'json', ([l]) => call.c.b.dialect.jsonElement(l!, '0')),
  ),
  last: fn(1, 1, (call) =>
    apply(call, ['list'], 'json', ([l]) => call.c.b.dialect.jsonElement(l!, '-1')),
  ),
  tail: fn(1, 1, (call) =>
    apply(call, ['list'], 'json', ([l]) => call.c.b.dialect.jsonTail(l!), 'list'),
  ),
  reverse: fn(1, 1, (call) => {
    const d = call.c.b.dialect;
    if (call.args[0]!.type === 'string') {
      return apply(call, ['string'], 'string', ([s]) => d.reverseString(s!));
    }
    return dispatch(call, 'json', {
      string: (s) => d.reverseString(s),
      list: (l) => d.reverseList(l),
    });
  }),
  range: fn(2, 3, (call) =>
    apply(
      call,
      call.args.map((): Kind => 'integer'),
      'json',
      ([start, end, step]) => call.c.b.dialect.range(start!, end!, step ?? '1'),
      'list',
    ),
  ),
  split: fn(2, 2, (call) =>
    apply(
      call,
      ['string', 'string'],
      'json',
      ([s, delimiter]) => call.c.b.dialect.split(s!, delimiter!),
      'list',
    ),
  ),
  substring: fn(2, 3, (call) =>
    apply(
      call,
      (['string', 'integer', 'integer'] as Kind[]).slice(0, call.args.length),
      'string',
      ([s, start, length]) => call.c.b.dialect.substring(s!, start!, length),
    ),
  ),
  left: fn(2, 2, (call) =>
    apply(call, ['string', 'integer'], 'string', ([s, n]) =>
      call.c.b.dialect.substring(s!, '0', n),
    ),
  ),
  right: fn(2, 2, (call) =>
    apply(call, ['string', 'integer'], 'string', ([s, n]) => call.c.b.dialect.rightString(s!, n!)),
  ),
  toupper: stringFunction(1, ([s]) => `upper(${s})`),
  upper: stringFunction(1, ([s]) => `upper(${s})`),
  tolower: stringFunction(1, ([s]) => `lower(${s})`),
  lower: stringFunction(1, ([s]) => `lower(${s})`),
  trim: stringFunction(1, ([s]) => `trim(${s})`),
  ltrim: stringFunction(1, ([s]) => `ltrim(${s})`),
  rtrim: stringFunction(1, ([s]) => `rtrim(${s})`),
  replace: stringFunction(3, ([s, search, by]) => `replace(${s}, ${search}, ${by})`),

  // Numbers
  abs: fn(1, 1, (call) => {
    const arg = call.args[0]!;
    if (arg.type === 'integer' || arg.type === 'float') {
      return result(`abs(${arg.sql})`, arg.type);
    }
    return dispatch(call, 'json', { integer: (v) => `abs(${v})`, float: (v) => `abs(${v})` });
  }),
  sign: fn(1, 1, (call) =>
    apply(
      call,
      ['float'],
      'integer',
      ([v]) => `(CASE WHEN ${v} > 0 THEN 1 WHEN ${v} < 0 THEN -1 WHEN ${v} = 0 THEN 0 END)`,
    ),
  ),
  // Java's Math.round, as in Cypher: halves round toward positive infinity.
  round: fn(1, 1, (call) =>
    apply(call, ['float'], 'float', ([v]) => call.c.b.dialect.math('floor', [`${v} + 0.5`])),
  ),
  ceil: math('ceil', 1),
  floor: math('floor', 1),
  sqrt: math('sqrt', 1),
  exp: math('exp', 1),
  log: math('log', 1),
  log10: math('log10', 1),
  sin: math('sin', 1),
  cos: math('cos', 1),
  tan: math('tan', 1),
  asin: math('asin', 1),
  acos: math('acos', 1),
  atan: math('atan', 1),
  atan2: math('atan2', 2),
  pi: math('pi', 0),
  e: math('e', 0),
  rand: math('rand', 0),
};

/** The first argument that is not null. */
function coalesce(call: Call): Expr {
  const { c, node } = call;
  const args = call.args.filter((a) => a.type !== 'null');
  if (args.length === 0) {
    return NULL;
  }
  const first = args[0]!;
  if (first.type !== 'json' && args.every((a) => a.type === first.type)) {
    if (first.type === 'node' || first.type === 'relationship') {
      throw new UnsupportedFeatureError(
        'coalesce() of nodes or relationships is not supported yet',
        {
          position: node.position,
        },
      );
    }
    // SQLite's COALESCE needs at least two arguments.
    return args.length === 1
      ? first
      : result(`COALESCE(${args.map((a) => a.sql).join(', ')})`, first.type);
  }
  const jsons = args.map((a, i): Expr => ({
    sql: c.toJson(a, node.args[i]!.position),
    type: 'json',
    atomic: a.atomic,
  }));
  // JSON null counts as null.
  const sql = c.share(jsons, (refs: Shared[]) => {
    const values = refs.map((r) => `CASE WHEN ${r.jsonType} <> 'null' THEN ${r.sql} END`);
    return values.length === 1 ? `(${values[0]})` : `COALESCE(${values.join(', ')})`;
  });
  return result(sql, 'json');
}

function toStringFunction(call: Call): Expr {
  const d = call.c.b.dialect;
  return dispatch(call, 'string', {
    string: (s) => s,
    integer: (i) => `CAST(${i} AS TEXT)`,
    // The JSON text of a float is Cypher's form (`1.0`, `0.30000000000000004`).
    float: (f) => d.jsonText(d.toJson(f, 'float')),
    boolean: (b) => `(CASE WHEN ${b} THEN 'true' WHEN NOT ${b} THEN 'false' END)`,
  });
}

function toNumber(call: Call, type: 'integer' | 'float'): Expr {
  const d = call.c.b.dialect;
  return dispatch(
    call,
    type,
    type === 'integer'
      ? {
          integer: (v) => v,
          float: (v) => d.truncate(v),
          string: (v) => d.parseNumber(v, 'integer'),
          boolean: (v) => `(CASE WHEN ${v} THEN 1 ELSE 0 END)`,
        }
      : {
          integer: (v) => d.toFloat(v),
          float: (v) => v,
          string: (v) => d.parseNumber(v, 'float'),
        },
  );
}

function toBoolean(call: Call): Expr {
  const d = call.c.b.dialect;
  return dispatch(call, 'boolean', {
    boolean: (v) => v,
    string: (v) =>
      `(CASE lower(trim(${v})) WHEN 'true' THEN ${d.booleanLiteral(true)} ` +
      `WHEN 'false' THEN ${d.booleanLiteral(false)} END)`,
    integer: (v) => `(${v} <> 0)`,
  });
}
