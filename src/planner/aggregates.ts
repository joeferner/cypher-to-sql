import type * as ast from '../ast.js';
import { SemanticError, UnsupportedFeatureError } from '../errors.js';
import { orderTerm, typeError, type Expr, type ExprCompiler } from './expr.js';
import { children } from './walk.js';

// Aggregate functions. They skip null values, as in Cypher, and are compiled
// to SQL aggregates over the groups of the RETURN's grouping keys.

const SUPPORTED = new Set([
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'collect',
  'percentilecont',
  'percentiledisc',
]);
const UNSUPPORTED = new Set(['stdev', 'stdevp']);

export function isAggregateCall(call: ast.FunctionCall): boolean {
  const name = call.name.toLowerCase();
  return SUPPORTED.has(name) || UNSUPPORTED.has(name);
}

/** True when the expression contains an aggregate (`count(*)`, `sum(x)`, ...). */
export function containsAggregate(expr: ast.Expression): boolean {
  switch (expr.type) {
    case 'CountStar':
      return true;
    case 'FunctionCall':
      return isAggregateCall(expr) || expr.args.some(containsAggregate);
    default:
      return children(expr).some(({ child }) => containsAggregate(child));
  }
}

/** True when the expression calls rand(), whose value is not fixed within a group. */
function callsRand(expr: ast.Expression): boolean {
  return JSON.stringify(expr, (_k, v: unknown) => (typeof v === 'bigint' ? 0 : v))
    .toLowerCase()
    .includes('"name":"rand"');
}

export function compileAggregate(c: ExprCompiler, node: ast.FunctionCall | ast.CountStar): Expr {
  const name = node.type === 'CountStar' ? 'count(*)' : `${node.name}()`;
  if (c.aggregation === 'none') {
    throw new SemanticError(`Aggregate function ${name} is not allowed here`, {
      position: node.position,
      hint: 'Aggregates can be used in RETURN (and its ORDER BY).',
    });
  }
  if (c.aggregation === 'inside') {
    throw new SemanticError(`Aggregate function ${name} cannot be nested in another aggregate`, {
      position: node.position,
    });
  }
  if (node.type === 'CountStar') {
    return result('COUNT(*)', 'integer');
  }
  const fn = node.name.toLowerCase();
  if (UNSUPPORTED.has(fn)) {
    throw new UnsupportedFeatureError(`Aggregate function ${node.name}() is not supported yet`, {
      position: node.position,
    });
  }
  const arity = fn.startsWith('percentile') ? 2 : 1;
  if (node.args.length !== arity) {
    throw new SemanticError(
      `Function ${node.name}() takes ${arity} argument${arity === 1 ? '' : 's'}, got ${node.args.length}`,
      { position: node.position },
    );
  }
  if (callsRand(node.args[0]!)) {
    throw new SemanticError(`The argument of ${node.name}() must not call rand()`, {
      position: node.position,
    });
  }
  const path = c.relationshipList(node.args[0]!);
  if (path !== undefined && fn === 'count') {
    // The relationships of a variable-length match: counted when matched.
    return result(`COUNT(${node.distinct ? 'DISTINCT ' : ''}${path})`, 'integer');
  }
  c.aggregation = 'inside';
  let arg: Expr;
  let percentile: Expr | undefined;
  try {
    arg = c.compile(node.args[0]!);
    // The percentile is per group (it may use the grouping keys), not aggregated.
    percentile = node.args[1] ? c.compile(node.args[1]) : undefined;
  } finally {
    c.aggregation = 'allowed';
  }
  const aggregate = { c, node, arg, distinct: node.distinct ? 'DISTINCT ' : '' };
  switch (fn) {
    case 'percentiledisc':
    case 'percentilecont':
      return percentileOf(aggregate, percentile!, fn === 'percentilecont');
    case 'count':
      return count(aggregate);
    case 'sum':
      return sum(aggregate);
    case 'avg':
      return avg(aggregate);
    case 'min':
    case 'max':
      return minMax(aggregate, fn);
    default:
      return collect(aggregate);
  }
}

interface Aggregate {
  c: ExprCompiler;
  node: ast.FunctionCall;
  arg: Expr;
  /** `'DISTINCT '` or `''` */
  distinct: string;
}

const NUMBER_TYPES = `('integer', 'float')`;

function result(sql: string, type: Expr['type'], shape?: 'list'): Expr {
  return { sql, type, atomic: false, shape };
}

