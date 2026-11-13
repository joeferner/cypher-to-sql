// Temporal functions (date(), datetime.fromepoch(), ...) evaluated in
// TypeScript, on Cypher values: when a step is bound (all arguments known
// before the query runs) and in SQLite's cypher_temporal() function.

import type * as ast from './ast.js';
import type { SourcePosition } from './errors.js';
import {
  fromEpoch,
  isTemporalKind,
  nowUtc,
  parseTemporal,
  project,
  renderTemporal,
  temporalFromMap,
  TemporalError,
  truncateTemporal,
  type Temporal,
  type TemporalArgument,
} from './temporal.js';
import { CypherTemporal, isCypherMap, type CypherValue } from './values.js';

/** The temporal functions, by lower-case name, with their argument counts. */
export const TEMPORAL_FUNCTIONS: Record<string, { min: number; max: number }> = {
  'datetime.fromepoch': { min: 2, max: 2 },
  'datetime.fromepochmillis': { min: 1, max: 1 },
};
for (const kind of ['date', 'localtime', 'time', 'localdatetime', 'datetime']) {
  TEMPORAL_FUNCTIONS[kind] = { min: 0, max: 1 };
  for (const clock of ['statement', 'transaction', 'realtime']) {
    TEMPORAL_FUNCTIONS[`${kind}.${clock}`] = { min: 0, max: 1 };
  }
  TEMPORAL_FUNCTIONS[`${kind}.truncate`] = { min: 2, max: 3 };
}

/** A map argument as temporal map fields (temporal values parsed). */
function fields(arg: CypherValue): Record<string, TemporalArgument> {
  if (!isCypherMap(arg)) {
    throw new TemporalError('Expected a map');
  }
  const map: Record<string, TemporalArgument> = {};
  for (const [key, v] of Object.entries(arg)) {
    if (v instanceof CypherTemporal) {
      map[key] = temporalOf(v);
    } else if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'bigint'
    ) {
      map[key] = v;
    } else {
      throw new TemporalError(`Invalid value for ${key}`);
    }
  }
  return map;
}

export function isTemporalFunction(name: string): boolean {
  return Object.hasOwn(TEMPORAL_FUNCTIONS, name.toLowerCase());
}

const value = (t: Temporal): CypherTemporal => new CypherTemporal(t.kind, renderTemporal(t));
const temporalOf = (v: CypherTemporal): Temporal => parseTemporal(v.kind, v.text);

function integer(v: CypherValue | undefined, what: string): bigint {
  if (typeof v === 'bigint') {
    return v;
  }
  if (typeof v === 'number' && Number.isInteger(v)) {
    return BigInt(v);
  }
  throw new TemporalError(`Invalid value for ${what}`);
}

/**
 * Calls temporal function `name` (lower case) on its arguments. Throws a
 * `TemporalError` for an invalid argument.
 */
export function callTemporal(name: string, args: CypherValue[]): CypherValue {
  if (name === 'datetime.fromepoch') {
    if (args[0] === null || args[1] === null) {
      return null;
    }
    return value(fromEpoch(integer(args[0], 'seconds'), integer(args[1], 'nanoseconds')));
  }
  if (name === 'datetime.fromepochmillis') {
    if (args[0] === null) {
      return null;
    }
    const millis = integer(args[0], 'milliseconds');
    const seconds = millis / 1000n - (millis % 1000n < 0n ? 1n : 0n);
    return value(fromEpoch(seconds, (millis - seconds * 1000n) * 1_000_000n));
  }
  const [kind, clock] = name.split('.');
  if (!isTemporalKind(kind)) {
    throw new TemporalError(`Unknown temporal function ${name}`);
  }
  const arg = args[0];
  if (clock === 'truncate') {
    const input = args[1];
    if (arg === null || input === null || input === undefined) {
      return null;
    }
    if (typeof arg !== 'string' || !(input instanceof CypherTemporal)) {
      throw new TemporalError(`Invalid argument for ${name}()`);
    }
    const overrides = args[2] === undefined || args[2] === null ? {} : fields(args[2]);
    return value(truncateTemporal(kind, arg, temporalOf(input), overrides, nowUtc));
  }
  if (arg === undefined || clock !== undefined) {
    // The current time, in UTC or in the given zone.
    if (arg === null) {
      return null;
    }
    if (arg === undefined) {
      return value(project(kind, nowUtc()));
    }
    if (typeof arg !== 'string') {
      throw new TemporalError('A time zone must be a string');
    }
    return value(temporalFromMap(kind, { timezone: arg }, nowUtc));
  }
  if (arg === null) {
    return null;
  }
  if (typeof arg === 'string') {
    return value(parseTemporal(kind, arg));
  }
  if (arg instanceof CypherTemporal) {
    return value(project(kind, temporalOf(arg)));
  }
  if (isCypherMap(arg)) {
    const map: Record<string, TemporalArgument> = {};
    for (const [key, v] of Object.entries(arg)) {
      if (v instanceof CypherTemporal) {
        map[key] = temporalOf(v);
      } else if (
        v === null ||
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'bigint'
      ) {
        map[key] = v;
      } else {
        throw new TemporalError(`Invalid value for ${key}`);
      }
    }
    return value(temporalFromMap(kind, map, nowUtc));
  }
  throw new TemporalError(`Invalid argument for ${name}()`);
}

/**
 * True when `expr` is known before the query runs: literals, parameters, lists
 * and maps of them, and temporal functions of them. Such a temporal call is
 * evaluated when its step is bound.
 */
export function isKnownBeforeRun(expr: ast.Expression): boolean {
  switch (expr.type) {
    case 'Literal':
    case 'Parameter':
      return true;
    case 'List':
      return expr.items.every(isKnownBeforeRun);
    case 'Map':
      return expr.entries.every((e) => isKnownBeforeRun(e.value));
    case 'FunctionCall':
      return isTemporalFunction(expr.name) && expr.args.every(isKnownBeforeRun);
    default:
      return false;
  }
}

/** Evaluates an expression for which `isKnownBeforeRun` holds. */
export function evaluateKnown(
  expr: ast.Expression,
  parameter: (name: string, position: SourcePosition) => CypherValue,
): CypherValue {
  switch (expr.type) {
    case 'Literal':
      return expr.value;
    case 'Parameter':
      return parameter(expr.name, expr.position);
    case 'List':
      return expr.items.map((item) => evaluateKnown(item, parameter));
    case 'Map':
      return Object.fromEntries(
        expr.entries.map((e) => [e.key, evaluateKnown(e.value, parameter)]),
      );
    case 'FunctionCall':
      return callTemporal(
        expr.name.toLowerCase(),
        expr.args.map((arg) => evaluateKnown(arg, parameter)),
      );
    default:
      throw new Error(`Internal error: ${expr.type} is not known before the query runs`);
  }
}
