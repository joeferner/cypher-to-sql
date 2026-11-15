import type * as ast from '../ast.js';
import { RESERVED_KEYS, type ScalarType } from '../dialect/dialect.js';
import { SemanticError, UnsupportedFeatureError } from '../errors.js';
import { TEMPORAL_KINDS } from '../temporal.js';
import { isKnownBeforeRun, TEMPORAL_FUNCTIONS } from '../temporal-functions.js';
import {
  isNullType,
  typeError,
  type Expr,
  type ExprCompiler,
  type ExprType,
  type Shared,
} from './expr.js';

// Scalar, string, list, and math functions. Each function checks the argument
// types it can see at compile time (a SemanticError for a wrong type) and checks
// JSON arguments at run time (a CypherTypeError for a wrong type; null for the
// ...OrNull conversions). A null argument gives null, except in coalesce().

/** A run-time type error for an argument of `call` (see `SqlBuilder.raise`). */
function argumentError(call: Call, type: ScalarType | 'json'): string {
  const name = call.node.name;
  return call.c.b.typeError(
    `Type mismatch: invalid argument type for ${name}()`,
    call.node.position,
    type,
    name.toLowerCase().startsWith('to') ? 'InvalidArgumentValue' : 'InvalidArgumentType',
  );
}

/** The SQL result type of an expression type, for `argumentError`. */
function sqlType(type: ExprType): ScalarType | 'json' {
  return type === 'integer' || type === 'float' || type === 'string' || type === 'boolean'
    ? type
    : 'json';
}

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

/**
 * Functions of openCypher and Neo4j that this library does not implement
 * (yet): calling one is an `UnsupportedFeatureError`. Any other unknown name
 * is a `SemanticError`, as Cypher's UnknownFunction.
 */
const NOT_IMPLEMENTED = new Set(
  [
    'cot',
    'coth',
    'cosh',
    'sinh',
    'tanh',
    'degrees',
    'radians',
    'haversin',
    'timestamp',
    'isEmpty',
    'isNaN',
    'elementId',
    'toBooleanList',
    'toFloatList',
    'toIntegerList',
    'toStringList',
    'randomUUID',
    'char_length',
    'character_length',
    'btrim',
    'normalize',
    'valueType',
    'nullIf',
    'point',
    'point.distance',
    'distance',
  ].map((n) => n.toLowerCase()),
);