function count({ c, arg, distinct }: Aggregate): Expr {
  const d = c.b.dialect;
  switch (arg.type) {
    case 'null':
      return result('COUNT(NULL)', 'integer');
    case 'node':
    case 'relationship': {
      const table = c.b.mapping[arg.type === 'node' ? 'nodes' : 'edges'];
      return result(`COUNT(${distinct}${arg.sql}.${c.b.ident(table.id)})`, 'integer');
    }
    case 'json': {
      // JSON null counts as null. DISTINCT compares JSON text, so 1 and 1.0 differ.
      const value = distinct ? d.jsonText(arg.sql) : '1';
      return result(
        `COUNT(${distinct}CASE WHEN NOT ${d.jsonIsNull(arg.sql)} THEN ${value} END)`,
        'integer',
      );
    }
    default:
      return result(`COUNT(${distinct}${arg.sql})`, 'integer');
  }
}

/** Integers sum to an integer, any float makes a float; no values sum to 0. */
function sum({ c, node, arg, distinct }: Aggregate): Expr {
  const d = c.b.dialect;
  switch (arg.type) {
    case 'null':
      return result('0', 'integer');
    case 'integer':
    case 'float':
      return result(`COALESCE(SUM(${distinct}${arg.sql}), 0)`, arg.type);
    case 'json': {
      const t = d.jsonType(arg.sql);
      const floats = `SUM(${distinct}CASE WHEN ${t} IN ${NUMBER_TYPES} THEN ${d.toFloat(d.fromJson(arg.sql, 'number'))} END)`;
      const ints = `COALESCE(SUM(${distinct}CASE WHEN ${t} = 'integer' THEN ${d.fromJson(arg.sql, 'integer')} END), 0)`;
      return result(
        `(CASE WHEN SUM(CASE WHEN ${t} = 'float' THEN 1 ELSE 0 END) > 0 ` +
          `THEN ${d.toJson(floats, 'float')} ELSE ${d.toJson(ints, 'integer')} END)`,
        'json',
      );
    }
    default:
      throw typeError('a number', arg.shape ?? arg.type, node.args[0]!.position);
  }
}

/** Always a float; null when there are no values. */
function avg({ c, node, arg, distinct }: Aggregate): Expr {
  const d = c.b.dialect;
  switch (arg.type) {
    case 'null':
      return result('NULL', 'null');
    case 'integer':
    case 'float':
      return result(d.toFloat(`AVG(${distinct}${arg.sql})`), 'float');
    case 'json': {
      const t = d.jsonType(arg.sql);
      return result(
        `AVG(${distinct}CASE WHEN ${t} IN ${NUMBER_TYPES} THEN ${d.toFloat(d.fromJson(arg.sql, 'number'))} END)`,
        'float',
      );
    }
    default:
      throw typeError('a number', arg.shape ?? arg.type, node.args[0]!.position);
  }
}

/**
 * The smallest or largest value. For JSON values of different types this uses
 * Cypher's order across types (the same as ORDER BY).
 */
function minMax({ c, node, arg }: Aggregate, fn: 'min' | 'max'): Expr {
  const d = c.b.dialect;
  const agg = fn.toUpperCase();
  switch (arg.type) {
    case 'null':
      return result('NULL', 'null');
    case 'integer':
    case 'float':
      return result(`${agg}(${arg.sql})`, arg.type);
    case 'string':
      return result(`${agg}(${d.orderString(arg.sql)})`, 'string');
    case 'boolean':
      return result(d.booleanAggregate(fn, arg.sql), 'boolean');
    case 'json': {
      const orderBy = c.sortKeys(arg).map((key) => orderTerm(key.sql, key, fn === 'max'));
      const list = d.jsonAggregate(arg.sql, {
        distinct: false,
        orderBy,
        filter: `NOT ${d.jsonIsNull(arg.sql)}`,
      });
      return result(d.jsonElement(list, '0'), 'json');
    }
    default:
      throw new UnsupportedFeatureError(
        `${node.name}() of nodes or relationships is not supported yet`,
        {
          position: node.position,
        },
      );
  }
}

/**
 * `percentileDisc(x, p)` and `percentileCont(x, p)` over the group's numbers
 * (other values are skipped, as in sum()), sorted into a JSON list of `n`
 * values, with Neo4j's rules:
 *
 * - disc: the value at index `max(ceil(p * n) - 1, 0)`, of its own type.
 * - cont: a float between the values at `floor(p * (n - 1))` and `ceil(...)`,
 *   interpolated linearly.
 *
 * Null when there are no values or `p` is null; `p` outside 0.0 to 1.0 raises
 * ArgumentError (NumberOutOfRange) when the query runs.
 */
