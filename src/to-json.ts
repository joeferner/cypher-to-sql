// Plain JSON from query results, for logs, HTTP responses, and LLM prompts.

import {
  CypherDuration,
  CypherNode,
  CypherPath,
  CypherRelationship,
  CypherTemporal,
  type CypherValue,
} from './values.js';

/** A value `JSON.stringify` writes as is. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ToJsonOptions {
  /**
   * How integers (`bigint`) are written:
   * - `'number-if-safe'` (default): a number when it fits in JavaScript's safe
   *   range (up to 2^53), otherwise a string, so no precision is lost silently.
   * - `'string'`: always a string, for consumers that need one type.
   * - `'number'`: always a number; integers beyond 2^53 are rounded.
   */
  integers?: 'number-if-safe' | 'string' | 'number';
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * `value` (a Cypher value, or the records `graph.query()` returns) as plain
 * JSON:
 *
 * - integers as numbers or strings (see `ToJsonOptions.integers`); floats as
 *   numbers, and NaN and the infinities as the strings `"NaN"`, `"Infinity"`,
 *   and `"-Infinity"`
 * - a node as `{ "~id": "1", "~labels": ["P"], ...properties }`
 * - a relationship as `{ "~id": "5", "~type": "KNOWS", "~start": "1", "~end": "2", ...properties }`
 * - a path as `{ "~nodes": [...], "~relationships": [...] }`
 * - temporal values and durations as their Cypher text (`"2024-03-01"`, `"P1D"`)
 *
 * The `~` keys are reserved property keys (`RESERVED_KEYS`), so they cannot
 * clash with properties. Ids are strings, as in `CypherNode.id`.
 */
export function toJson(value: CypherValue, options: ToJsonOptions = {}): JsonValue {
  return convert(value, options.integers ?? 'number-if-safe');
}

function convert(value: CypherValue, integers: NonNullable<ToJsonOptions['integers']>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'bigint') {
    if (integers === 'string') {
      return value.toString();
    }
    if (integers === 'number' || (value <= MAX_SAFE && value >= -MAX_SAFE)) {
      return Number(value);
    }
    return value.toString();
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => convert(v, integers));
  }
  if (value instanceof CypherTemporal || value instanceof CypherDuration) {
    return value.text;
  }
  if (value instanceof CypherNode) {
    return { '~id': value.id, '~labels': [...value.labels], ...map(value.properties, integers) };
  }
  if (value instanceof CypherRelationship) {
    return {
      '~id': value.id,
      '~type': value.type,
      '~start': value.startNodeId,
      '~end': value.endNodeId,
      ...map(value.properties, integers),
    };
  }
  if (value instanceof CypherPath) {
    return {
      '~nodes': value.nodes.map((n) => convert(n, integers)),
      '~relationships': value.relationships.map((r) => convert(r, integers)),
    };
  }
  return map(value, integers);
}

function map(
  value: { [key: string]: CypherValue },
  integers: NonNullable<ToJsonOptions['integers']>,
): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = convert(v, integers);
  }
  return out;
}