/** Compiles a call of a function that is not an aggregate (see aggregates.ts). */
export function compileFunction(c: ExprCompiler, node: ast.FunctionCall): Expr {
  const name = node.name.toLowerCase();
  const def = FUNCTIONS[name];
  if (!def) {
    const hint = `Supported functions: ${Object.keys(FUNCTIONS).sort().join(', ')}.`;
    // A namespaced name (`apoc.coll.sum`) may be a vendor or user function.
    if (NOT_IMPLEMENTED.has(name) || name.includes('.')) {
      throw new UnsupportedFeatureError(`Function ${node.name}() is not supported`, {
        position: node.position,
        hint,
      });
    }
    // Not a Cypher function at all (Cypher's UnknownFunction).
    throw new SemanticError(`Unknown function ${node.name}()`, {
      position: node.position,
      hint,
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
 * known at run time are checked then: null gives null, another type is a
 * `CypherTypeError`.
 */
function apply(
  call: Call,
  kinds: Kind[],
  type: ExprType,
  body: (values: string[]) => string,
  shape?: 'list' | 'map',
  /** Raise a wrong argument type when the query runs, not when it compiles (as the TCK wants for range()). */
  runtimeTypeErrors = false,
): Expr {
  const { c, node, args } = call;
  const d = c.b.dialect;
  if (args.some((a) => a.type === 'null')) {
    return NULL;
  }
  /** SQL that raises ArgumentError (InvalidArgumentType) when it runs. */
  const runtimeError = (): string =>
    c.b.raise(
      {
        kind: 'argument',
        code: 'InvalidArgumentType',
        message: `Type mismatch: invalid argument type for ${node.name}()`,
        position: node.position,
      },
      sqlType(type),
    );
  for (const [i, arg] of args.entries()) {
    const kind = kinds[i]!;
    const ok =
      arg.type === 'json'
        ? arg.shape === undefined || arg.shape === kind
        : arg.type === kind || (kind === 'float' && arg.type === 'integer');
    if (!ok) {
      if (runtimeTypeErrors) {
        return result(runtimeError(), type, shape);
      }
      throw typeError(`${article(kind)} ${kind}`, arg.shape ?? arg.type, node.args[i]!.position);
    }
  }
  const sql = c.share(args, (refs) => {
    const checks: string[] = [];
    const nulls: string[] = [];
    const values = refs.map((ref, i) => {
      const kind = kinds[i]!;
      if (ref.type !== 'json') {
        return kind === 'float' && ref.type === 'integer' ? d.toFloat(ref.sql) : ref.sql;
      }
      nulls.push(isNullType(ref.jsonType));
      checks.push(`${ref.jsonType} IN ${JSON_TYPES[kind]}`);
      if (kind === 'list' || kind === 'map') {
        return ref.sql;
      }
      return kind === 'float'
        ? d.toFloat(d.fromJson(ref.sql, 'number'))
        : d.fromJson(ref.sql, kind);
    });
    const value = body(values);
    return checks.length > 0
      ? `(CASE WHEN ${nulls.join(' OR ')} THEN NULL WHEN ${checks.join(' AND ')} THEN ${value} ` +
          `ELSE ${runtimeTypeErrors ? runtimeError() : argumentError(call, sqlType(type))} END)`
      : value;
  });
  return result(sql, type, shape);
}

/** SQL per accepted kind; `temporal` gets the JSON of any temporal value. */
type Cases = Partial<Record<Kind | 'temporal', (value: string) => string>>;

/** Temporal values and durations: their text is their `~s` member. */
const TEMPORAL_TYPES = `(${[...TEMPORAL_KINDS, 'duration'].map((k) => `'${k}'`).join(', ')})`;

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
    resultType === 'json' && type !== 'list' && type !== 'map' && type !== 'temporal'
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
  // Known only at run time: one CASE arm per accepted type. Any other type is
  // an error, or null for the ...OrNull conversions.
  const otherwise = node.name.toLowerCase().endsWith('ornull')
    ? 'NULL'
    : argumentError(call, resultType);
  const sql = c.share([arg], ([a]) => {
    const arms = Object.entries(cases).map(([type, f]) => {
      if (type === 'temporal') {
        return `WHEN ${a!.jsonType} IN ${TEMPORAL_TYPES} THEN ${finish(type, f(a!.sql))}`;
      }
      const value =
        type === 'list' || type === 'map' ? a!.sql : d.fromJson(a!.sql, type as ScalarType);
      return `WHEN ${a!.jsonType} = '${type}' THEN ${finish(type, f(value))}`;
    });
    return (
      `(CASE WHEN ${isNullType(a!.jsonType)} THEN NULL ${arms.join(' ')} ` +
      `ELSE ${otherwise} END)`
    );
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

/**
 * A function of a JSON argument that holds a node, relationship, or path (a
 * tagged object, see ENTITY_TAG): `body` when its run-time type is one of
 * `types`, otherwise null.
 */
function tagged(
  call: Call,
  types: ('node' | 'relationship' | 'path')[],
  type: ExprType,
  body: (json: string) => string,
  shape?: 'list' | 'map',
): Expr {
  const arg = call.args[0]!;
  if (arg.type === 'null') {
    return NULL;
  }
  const known = arg.shape === 'path' && types.includes('path');
  if (arg.type !== 'json' || (arg.shape !== undefined && !known)) {
    throw typeError(types.join(' or '), arg.shape ?? arg.type, call.node.args[0]!.position);
  }
  if (known) {
    // Known to be a path (or null): no run-time check needed.
    return result(
      call.c.share([arg], ([a]) => body(a!.sql)),
      type,
      shape,
    );
  }
  const accepted = types.map((t) => `'${t}'`).join(', ');
  const sql = call.c.share(
    [arg],
    ([a]) =>
      `(CASE WHEN ${a!.jsonType} IN (${accepted}) THEN ${body(a!.sql)} ` +
      `WHEN ${isNullType(a!.jsonType)} THEN NULL ELSE ${argumentError(call, sqlType(type))} END)`,
  );
  return result(sql, type, shape);
}

/** The member `key` (a reserved key of tagged objects) of a JSON object. */
function member(call: Call, json: string, key: string): string {
  const b = call.c.b;
  return b.dialect.jsonMember(json, b.bind({ kind: 'sql', value: key }), key);
}

/**
 * `startNode(r)` or `endNode(r)`: the node at that end of a relationship (or
 * of a tagged one in JSON), read from the node table by id as a tagged node.
 */
function endpoint(call: Call, end: 'start' | 'end'): Expr {
  const b = call.c.b;
  const nodes = b.columns('nodes');
  const node = (id: string): string => {
    const alias = `sn${call.c.nextAlias()}`;
    return (
      `(SELECT ${b.entityJson('node', alias)} FROM ${nodes.table} AS ${alias} ` +
      `WHERE ${alias}.${nodes.id} = ${id})`
    );
  };
  if (isJson(call)) {
    return tagged(call, ['relationship'], 'json', (j) =>
      node(b.dialect.jsonId(member(call, j, `~${end}`), nodes.table, b.mapping.nodes.id)),
    );
  }
  const e = entity(call, ['relationship']);
  if (!e) {
    return NULL;
  }
  const edges = b.columns('edges');
  return result(node(`${e.sql}.${end === 'start' ? edges.startId : edges.endId}`), 'json');
}

/** The properties of a tagged node or relationship: the object without its reserved keys. */
function taggedProperties(call: Call, json: string): string {
  return call.c.b.dialect.jsonRemoveKeys(json, [...RESERVED_KEYS]);
}

const isJson = (call: Call): boolean => call.args[0]!.type === 'json';

/** `body` of a JSON map, or of the properties of a node or relationship held in JSON. */
function entityOrMap(call: Call, body: (map: string) => string, shape: 'list' | 'map'): Expr {
  const arg = call.args[0]!;
  if (arg.type === 'null') {
    return NULL;
  }
  if (arg.type !== 'json' || arg.shape === 'list' || arg.shape === 'path') {
    throw typeError(
      'a map, node, or relationship',
      arg.shape ?? arg.type,
      call.node.args[0]!.position,
    );
  }
  const sql = call.c.share([arg], ([a]) =>
    arg.shape === 'map'
      ? body(a!.sql)
      : `(CASE WHEN ${a!.jsonType} = 'map' THEN ${body(a!.sql)} ` +
        `WHEN ${a!.jsonType} IN ('node', 'relationship') THEN ${body(taggedProperties(call, a!.sql))} ` +
        `WHEN ${isNullType(a!.jsonType)} THEN NULL ELSE ${argumentError(call, 'json')} END)`,
  );
  return result(sql, 'json', shape);
}

/** A column of an entity's table (`labels` only for nodes, `type` only for relationships). */
function column(call: Call, e: Expr, name: 'id' | 'labels' | 'properties' | 'type'): string {
  return call.c.b.entityColumn(e.sql, e.type === 'node' ? 'node' : 'relationship', name);
}

function math(name: string, arity: number): FunctionDef {
  return fn(arity, arity, (call) =>
    apply(call, Array<Kind>(arity).fill('float'), 'float', (v) => call.c.b.dialect.math(name, v)),
  );
}

function stringFunction(arity: number, sql: (values: string[]) => string): FunctionDef {
  return fn(arity, arity, (call) => apply(call, Array<Kind>(arity).fill('string'), 'string', sql));
}

function changeCase(to: 'upper' | 'lower'): FunctionDef {
  return fn(1, 1, (call) =>
    apply(call, ['string'], 'string', ([s]) => call.c.b.dialect.changeCase(s!, to)),
  );
}

// ---- the functions -----------------------------------------------------------------

const FUNCTIONS: Record<string, FunctionDef> = {
  // Entities
  id: fn(1, 1, (call) => {
    if (isJson(call)) {
      return tagged(call, ['node', 'relationship'], 'json', (j) => member(call, j, '~id'));
    }
    const e = entity(call, ['node', 'relationship']);
    return e ? result(column(call, e, 'id'), 'integer') : NULL;
  }),
  labels: fn(1, 1, (call) => {
    if (isJson(call)) {
      return tagged(call, ['node'], 'json', (j) => member(call, j, '~labels'), 'list');
    }
    const e = entity(call, ['node']);
    return e ? result(column(call, e, 'labels'), 'json', 'list') : NULL;
  }),
  startnode: fn(1, 1, (call) => endpoint(call, 'start')),
  endnode: fn(1, 1, (call) => endpoint(call, 'end')),
  type: fn(1, 1, (call) => {
    if (isJson(call)) {
      const d = call.c.b.dialect;
      return tagged(call, ['relationship'], 'string', (j) =>
        d.fromJson(member(call, j, '~type'), 'string'),
      );
    }
    const e = entity(call, ['relationship']);
    return e ? result(column(call, e, 'type'), 'string') : NULL;
  }),
  properties: fn(1, 1, (call) => {
    const arg = call.args[0]!;
    if (arg.type === 'node' || arg.type === 'relationship') {
      return result(column(call, arg, 'properties'), 'json', 'map');
    }
    return entityOrMap(call, (m) => m, 'map');
  }),
  keys: fn(1, 1, (call) => {
    const d = call.c.b.dialect;
    const arg = call.args[0]!;
    if (arg.type === 'node' || arg.type === 'relationship') {
      return result(d.jsonKeys(column(call, arg, 'properties')), 'json', 'list');
    }
    return entityOrMap(call, (m) => d.jsonKeys(m), 'list');
  }),

  // Paths
  nodes: fn(1, 1, (call) =>
    tagged(call, ['path'], 'json', (j) => member(call, j, '~nodes'), 'list'),
  ),
  relationships: fn(1, 1, (call) =>
    tagged(call, ['path'], 'json', (j) => member(call, j, '~relationships'), 'list'),
  ),
  length: fn(1, 1, (call) =>
    tagged(call, ['path'], 'integer', (j) =>
      call.c.b.dialect.listLength(member(call, j, '~relationships')),
    ),
  ),

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
      ([start, end, step]) => {
        const range = call.c.b.dialect.range(start!, end!, step ?? '1');
        if (step === undefined) {
          return range;
        }
        const zero = call.c.b.raise(
          {
            kind: 'argument',
            code: 'NumberOutOfRange',
            message: 'range() step must not be zero',
            position: call.node.position,
          },
          'json',
        );
        return `(CASE WHEN ${step} = 0 THEN ${zero} ELSE ${range} END)`;
      },
      'list',
      true,
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
  toupper: changeCase('upper'),
  upper: changeCase('upper'),
  tolower: changeCase('lower'),
  lower: changeCase('lower'),
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

// Temporal values: date(), localtime(), time(), localdatetime(), datetime(), and
// their .statement() / .transaction() / .realtime() and epoch forms.
for (const [name, { min, max }] of Object.entries(TEMPORAL_FUNCTIONS)) {
  FUNCTIONS[name] = fn(min, max, temporalFunction(name));
}

/** The first argument that is not null. */
function coalesce(call: Call): Expr {
  const { c } = call;
  const args = call.args.filter((a) => a.type !== 'null');
  if (args.length === 0) {
    return NULL;
  }
  const first = args[0]!;
  const entity = first.type === 'node' || first.type === 'relationship';
  if (first.type !== 'json' && !entity && args.every((a) => a.type === first.type)) {
    // SQLite's COALESCE needs at least two arguments.
    return args.length === 1
      ? first
      : result(`COALESCE(${args.map((a) => a.sql).join(', ')})`, first.type);
  }
  // Nodes and relationships as their tagged objects (null when they are null).
  const jsons = args.map((a) => c.asJson(a));
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
    integer: (i) => d.integerText(i),
    float: (f) => d.floatToString(f),
    boolean: (b) => `(CASE WHEN ${b} THEN 'true' WHEN NOT ${b} THEN 'false' END)`,
    temporal: (j) => temporalText(call, j),
  });
}

/** The text of a temporal value's JSON (its `~s` member). */
function temporalText(call: Call, json: string): string {
  const d = call.c.b.dialect;
  return d.fromJson(
    d.jsonMember(json, call.c.b.bind({ kind: 'sql', value: '~s' }), '~s'),
    'string',
  );
}

/**
 * A temporal function: evaluated when the step is bound if its arguments are
 * known before the query runs, otherwise in SQL (`Dialect.temporalCall`).
 */
function temporalFunction(name: string): FunctionImpl {
  return (call) => {
    const { c, node } = call;
    const d = c.b.dialect;
    if (node.args.every(isKnownBeforeRun)) {
      return result(d.jsonInput(c.b.bind({ kind: 'temporal', expression: node })), 'json');
    }
    if (!d.temporalCall) {
      throw new UnsupportedFeatureError(
        `${node.name}() of values from the query is not supported on ${d.name}${d.name === 'sqlite' ? ' without its functions' : ' yet'}`,
        {
          position: node.position,
          hint:
            d.name === 'sqlite'
              ? 'Register them with registerSqliteFunctions(db) and use sqlite({ functions: true }).'
              : 'Use literals or parameters as its arguments.',
        },
      );
    }
    const args = call.args.map((a) => c.asJson(a).sql);
    return result(d.temporalCall(name, d.jsonArray(args)), 'json');
  };
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