function percentileOf(
  { c, node, arg, distinct }: Aggregate,
  percentile: Expr,
  continuous: boolean,
): Expr {
  const d = c.b.dialect;
  if (arg.type === 'null' || percentile.type === 'null') {
    return result('NULL', 'null');
  }
  if (arg.type !== 'integer' && arg.type !== 'float' && arg.type !== 'json') {
    throw typeError('a number', arg.shape ?? arg.type, node.args[0]!.position);
  }
  const resultType = continuous ? 'float' : arg.type;
  const notNumber = (): string =>
    c.b.typeError(
      `Type mismatch: the percentile of ${node.name}() must be a number`,
      node.args[1]!.position,
      'float',
    );
  let p: string;
  if (percentile.type === 'integer' || percentile.type === 'float') {
    p = d.toFloat(percentile.sql);
  } else if (percentile.type === 'json') {
    const t = d.jsonType(percentile.sql);
    p =
      `(CASE WHEN ${d.jsonIsNull(percentile.sql)} THEN NULL WHEN ${t} IN ${NUMBER_TYPES} ` +
      `THEN ${d.toFloat(d.fromJson(percentile.sql, 'number'))} ELSE ${notNumber()} END)`;
  } else {
    throw typeError('a number', percentile.shape ?? percentile.type, node.args[1]!.position);
  }

  // The numbers in ascending order, as a JSON list.
  const number = arg.type === 'json' ? d.toFloat(d.fromJson(arg.sql, 'number')) : arg.sql;
  const list = d.jsonAggregate(arg.type === 'json' ? arg.sql : d.toJson(arg.sql, arg.type), {
    distinct: distinct !== '',
    orderBy: [`${number} ASC`],
    filter:
      arg.type === 'json' ? `${d.jsonType(arg.sql)} IN ${NUMBER_TYPES}` : `${arg.sql} IS NOT NULL`,
  });
  const n = d.listLength(list);
  const at = (index: string): string => d.jsonElement(list, index);
  let value: string;
  if (continuous) {
    const f = `(${p} * (${n} - 1))`;
    const lo = d.truncate(d.math('floor', [f]));
    const hi = d.truncate(d.math('ceil', [f]));
    const v = (index: string): string => d.toFloat(d.fromJson(at(index), 'number'));
    value =
      `(CASE WHEN ${lo} = ${hi} THEN ${v(lo)} ` +
      `ELSE ${v(lo)} * (${hi} - ${f}) + ${v(hi)} * (${f} - ${lo}) END)`;
  } else {
    const ceil = d.truncate(d.math('ceil', [`${p} * ${n}`]));
    const element = at(`(CASE WHEN ${ceil} < 1 THEN 0 ELSE ${ceil} - 1 END)`);
    value = arg.type === 'json' ? element : d.fromJson(element, arg.type);
  }
  const outOfRange = c.b.raise(
    {
      kind: 'argument',
      code: 'NumberOutOfRange',
      message: `The percentile of ${node.name}() must be between 0.0 and 1.0`,
      position: node.args[1]!.position,
    },
    resultType,
  );
  return result(
    `(CASE WHEN ${p} IS NULL THEN NULL WHEN ${p} < 0 OR ${p} > 1 THEN ${outOfRange} ` +
      `WHEN COALESCE(${n}, 0) = 0 THEN NULL ELSE ${value} END)`,
    resultType,
  );
}

/** A list of the non-null values (in no particular order). */
function collect({ c, arg, distinct }: Aggregate): Expr {
  const d = c.b.dialect;
  switch (arg.type) {
    case 'null':
      return result(d.jsonArray([]), 'json', 'list');
    case 'node':
    case 'relationship': {
      // As tagged objects; a null entity (OPTIONAL MATCH) is skipped.
      const table = c.b.mapping[arg.type === 'node' ? 'nodes' : 'edges'];
      return result(
        d.jsonAggregate(
          c.b.dialect.entityJson(
            arg.type,
            arg.sql,
            c.b.columns(arg.type === 'node' ? 'nodes' : 'edges'),
          ),
          {
            distinct: distinct !== '',
            orderBy: [],
            filter: `${arg.sql}.${c.b.ident(table.id)} IS NOT NULL`,
          },
        ),
        'json',
        'list',
      );
    }
    case 'json':
      return result(
        d.jsonAggregate(arg.sql, {
          distinct: distinct !== '',
          orderBy: [],
          filter: `NOT ${d.jsonIsNull(arg.sql)}`,
        }),
        'json',
        'list',
      );
    default:
      return result(
        d.jsonAggregate(d.toJson(arg.sql, arg.type), {
          distinct: distinct !== '',
          orderBy: [],
          filter: `${arg.sql} IS NOT NULL`,
        }),
        'json',
        'list',
      );
  }
}
