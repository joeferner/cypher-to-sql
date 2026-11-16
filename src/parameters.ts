// Values that come from the caller's JavaScript: query parameters and the rows
// of registered procedures.

import { CypherArgumentError, CypherTypeError, type SourcePosition } from './errors.js';
import { parseDuration } from './duration.js';
import { parseTemporal, TemporalError } from './temporal.js';
import {
  CypherDuration,
  CypherNode,
  CypherPath,
  CypherRelationship,
  CypherTemporal,
  type CypherMap,
  type CypherValue,
} from './values.js';

/** The checked value of each parameter, per params object (it may be read once per row). */
const checked = new WeakMap<object, Map<string, CypherValue>>();

/**
 * The value of the parameter `name` as the query reads it, checked by
 * `checkValue`.
 */
export function parameterValue(
  params: Record<string, CypherValue>,
  name: string,
  position: SourcePosition | undefined,
): CypherValue {
  let values = checked.get(params);
  if (!values) {
    values = new Map();
    checked.set(params, values);
  }
  if (values.has(name)) {
    return values.get(name)!;
  }
  const value = checkValue(params[name], (path) => `Parameter $${name}${path}`, position);
  values.set(name, value);
  return value;
}

/**
 * `value` as a Cypher value: null, a boolean, an integer (bigint), a finite
 * number, a string, a temporal value or duration with valid text, or a list
 * or plain object of those. `undefined` is null anywhere in it. Anything else
 * (a Date, a function, a node, NaN) is an error, rather than a value silently
 * changed or a driver error. `subject` names the value in the message, given
 * the path inside it (`[0].a`).
 */
export function checkValue(
  value: unknown,
  subject: (path: string) => string,
  position: SourcePosition | undefined,
  path = '',
): CypherValue {
  if (value === undefined || value === null) {
    return null;
  }
  switch (typeof value) {
    case 'boolean':
    case 'bigint':
    case 'string':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CypherArgumentError(`${subject(path)} is ${value}, which cannot be passed`, {
          code: 'InvalidArgumentValue',
          position,
          hint: 'Values reach the database as JSON, which has no NaN or infinity. Use null instead.',
        });
      }
      return value;
    case 'object':
      break;
    default:
      throw unsupported(subject(path), typeof value, position);
  }
  if (Array.isArray(value)) {
    return value.map((v: unknown, i) => checkValue(v, subject, position, `${path}[${i}]`));
  }
  if (value instanceof CypherTemporal || value instanceof CypherDuration) {
    try {
      if (value instanceof CypherTemporal) {
        parseTemporal(value.kind, value.text);
      } else {
        parseDuration(value.text);
      }
    } catch (error) {
      if (error instanceof TemporalError) {
        throw new CypherArgumentError(`${subject(path)}: ${error.message}`, {
          code: 'InvalidArgumentValue',
          position,
        });
      }
      throw error;
    }
    return value;
  }
  if (
    value instanceof CypherNode ||
    value instanceof CypherRelationship ||
    value instanceof CypherPath
  ) {
    throw new CypherTypeError(
      `${subject(path)} is a ${value.constructor.name}, which cannot be passed`,
      {
        code: 'InvalidArgumentType',
        position,
        hint: 'Pass its id or properties instead, and match it in the query.',
      },
    );
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    const type = (value as { constructor?: { name?: string } }).constructor?.name ?? 'object';
    throw unsupported(subject(path), type, position);
  }
  const map: CypherMap = {};
  for (const [key, v] of Object.entries(value)) {
    map[key] = checkValue(v, subject, position, `${path}.${key}`);
  }
  return map;
}

function unsupported(
  subject: string,
  type: string,
  position: SourcePosition | undefined,
): CypherTypeError {
  return new CypherTypeError(`${subject} has a type Cypher does not have (${type})`, {
    code: 'InvalidArgumentType',
    position,
    hint:
      'Use null, booleans, numbers, bigints, strings, arrays, plain objects, CypherTemporal, or CypherDuration. ' +
      "For a Date, new CypherTemporal('datetime', date.toISOString()).",
  });
}
