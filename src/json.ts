// JSON encoding of Cypher property values, as stored in the `properties` and
// `labels` columns. Integers and floats must survive a round trip as different
// types, so integers are written without a decimal point (`1`) and floats always
// with one (`1.0`), and parsing turns integer literals back into `bigint`.

import { ENTITY_TAG } from './dialect/dialect.js';
import { SemanticError } from './errors.js';
import {
  isTemporalKind,
  parseTemporal,
  renderTemporal,
  sortKey,
  temporalComponents,
  type Temporal,
} from './temporal.js';
import { CypherTemporal, isCypherMap, type CypherValue } from './values.js';

// `JSON.rawJSON` and the reviver's `source` context (ES2025, Node 21+) are not in
// TypeScript's lib yet.
declare global {
  interface JSON {
    rawJSON(text: string): unknown;
  }
}

interface ReviverContext {
  source?: string;
}

const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;

/**
 * Parses JSON text, returning integer literals as `bigint` and other numbers as
 * `number`. An integer literal outside the 64-bit range is a float: PostgreSQL
 * `jsonb` prints large floats such as `1e308` as plain digits, and Cypher
 * integers are always 64-bit.
 */
export function parseCypherJson(text: string): CypherValue {
  return JSON.parse(text, function (_key, value: unknown, context?: ReviverContext): unknown {
    if (typeof value === 'number' && context?.source !== undefined) {
      if (!/^-?\d+$/.test(context.source)) {
        return value;
      }
      const int = BigInt(context.source);
      return int < MIN_INT64 || int > MAX_INT64 ? value : int;
    }
    // A temporal value's tagged object (see temporalJson).
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const tag = (value as Record<string, unknown>)[ENTITY_TAG];
      if (isTemporalKind(tag)) {
        return new CypherTemporal(tag, String((value as Record<string, unknown>)['~s']));
      }
    }
    return value;
  }) as CypherValue;
}

/**
 * The JSON object of a temporal value in SQL: its kind as the tag, its text
 * (`~s`), its sort key (`~k`), and its components (`year`, `hour`, ...), so that
 * `d.year` is a member lookup and comparisons compare `~k`.
 */
export function temporalJson(t: Temporal): Record<string, unknown> {
  const out: Record<string, unknown> = {
    [ENTITY_TAG]: t.kind,
    '~s': renderTemporal(t),
    '~k': sortKey(t),
  };
  for (const [key, v] of Object.entries(temporalComponents(t))) {
    out[key] = typeof v === 'bigint' ? JSON.rawJSON(v.toString()) : v;
  }
  return out;
}

/** Serializes a Cypher property value (scalars, lists, and maps of those) to JSON text. */
export function stringifyCypherJson(value: CypherValue): string {
  return JSON.stringify(toJsonable(value));
}

function toJsonable(value: CypherValue): unknown {
  if (typeof value === 'bigint') {
    return JSON.rawJSON(value.toString());
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot store ${value} as a property value`);
    }
    // An integral float keeps a fraction. toFixed() writes 1e21 and above in
    // exponent form, which PostgreSQL's jsonb would store as an integer; the
    // value is an exact integer, so write all its digits.
    return Number.isInteger(value) ? JSON.rawJSON(`${BigInt(value)}.0`) : value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonable);
  }
  if (value instanceof CypherTemporal) {
    return temporalJson(parseTemporal(value.kind, value.text));
  }
  if (value !== null && typeof value === 'object') {
    if (!isCypherMap(value)) {
      throw new TypeError('Nodes, relationships, and paths cannot be stored as property values');
    }
    if (Object.hasOwn(value, ENTITY_TAG)) {
      throw new SemanticError(`The map key ${JSON.stringify(ENTITY_TAG)} is reserved`);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toJsonable(v);
    }
    return out;
  }
  return value;
}
